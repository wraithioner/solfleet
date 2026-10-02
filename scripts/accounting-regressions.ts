/** Offline accounting checks: quantities, remaining basis, and complete reads. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ParsedAccountData, PublicKey as PublicKeyType } from '@solana/web3.js';
import type { WatcherTradeServices } from '../src/services/watcher.js';
import type { WalletRecord } from '../src/types.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'solfleet-accounting-'));
process.env.BOT_TOKEN = '123:OFFLINE_TEST';
process.env.OWNER_IDS = '1';
process.env.DATA_DIR = dataDir;
process.env.VAULT_AUTOLOCK_MINUTES = '0';
process.env.JUPITER_REQUEST_INTERVAL_MS = '0';

const { db } = await import('../src/store/db.js');
const { entryPrice, exitResult, positionPnl, accountPnl } = await import('../src/services/pnl.js');
const { rpc, getSplBalances, getMintBalances, getMintDecimals, WSOL_MINT, sendSplToken } = await import('../src/chains/solana.js');
const { measureTokensGained, measureTokensSold, isFreshEntry, batchSweepToken } = await import('../src/trade/engine.js');
const { buildPortfolio, aggregateToken, listPositions } = await import('../src/services/portfolio.js');
const { fire, runDueDca, entryPriceSol, ruleTriggered } = await import('../src/services/watcher.js');
const { initVaultWithKeyfile, lockVault } = await import('../src/store/vault.js');
const { generateSolanaWallet } = await import('../src/store/wallets.js');
const { clearPriceCache } = await import('../src/services/prices.js');
const { PublicKey, VersionedTransaction } = await import('@solana/web3.js');
const { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, AccountLayout } = await import('@solana/spl-token');
const bs58 = (await import('bs58')).default;
const client = rpc();
const original = {
  tokens: client.getParsedTokenAccountsByOwner, multiple: client.getMultipleAccountsInfo,
  account: client.getAccountInfo, blockhash: client.getLatestBlockhash,
  send: client.sendRawTransaction, statuses: client.getSignatureStatuses, fetch: globalThis.fetch,
};
let passed = 0;
const check = (name: string) => { passed++; console.log(`  ✓ ${name}`); };
const approx = (actual: number | null, expected: number) => assert.ok(actual !== null && Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`);
const mint = PublicKey.unique().toBase58();
let decimals = 9;
let entries: Array<{ address: string; account: PublicKeyType; raw: bigint; ui: number | null; program: PublicKeyType; confidential?: boolean }> = [];
let failToken22 = false;

function parsed(entry: typeof entries[number]) {
  return {
    pubkey: entry.account,
    account: { owner: entry.program, lamports: 2_039_280, executable: false, rentEpoch: 0,
      data: { program: entry.program.equals(TOKEN_PROGRAM_ID) ? 'spl-token' : 'spl-token-2022', space: 165,
        parsed: { info: { mint, owner: entry.address,
          tokenAmount: { amount: entry.raw.toString(), decimals, uiAmount: entry.ui, uiAmountString: String(Number(entry.raw) / 10 ** decimals) },
          ...(entry.confidential ? { extensions: [{ extension: 'confidentialTransferAccount' }] } : {}),
        } },
      } as ParsedAccountData,
    },
  };
}

try {
  db.recordBuy('partial', { solSpent: 1, fills: 1, tokensBought: 100, freshEntry: true });
  db.recordSell('partial', 0.9, 1, 90);
  approx(entryPrice(db.position('partial')), 0.01);
  db.recordBuy('partial', { solSpent: 1, fills: 1, tokensBought: 10 });
  approx(entryPrice(db.position('partial')), 1.1 / 20);
  approx(exitResult(db.position('partial'), 20, 1.1)!.profitSol, 0);
  assert.equal(ruleTriggered({ id: 'stop', mint: 'partial', kind: 'stop_loss', triggerPct: -50,
    sellPercent: 100, enabled: true, createdAt: 1 }, 0.02, entryPrice(db.position('partial'))), true);
  check('partial sells retire basis before averaging in and preserve correct exits and stops');

  db.recordBuy('unknown-buy', { solSpent: 1, fills: 1, tokensBought: 0 });
  db.recordBuy('unknown-buy', { solSpent: 1, fills: 1, tokensBought: 100 });
  assert.equal(entryPrice(db.position('unknown-buy')), null);
  db.recordBuy('unknown-sale', { solSpent: 1, fills: 1, tokensBought: 100 });
  db.recordSell('unknown-sale', 0.5, 1);
  assert.equal(entryPrice(db.position('unknown-sale')), null);
  assert.equal(exitResult(db.position('unknown-sale'), 10, 1), null);
  db.recordBuy('unknown-sale', { solSpent: 2, fills: 1, tokensBought: 10, freshEntry: true });
  approx(entryPrice(db.position('unknown-sale')), 0.2);
  const legacy = { mint: 'legacy', investedSol: 1, tokensBought: 100, realisedSol: 0.5,
    buyFills: 1, sellFills: 1, firstBuyAt: 1, lastTradeAt: 2 };
  assert.equal(entryPrice(legacy), null);
  check('unknown quantities and legacy sales cannot become reliable basis through lifetime fallbacks');

  db.recordBuy('fees', { solSpent: 1, costSol: 1.02, fills: 1, tokensBought: 100 });
  const feePos = db.position('fees')!;
  approx(positionPnl(feePos, 1).netSol, -0.02);
  approx(accountPnl([feePos], new Map([['fees', 1]]), 100).netSol, -0.02);
  check('position and account profit both include measured fees and rent');

  const ledgerBefore = structuredClone(db.positions());
  for (const patch of [{ solSpent: NaN }, { solSpent: Infinity }, { fills: Infinity }, { fills: 1.5 },
    { tokensBought: NaN }, { tokensBought: -1 }, { costSol: Infinity }, { costSol: -1 }, { decimals: 256 }, { decimals: 1.5 }]) {
    db.recordBuy('fees', { solSpent: 1, fills: 1, tokensBought: 100, ...patch });
  }
  for (const [sol, fills, quantity] of [[NaN, 1, 1], [Infinity, 1, 1], [1, Infinity, 1], [1, 1.5, 1], [1, 1, NaN], [1, 1, -1]]) {
    db.recordSell('fees', sol!, fills!, quantity);
  }
  assert.deepEqual(db.positions(), ledgerBefore);
  db.recordBuy('overflow', { solSpent: 1e308, fills: 1, tokensBought: 1 });
  db.recordBuy('overflow', { solSpent: 1e308, fills: 1, tokensBought: 1 });
  assert.equal(db.position('overflow')!.investedSol, 1e308);
  check('malformed financial inputs and overflowing sums cannot corrupt persisted amounts');

  initVaultWithKeyfile();
  const wallet = generateSolanaWallet('accounting-wallet');
  const other: WalletRecord = { ...wallet, id: 'other', address: PublicKey.unique().toBase58() };
  client.getParsedTokenAccountsByOwner = async (owner, filter) => {
    if ('programId' in filter && filter.programId.equals(TOKEN_2022_PROGRAM_ID) && failToken22) throw new Error('offline Token-2022 outage');
    return { context: { slot: 1 }, value: entries.filter((e) => e.address === owner.toBase58() &&
      ('mint' in filter || e.program.equals(filter.programId))).map(parsed) };
  };
  client.getMultipleAccountsInfo = async (keys) => keys.map(() => ({ owner: PublicKey.default,
    data: Buffer.alloc(0), lamports: 1e9, executable: false, rentEpoch: 0 }));
  client.getAccountInfo = async () => {
    const data = Buffer.alloc(82); data[44] = decimals; data[45] = 1;
    return { owner: TOKEN_PROGRAM_ID, data, lamports: 1, executable: false, rentEpoch: 0 };
  };
  globalThis.fetch = async () => new Response(JSON.stringify({ [WSOL_MINT]: { usdPrice: 100 }, [mint]: { usdPrice: 5 } }), { status: 200 });
  entries = [
    { address: wallet.address, account: PublicKey.unique(), raw: 1_000_000_000n, ui: null, program: TOKEN_PROGRAM_ID },
    { address: wallet.address, account: PublicKey.unique(), raw: 2_000_000_000n, ui: 200, program: TOKEN_PROGRAM_ID },
  ];
  assert.equal(await getMintDecimals(mint), 9);
  const holdings = await getSplBalances(wallet.address);
  assert.deepEqual(holdings.map((h) => h.amount), [1, 2]);
  assert.equal((await getMintBalances([wallet.address], mint)).get(wallet.address), 3_000_000_000n);
  const portfolio = await buildPortfolio();
  assert.equal(aggregateToken(portfolio, mint).totalAmount, 3);
  assert.equal(aggregateToken(portfolio, mint).totalUsd, 15);
  assert.equal(listPositions(portfolio)[0]!.walletCount, 1);
  check('all mint accounts are summed once per wallet and nullable or scaled UI floats cannot alter accounting units');

  const before = new Map([[wallet.address, 1_000_000_000n], [other.address, 100_000_000_000n]]);
  assert.equal(await measureTokensGained([wallet.address], mint, before, 9), 2);
  entries = [{ ...entries[0]!, raw: 500_000_000n }];
  assert.equal(await measureTokensSold([wallet.address], mint, before, 9), 0.5);
  assert.equal(await measureTokensGained([wallet.address], mint, new Map(), undefined), 0);
  assert.equal(await measureTokensSold([wallet.address], mint, before, undefined), 0);
  assert.equal(isFreshEntry(new Map([[other.address, 1n]])), false);
  check('measurements use actual decimals and only the selected wallet delta even with account-wide before balances');

  db.recordBuy(mint, { solSpent: 1, fills: 1, tokensBought: 100, freshEntry: true, decimals: 9 });
  const services: WatcherTradeServices = {
    selectWallets: () => [wallet], allWallets: () => [wallet, other],
    getMintBalances: async (addresses) => { assert.ok(addresses.includes(other.address)); return new Map([[other.address, 100_000_000_000n]]); },
    getMintDecimals: async () => 9,
    measureTokensGained: async (_addresses, _mint, _before, actualDecimals) => { assert.equal(actualDecimals, 9); return 1; },
    measureTokensSold: async () => 1,
    batchPumpTrade: async () => ({ results: [{ walletId: wallet.id, address: wallet.address, label: wallet.label,
      ok: true, signature: 'offline-fill' }], succeeded: 1, failed: 0, startedAt: 1, finishedAt: 2, solSpent: 1 }),
  };
  const rule = { id: 'nine-decimal-limit', mint, kind: 'limit_buy' as const, triggerPct: 0,
    sellPercent: 100, buySol: 1, triggerPriceSol: 1, enabled: true, createdAt: 1 };
  db.addRule(rule); await fire(rule, 1, async () => {}, services);
  approx(entryPriceSol(mint), 2 / 101);
  db.addDcaPlan({ id: 'nine-decimal-dca', mint, buySol: 1, roundsDone: 0, roundsTotal: 1,
    intervalMinutes: 1, nextRunAt: 0, enabled: true, createdAt: 1 });
  await runDueDca(async () => {}, services);
  approx(entryPriceSol(mint), 3 / 102);
  assert.equal(db.position(mint)!.decimals, 9);
  check('limit and DCA buys read actual decimals and preserve another wallet group’s open basis');

  const uncertainMint = PublicKey.unique().toBase58();
  const uncertainRule = { ...rule, id: 'mixed-confirmation-limit', mint: uncertainMint, firedAt: undefined };
  db.addRule(uncertainRule);
  const uncertainServices: WatcherTradeServices = { ...services,
    getMintBalances: async () => new Map(),
    measureTokensGained: async (addresses, _mint, _before, actualDecimals) => {
      assert.deepEqual(addresses, [wallet.address]); assert.equal(actualDecimals, 9); return 1;
    },
    batchPumpTrade: async () => ({ results: [
      { walletId: wallet.id, address: wallet.address, label: wallet.label, ok: true, signature: 'confirmed' },
      { walletId: other.id, address: other.address, label: other.label, ok: false, signature: 'pending', confirmationUnknown: true },
    ], succeeded: 1, failed: 1, startedAt: 1, finishedAt: 2 }),
  };
  let note = '';
  await fire(uncertainRule, 1, async (text) => { note = text; }, uncertainServices);
  assert.equal(db.position(uncertainMint)!.tokensBought, 1);
  assert.equal(db.position(uncertainMint)!.investedSol, 1);
  assert.equal(entryPriceSol(uncertainMint), null);
  assert.match(note, /Entry basis and proceeds are unknown/);
  check('mixed confirmations count only confirmed token deltas and keep the open basis unknown');

  failToken22 = true; clearPriceCache();
  const partial = await buildPortfolio();
  assert.match(partial.errors.join(' '), /Token-2022 outage/);
  failToken22 = false;
  const validEntries = entries;
  entries = [{ ...entries[0]!, raw: -1n }];
  await assert.rejects(getMintBalances([wallet.address], mint), /invalid raw amount/);
  await assert.rejects(getSplBalances(wallet.address), /invalid raw amount/);
  entries = validEntries;
  check('malformed raw RPC balances cannot reduce exposure or valuation');
  entries = [{ ...entries[0]!, raw: 0n, confidential: true, program: TOKEN_2022_PROGRAM_ID }];
  await assert.rejects(getSplBalances(wallet.address), /Confidential/);
  await assert.rejects(getMintBalances([wallet.address], mint), /Confidential/);
  check('Token-2022 outages and encrypted balances remain unknown instead of becoming a complete zero valuation');

  entries = [
    { address: wallet.address, account: PublicKey.unique(), raw: 1_000_000_000n, ui: 1, program: TOKEN_PROGRAM_ID },
    { address: wallet.address, account: PublicKey.unique(), raw: 2_000_000_000n, ui: 2, program: TOKEN_PROGRAM_ID },
  ];
  client.getLatestBlockhash = async () => ({ blockhash: PublicKey.default.toBase58(), lastValidBlockHeight: 1 });
  client.getSignatureStatuses = async () => ({ context: { slot: 1 }, value: [{ slot: 1,
    confirmations: 1, err: null, confirmationStatus: 'confirmed' }] });
  const sweptSources: string[] = [];
  client.sendRawTransaction = async (raw) => {
    const tx = VersionedTransaction.deserialize(Uint8Array.from(raw));
    const keys = tx.message.staticAccountKeys;
    for (const ix of tx.message.compiledInstructions) {
      if (keys[ix.programIdIndex]!.equals(TOKEN_PROGRAM_ID) && ix.data[0] === 9) sweptSources.push(keys[ix.accountKeyIndexes[0]!]!.toBase58());
    }
    return bs58.encode(tx.signatures[0]!);
  };
  const swept = await batchSweepToken([wallet], mint, PublicKey.unique().toBase58());
  assert.equal(swept.succeeded, 2);
  assert.deepEqual(sweptSources, entries.map((e) => e.account.toBase58()));
  check('one token sweep moves and closes every matching account including non-ATAs');

  const source = PublicKey.unique();
  const extended = Buffer.alloc(178);
  AccountLayout.encode({ mint: new PublicKey(mint), owner: new PublicKey(wallet.address), amount: 1_000_000_000n,
    delegateOption: 0, delegate: PublicKey.default, state: 1, isNativeOption: 0, isNative: 0n,
    delegatedAmount: 0n, closeAuthorityOption: 0, closeAuthority: PublicKey.default }, extended);
  extended[165] = 2; extended.writeUInt16LE(2, 166); extended.writeUInt16LE(8, 168); extended.writeBigUInt64LE(10n, 170);
  client.getAccountInfo = async () => ({ owner: TOKEN_2022_PROGRAM_ID, data: extended, lamports: 1, executable: false, rentEpoch: 0 });
  let harvested = false;
  client.sendRawTransaction = async (raw) => {
    const tx = VersionedTransaction.deserialize(Uint8Array.from(raw));
    harvested = tx.message.compiledInstructions.some((ix) => tx.message.staticAccountKeys[ix.programIdIndex]!.equals(TOKEN_2022_PROGRAM_ID) && ix.data[0] === 26 && ix.data[1] === 4);
    return bs58.encode(tx.signatures[0]!);
  };
  const { solanaKeypair } = await import('../src/store/wallets.js');
  await sendSplToken(solanaKeypair(wallet), PublicKey.unique().toBase58(), mint, 1_000_000_000n,
    decimals, 0, TOKEN_2022_PROGRAM_ID.toBase58(), true, source.toBase58());
  assert.equal(harvested, true);
  check('withheld transfer fees are harvested before closing a Token-2022 source account');
  console.log(`\n${passed} offline accounting regressions passed.`);
} finally {
  client.getParsedTokenAccountsByOwner = original.tokens;
  client.getMultipleAccountsInfo = original.multiple;
  client.getAccountInfo = original.account;
  client.getLatestBlockhash = original.blockhash;
  client.sendRawTransaction = original.send;
  client.getSignatureStatuses = original.statuses;
  globalThis.fetch = original.fetch;
  lockVault(); fs.rmSync(dataDir, { recursive: true, force: true });
}
