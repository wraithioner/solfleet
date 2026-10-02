/** Public manual-trade flows using offline builders, balances and confirmations. */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import bs58 from 'bs58';
import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import type { Context } from 'grammy';
import type { WalletRecord } from '../src/types.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'solfleet-manual-trades-'));
Object.assign(process.env, {
  BOT_TOKEN: '123:OFFLINE_TEST',
  OWNER_IDS: '1',
  DATA_DIR: dataDir,
  VAULT_AUTOLOCK_MINUTES: '0',
  REQUIRE_CONFIRMATION: 'true',
  JUPITER_REQUEST_INTERVAL_MS: '0',
  SOLANA_RPC_URL: 'http://127.0.0.1:8899',
  SOLANA_SEND_RPC_URL: 'http://127.0.0.1:8899',
});

const { db } = await import('../src/store/db.js');
const vault = await import('../src/store/vault.js');
const wallets = await import('../src/store/wallets.js');
const { rpc } = await import('../src/chains/solana.js');
const { promptBuy, promptSell } = await import('../src/bot/handlers/trade.js');
const { session, takeConfirmation } = await import('../src/bot/session.js');
const { entryPrice } = await import('../src/services/pnl.js');
const client = rpc();
const originals = {
  getAccountInfo: client.getAccountInfo,
  getMultipleAccountsInfo: client.getMultipleAccountsInfo,
  getParsedTokenAccountsByOwner: client.getParsedTokenAccountsByOwner,
  getTokenSupply: client.getTokenSupply,
  getTokenLargestAccounts: client.getTokenLargestAccounts,
  getSignatureStatuses: client.getSignatureStatuses,
  sendRawTransaction: client.sendRawTransaction,
};
const originalFetch = globalThis.fetch;
let passed = 0;
const check = (name: string) => {
  passed++;
  console.log(`  ✓ ${name}`);
};
const approx = (actual: number | undefined | null, expected: number) => {
  assert.ok(
    actual !== undefined && actual !== null && Math.abs(actual - expected) < 1e-12,
    `${actual} != ${expected}`,
  );
};

interface Scenario {
  mint: string;
  decimals: number;
  wallets: WalletRecord[];
  tokenRaw: Map<string, bigint>;
  lamports: Map<string, number>;
  unresolved: Set<string>;
  boughtRaw: bigint;
  soldRaw: bigint;
  buyCostLamports: number;
  sellProceedsLamports: number;
  builds: number;
  sends: number;
}

let scenario: Scenario;
let sequence = 0;
function prepare(walletCount = 1): Scenario {
  const group = `manual-${++sequence}`;
  const selected = Array.from({ length: walletCount }, (_, i) => {
    const value = wallets.generateSolanaWallet(`${group}-${i}`);
    wallets.addToGroup(value.id, group);
    return value;
  });
  db.updateSettings({
    activeGroup: group,
    executionMode: 'parallel',
    priorityFeeMode: 'fixed',
    priorityFeeSol: 0.00005,
  });
  session(1).confirmations.clear();
  scenario = {
    mint: PublicKey.unique().toBase58(),
    decimals: 9,
    wallets: selected,
    tokenRaw: new Map(),
    lamports: new Map(selected.map(w => [w.address, 1_000_000_000])),
    unresolved: new Set(),
    boughtRaw: 100_000_000_000n,
    soldRaw: 75_000_000_000n,
    buyCostLamports: 52_044_280,
    sellProceedsLamports: 112_500_000,
    builds: 0,
    sends: 0,
  };
  return scenario;
}

function context() {
  const messages: string[] = [];
  const ctx = {
    from: { id: 1 },
    reply: async (text: string) => {
      messages.push(text);
      return {};
    },
    answerCallbackQuery: async () => true,
  } as unknown as Context;
  return { ctx, messages };
}

async function confirm(action: 'buy' | 'sell', amount: number) {
  const capture = context();
  if (action === 'buy') await promptBuy(capture.ctx, scenario.mint, amount);
  else await promptSell(capture.ctx, scenario.mint, amount);
  assert.equal(scenario.builds, 0, 'a prompt must not build or sign a trade');
  assert.equal(scenario.sends, 0, 'a prompt must not submit a trade');
  assert.equal(session(1).confirmations.size, 1);
  const id = [...session(1).confirmations.keys()][0]!;
  const confirmation = takeConfirmation(1, id);
  assert.ok(confirmation, 'the public prompt must stage a usable confirmation');
  await confirmation.run(capture.ctx);
  assert.equal(
    takeConfirmation(1, id),
    undefined,
    'a consumed confirmation cannot repeat the trade',
  );
  return capture.messages.join('\n');
}

function builtTrade(address: string, action: 'buy' | 'sell'): VersionedTransaction {
  const swap = new TransactionInstruction({
    programId: new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'),
    keys: [
      { pubkey: new PublicKey(address), isSigner: true, isWritable: true },
      { pubkey: new PublicKey(scenario.mint), isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([
      crypto.createHash('sha256').update(`global:${action}`).digest().subarray(0, 8),
      Buffer.alloc(16),
    ]),
  });
  return new VersionedTransaction(
    new TransactionMessage({
      payerKey: new PublicKey(address),
      recentBlockhash: PublicKey.unique().toBase58(),
      instructions: [swap],
    }).compileToV0Message(),
  );
}

try {
  vault.initVaultWithKeyfile();
  client.getAccountInfo = async key => {
    if (key.toBase58() !== scenario.mint) return null;
    const data = Buffer.alloc(82);
    data.writeBigUInt64LE(1_000_000_000_000n, 36);
    data[44] = scenario.decimals;
    data[45] = 1;
    return { owner: TOKEN_PROGRAM_ID, data, lamports: 1, executable: false, rentEpoch: 0 };
  };
  client.getMultipleAccountsInfo = async keys =>
    keys.map(key => ({
      owner: SystemProgram.programId,
      data: Buffer.alloc(0),
      lamports: scenario.lamports.get(key.toBase58()) ?? 0,
      executable: false,
      rentEpoch: 0,
    }));
  client.getParsedTokenAccountsByOwner = async owner => {
    const address = owner.toBase58();
    const raw = scenario.tokenRaw.get(address) ?? 0n;
    return {
      context: { slot: 1 },
      value:
        raw === 0n
          ? []
          : [
              {
                pubkey: PublicKey.unique(),
                account: {
                  owner: TOKEN_PROGRAM_ID,
                  lamports: 1,
                  executable: false,
                  rentEpoch: 0,
                  data: {
                    program: 'spl-token',
                    space: 165,
                    parsed: {
                      info: {
                        mint: scenario.mint,
                        owner: address,
                        tokenAmount: {
                          amount: raw.toString(),
                          decimals: scenario.decimals,
                          uiAmount: null,
                        },
                      },
                    },
                  },
                },
              },
            ],
    };
  };
  client.getTokenSupply = async () => ({
    context: { slot: 1 },
    value: {
      amount: '1000000000000',
      decimals: scenario.decimals,
      uiAmount: 1000,
      uiAmountString: '1000',
    },
  });
  client.getTokenLargestAccounts = async () => ({ context: { slot: 1 }, value: [] });
  client.getSignatureStatuses = async () => ({
    context: { slot: 1 },
    value: [
      {
        slot: 1,
        confirmations: 1,
        err: null,
        confirmationStatus: 'confirmed',
      },
    ],
  });
  client.sendRawTransaction = async raw => {
    scenario.sends++;
    const tx = VersionedTransaction.deserialize(Uint8Array.from(raw));
    const address = tx.message.staticAccountKeys[0]!.toBase58();
    const instruction = tx.message.compiledInstructions[0]!;
    const buyDiscriminator = crypto
      .createHash('sha256')
      .update('global:buy')
      .digest()
      .subarray(0, 8);
    const buying = Buffer.from(instruction.data).subarray(0, 8).equals(buyDiscriminator);
    const held = scenario.tokenRaw.get(address) ?? 0n;
    const balance = scenario.lamports.get(address)!;
    scenario.tokenRaw.set(address, buying ? held + scenario.boughtRaw : held - scenario.soldRaw);
    scenario.lamports.set(
      address,
      buying ? balance - scenario.buyCostLamports : balance + scenario.sellProceedsLamports,
    );
    if (scenario.unresolved.has(address)) throw new Error('Offline response lost after dispatch');
    return bs58.encode(tx.signatures[0]!);
  };
  // Every fetch is handled locally. Unexpected aggregator retries fail this test.
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url === 'https://pumpportal.fun/api/trade-local') {
      const args = JSON.parse(String(init?.body)) as { publicKey: string; action: 'buy' | 'sell' };
      scenario.builds++;
      return new Response(builtTrade(args.publicKey, args.action).serialize());
    }
    assert.ok(
      !url.includes('/swap/v1/'),
      'an unresolved submission must not retry through an aggregator',
    );
    if (url.includes('dexscreener')) return new Response('[]');
    if (url.includes('/tokens/v2/search')) return new Response('[]');
    if (url === 'http://127.0.0.1:8899')
      return new Response(JSON.stringify({ result: { accounts: [], paginationKey: null } }));
    return new Response('{}');
  };

  {
    const value = prepare();
    const text = await confirm('buy', 0.05);
    const position = db.position(value.mint)!;
    assert.equal(value.builds, 1);
    assert.equal(value.sends, 1);
    assert.equal(position.decimals, 9);
    assert.equal(position.tokensBought, 100);
    assert.equal(position.buyFills, 1);
    approx(position.investedSol, 0.05);
    approx(position.costSol, 0.05204428);
    approx(position.basisSol, 0.05);
    approx(position.basisTokens, 100);
    assert.equal(position.basisKnown, true);
    assert.match(text, /Bought 0\.05 SOL/);
    check(
      'confirmed manual buy books real nine-decimal token gains and measured cost through the public confirmation',
    );
  }

  {
    const value = prepare();
    value.tokenRaw.set(value.wallets[0]!.address, 100_000_000_000n);
    db.recordBuy(value.mint, {
      solSpent: 0.1,
      fills: 1,
      tokensBought: 100,
      decimals: 9,
      freshEntry: true,
    });
    const text = await confirm('sell', 90);
    const position = db.position(value.mint)!;
    assert.equal(value.builds, 1);
    assert.equal(value.sends, 1);
    assert.equal(position.sellFills, 1);
    approx(position.realisedSol, 0.1125);
    approx(position.basisSol, 0.025);
    approx(position.basisTokens, 25);
    assert.equal(position.basisKnown, true);
    // More tokens were sold than remain: using the mutated position for P&L
    // would reject the exit quantity and omit this profit notification.
    assert.match(text, /Profit <b>\+0\.0375 ◎<\/b> \(\+50\.0%\)/);
    check(
      'partial manual sell retires measured quantity and prices its notification from the pre-sale basis',
    );
  }

  {
    const value = prepare(2);
    for (const wallet of value.wallets) value.tokenRaw.set(wallet.address, 100_000_000_000n);
    value.unresolved.add(value.wallets[1]!.address);
    db.recordBuy(value.mint, {
      solSpent: 0.2,
      fills: 2,
      tokensBought: 200,
      decimals: 9,
      freshEntry: true,
    });
    const text = await confirm('buy', 0.05);
    const position = db.position(value.mint)!;
    assert.equal(value.builds, 2);
    assert.equal(value.sends, 2);
    assert.equal(position.buyFills, 3, 'only the confirmed wallet contributes another booked fill');
    assert.equal(
      position.tokensBought,
      300,
      'the unresolved wallet is excluded from measured booked quantity',
    );
    assert.equal(position.basisKnown, false);
    assert.equal(entryPrice(position), null);
    assert.match(text, /Some trades may still land\. Entry basis is unknown/);
    assert.doesNotMatch(text, /Profit <b>|Loss <b>/);
    check(
      'mixed manual buy keeps its basis unknown and consumes confirmation without rebuilding an uncertain spend',
    );
  }

  {
    const value = prepare(2);
    for (const wallet of value.wallets) value.tokenRaw.set(wallet.address, 100_000_000_000n);
    value.unresolved.add(value.wallets[1]!.address);
    db.recordBuy(value.mint, {
      solSpent: 0.2,
      fills: 2,
      tokensBought: 200,
      decimals: 9,
      freshEntry: true,
    });
    const text = await confirm('sell', 90);
    const position = db.position(value.mint)!;
    assert.equal(value.builds, 2);
    assert.equal(value.sends, 2);
    assert.equal(position.sellFills, 1);
    assert.equal(
      position.realisedSol,
      0,
      'unresolved proceeds cannot be attributed to confirmed wallets',
    );
    assert.equal(position.basisKnown, false);
    assert.equal(entryPrice(position), null);
    assert.match(text, /Entry basis and proceeds are unknown/);
    assert.doesNotMatch(text, /Profit <b>|Loss <b>/);
    check(
      'mixed manual sale withholds known basis and profit while the consumed confirmation prevents replay',
    );
  }
} finally {
  Object.assign(client, originals);
  globalThis.fetch = originalFetch;
  vault.lockVault();
  fs.rmSync(dataDir, { recursive: true, force: true });
}

console.log(`\n${passed} manual trade regressions passed.`);
