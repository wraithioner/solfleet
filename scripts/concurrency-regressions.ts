/** Offline coordination regressions. All transaction builds and RPCs are mocked. */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import bs58 from 'bs58';
import {
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import type { Context } from 'grammy';
import type { AutoRule, DcaPlan } from '../src/store/db.js';
import type { WatcherTradeServices } from '../src/services/watcher.js';
import type { WalletRecord } from '../src/types.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'solfleet-coordination-'));
Object.assign(process.env, {
  BOT_TOKEN: '123:OFFLINE',
  OWNER_IDS: '1,2',
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
const { batchPumpTrade } = await import('../src/trade/engine.js');
const { fire, runDueDca } = await import('../src/services/watcher.js');
const { withExecution, withExecutionMaintenance, ExecutionCancelledError } = await import(
  '../src/services/execution.js'
);
const { session, stageConfirmation, takeConfirmation, setPending } = await import(
  '../src/bot/session.js'
);
const { executeFactoryReset, RESET_PHRASE } = await import('../src/bot/handlers/core.js');
const { promptFund } = await import('../src/bot/handlers/trade.js');
const { promptRemove } = await import('../src/bot/handlers/wallets.js');
const client = rpc();
const originalFetch = globalThis.fetch;
let passed = 0;
const check = (name: string) => {
  passed++;
  console.log(`  ✓ ${name}`);
};
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(r => {
    resolve = r;
  });
  return { promise, resolve };
};
const ctx = (id = 1): Context =>
  ({
    from: { id },
    reply: async () => ({}),
    answerCallbackQuery: async () => true,
  }) as unknown as Context;
const request = () => ({
  action: 'buy' as const,
  mint: Keypair.generate().publicKey.toBase58(),
  amount: 0.01,
  denominatedInSol: true,
  slippagePercent: 5,
  priorityFeeSol: 0.00005,
  pool: 'pump' as const,
});
function builtTrade(wallet: string): VersionedTransaction {
  const swap = new TransactionInstruction({
    programId: new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'),
    keys: [{ pubkey: new PublicKey(wallet), isSigner: true, isWritable: true }],
    data: Buffer.concat([
      crypto.createHash('sha256').update('global:buy').digest().subarray(0, 8),
      Buffer.alloc(16),
    ]),
  });
  return new VersionedTransaction(
    new TransactionMessage({
      payerKey: new PublicKey(wallet),
      recentBlockhash: Keypair.generate().publicKey.toBase58(),
      instructions: [swap],
    }).compileToV0Message(),
  );
}
function mockRpc(balance: () => number): void {
  client.getMultipleAccountsInfo = async keys =>
    keys.map(() => ({
      data: Buffer.alloc(0),
      executable: false,
      lamports: balance(),
      owner: SystemProgram.programId,
      rentEpoch: 0,
    }));
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
}
function fakeServices(): WatcherTradeServices {
  const wallet = { id: 'dummy', address: 'dummy', label: 'dummy' } as WalletRecord;
  return {
    selectWallets: () => [wallet],
    allWallets: () => [wallet],
    getMintDecimals: async () => 6,
    getMintBalances: async () => new Map([[wallet.address, 100n]]),
    batchPumpTrade: async () => ({
      results: [],
      succeeded: 0,
      failed: 0,
      startedAt: 1,
      finishedAt: 2,
    }),
    measureTokensGained: async () => 1,
    measureTokensSold: async () => 1,
  };
}

try {
  vault.initVaultWithKeyfile();
  db.updateSettings({ priorityFeeMode: 'fixed', executionMode: 'parallel' });

  {
    const started = deferred();
    const release = deferred();
    const order: string[] = [];
    const first = withExecution(async () => {
      order.push('before');
      started.resolve();
      await release.promise;
      await withExecution(async () => {
        order.push('nested');
      });
      order.push('ledger');
    });
    await started.promise;
    const second = withExecution(async () => {
      order.push('second-before');
    });
    await Promise.resolve();
    assert.deepEqual(order, ['before']);
    release.resolve();
    await Promise.all([first, second]);
    assert.deepEqual(order, ['before', 'nested', 'ledger', 'second-before']);
    check('complete operations serialize through bookkeeping and nested calls are reentrant');
  }

  {
    const trigger = deferred();
    let detached!: Promise<void>;
    let ran = false;
    await withExecution(async () => {
      detached = trigger.promise.then(() =>
        withExecution(async () => {
          ran = true;
        }),
      );
    });
    const rejected = assert.rejects(detached, ExecutionCancelledError);
    trigger.resolve();
    await rejected;
    assert.equal(ran, false);
    check('detached callbacks cannot reuse a completed operation to bypass the queue');
  }

  {
    const w = wallets.generateSolanaWallet('reserve');
    let balance = 24_200_000;
    let builds = 0;
    let sends = 0;
    mockRpc(() => balance);
    const entered = deferred();
    const release = deferred();
    globalThis.fetch = async (_url, init) => {
      builds++;
      entered.resolve();
      await release.promise;
      return new Response(builtTrade(JSON.parse(String(init?.body)).publicKey).serialize());
    };
    client.sendRawTransaction = async raw => {
      sends++;
      balance -= 12_094_280;
      return bs58.encode(VersionedTransaction.deserialize(Uint8Array.from(raw)).signatures[0]!);
    };
    const first = batchPumpTrade([w], request());
    await entered.promise;
    const second = batchPumpTrade([w], request());
    await Promise.resolve();
    assert.equal(builds, 1);
    release.resolve();
    const [a, b] = await Promise.all([first, second]);
    assert.equal(sends, 1);
    assert.equal(a.solSpent, 0.01209428);
    assert.equal(b.solSpent, undefined);
    assert.match(b.results[0]!.detail ?? '', /unfunded/);
    assert.ok(balance >= 110_000);
    check('queued buys recheck funds and cannot share or double-count the exit reserve');
  }

  {
    const a = wallets.generateSolanaWallet('parallel-a');
    const b = wallets.generateSolanaWallet('parallel-b');
    mockRpc(() => 1e9);
    let builds = 0;
    const both = deferred();
    const release = deferred();
    globalThis.fetch = async (_url, init) => {
      if (++builds === 2) both.resolve();
      await release.promise;
      return new Response(builtTrade(JSON.parse(String(init?.body)).publicKey).serialize());
    };
    client.sendRawTransaction = async raw =>
      bs58.encode(VersionedTransaction.deserialize(Uint8Array.from(raw)).signatures[0]!);
    const batch = batchPumpTrade([a, b], request());
    await both.promise;
    assert.equal(builds, 2);
    release.resolve();
    assert.equal((await batch).succeeded, 2);
    check('one batch retains concurrent wallet execution');
  }

  {
    const a = wallets.generateSolanaWallet('known-fill');
    const b = wallets.generateSolanaWallet('unknown-fill');
    let balance = 1e9;
    let sends = 0;
    mockRpc(() => balance);
    globalThis.fetch = async (_url, init) =>
      new Response(builtTrade(JSON.parse(String(init?.body)).publicKey).serialize());
    client.sendRawTransaction = async raw => {
      balance -= 10_000_000;
      if (++sends === 2) throw new Error('Response lost after dispatch');
      return bs58.encode(VersionedTransaction.deserialize(Uint8Array.from(raw)).signatures[0]!);
    };
    const req = request();
    db.recordBuy(req.mint, { solSpent: 0.01, fills: 1, tokensBought: 100, freshEntry: true });
    const result = await batchPumpTrade([a, b], req);
    assert.ok(result.results.some(r => r.confirmationUnknown));
    assert.equal(result.solSpent, undefined);
    assert.equal(db.position(req.mint)!.basisKnown, false);
    check('mixed confirmed and uncertain fills cannot publish a combined cost or known basis');
  }

  {
    const services = fakeServices();
    let trades = 0;
    services.batchPumpTrade = async () => {
      trades++;
      return { results: [], succeeded: 0, failed: 0, startedAt: 1, finishedAt: 2 };
    };
    const rule: AutoRule = {
      id: 'cleared-rule',
      mint: 'mint',
      kind: 'stop_loss',
      triggerPct: -20,
      sellPercent: 100,
      enabled: true,
      createdAt: 1,
    };
    db.addRule(rule);
    const snapshot = db.activeRules().find(r => r.id === rule.id)!;
    db.removeRule(rule.id);
    await fire(snapshot, 1, async () => {}, services);
    assert.equal(trades, 0);
    const entered = deferred();
    const release = deferred();
    services.getMintBalances = async () => {
      entered.resolve();
      await release.promise;
      return new Map();
    };
    const plan: DcaPlan = {
      id: 'cleared-dca',
      mint: 'mint',
      buySol: 0.01,
      roundsDone: 0,
      roundsTotal: 2,
      intervalMinutes: 60,
      nextRunAt: 0,
      enabled: true,
      createdAt: 1,
    };
    db.addDcaPlan(plan);
    const pending = runDueDca(async () => {}, services);
    await entered.promise;
    db.removeDcaPlan(plan.id);
    release.resolve();
    await pending;
    assert.equal(trades, 0);
    const disabledRule = { ...rule, id: 'disabled-during-read' };
    db.addRule(disabledRule);
    const reading = deferred();
    const continueRead = deferred();
    services.getMintBalances = async () => {
      reading.resolve();
      await continueRead.promise;
      return new Map([['dummy', 100n]]);
    };
    const pendingRule = fire(disabledRule, 1, async () => {}, services);
    await reading.promise;
    db.updateRule(disabledRule.id, { enabled: false });
    continueRead.resolve();
    await pendingRule;
    assert.equal(trades, 0);
    check('removed rule snapshots and DCA removed during a balance read cannot trade');
  }

  {
    const w = wallets.generateSolanaWallet('disable-before-send');
    mockRpc(() => 1e9);
    client.getAccountInfo = async () => null;
    const entered = deferred();
    const release = deferred();
    let sends = 0;
    globalThis.fetch = async (_url, init) => {
      entered.resolve();
      await release.promise;
      return new Response(builtTrade(JSON.parse(String(init?.body)).publicKey).serialize());
    };
    client.sendRawTransaction = async raw => {
      sends++;
      return bs58.encode(VersionedTransaction.deserialize(Uint8Array.from(raw)).signatures[0]!);
    };
    const rule: AutoRule = {
      id: 'disable-during-build',
      mint: request().mint,
      kind: 'limit_buy',
      triggerPct: -10,
      triggerPriceSol: 1,
      buySol: 0.01,
      sellPercent: 0,
      enabled: true,
      createdAt: 1,
    };
    db.addRule(rule);
    const services = fakeServices();
    services.selectWallets = () => [w];
    services.allWallets = () => [w];
    services.getMintBalances = async () => new Map();
    services.batchPumpTrade = batchPumpTrade;
    const firing = fire(rule, 1, async () => {}, services);
    await entered.promise;
    db.updateRule(rule.id, { enabled: false });
    release.resolve();
    await firing;
    assert.equal(sends, 0);
    assert.equal(rule.enabled, false);
    assert.equal(rule.failedAttempts, undefined);
    check('disabling a rule during its builder request revokes authorization before submission');
  }

  {
    const id = stageConfirmation(2, 'old settings', async () => {});
    db.updateSettings({ slippagePercent: 80 });
    assert.equal(takeConfirmation(2, id), undefined);
    const changedWallet = stageConfirmation(2, 'old wallets', async () => {});
    wallets.generateSolanaWallet('selection-changed');
    assert.equal(takeConfirmation(2, changedWallet), undefined);
    check('confirmation parameters are invalidated when settings or wallet selection change');
  }

  {
    const source = wallets.generateSolanaWallet('fund-main');
    wallets.setMain(source.id);
    const recipient = wallets.generateSolanaWallet('fund-recipient');
    wallets.addToGroup(recipient.id, 'fund-test');
    db.updateSettings({ activeGroup: 'fund-test' });
    let targetLamports = 100_000_000;
    const transfers: bigint[] = [];
    mockRpc(() => targetLamports);
    client.getBalance = async () => 1e9;
    client.getLatestBlockhash = async () => ({
      blockhash: Keypair.generate().publicKey.toBase58(),
      lastValidBlockHeight: 1,
    });
    client.sendRawTransaction = async raw => {
      const tx = VersionedTransaction.deserialize(Uint8Array.from(raw));
      transfers.push(
        ...tx.message.compiledInstructions
          .filter(ix =>
            tx.message.staticAccountKeys[ix.programIdIndex]?.equals(SystemProgram.programId),
          )
          .map(ix => Buffer.from(ix.data).readBigUInt64LE(4)),
      );
      return bs58.encode(tx.signatures[0]!);
    };
    await promptFund(ctx(2), 'topup', 0.2);
    let id = [...session(2).confirmations.keys()][0]!;
    targetLamports = 150_000_000;
    await takeConfirmation(2, id)!.run(ctx(2));
    assert.deepEqual(transfers, [50_000_000n]);
    await promptFund(ctx(2), 'topup', 0.2);
    id = [...session(2).confirmations.keys()][0]!;
    targetLamports = 0;
    await takeConfirmation(2, id)!.run(ctx(2));
    assert.equal(transfers.length, 1);
    check('top-ups shrink changed deficits and refuse increases above the confirmation');
  }

  {
    const w = wallets.generateSolanaWallet('remove-in-flight');
    mockRpc(() => 1e9);
    const entered = deferred();
    const release = deferred();
    let sends = 0;
    globalThis.fetch = async (_url, init) => {
      entered.resolve();
      await release.promise;
      return new Response(builtTrade(JSON.parse(String(init?.body)).publicKey).serialize());
    };
    client.sendRawTransaction = async raw => {
      sends++;
      return bs58.encode(VersionedTransaction.deserialize(Uint8Array.from(raw)).signatures[0]!);
    };
    const trade = batchPumpTrade([w], request());
    await entered.promise;
    await promptRemove(ctx(1), w.id);
    const id = [...session(1).confirmations.keys()][0]!;
    const removing = takeConfirmation(1, id)!.run(ctx(1));
    await Promise.resolve();
    assert.ok(wallets.walletById(w.id));
    release.resolve();
    await Promise.all([trade, removing]);
    assert.equal(sends, 0);
    assert.equal(wallets.walletById(w.id), undefined);
    check('wallet removal cancels pre-send builds and drains active work before erasing the key');
  }

  {
    db.updateSettings({ activeGroup: null });
    const w = wallets.generateSolanaWallet('reset-in-flight');
    mockRpc(() => 1e9);
    const entered = deferred();
    const release = deferred();
    let sends = 0;
    globalThis.fetch = async (_url, init) => {
      entered.resolve();
      await release.promise;
      return new Response(builtTrade(JSON.parse(String(init?.body)).publicKey).serialize());
    };
    client.sendRawTransaction = async raw => {
      sends++;
      return bs58.encode(VersionedTransaction.deserialize(Uint8Array.from(raw)).signatures[0]!);
    };
    stageConfirmation(2, 'old account', async () => {});
    setPending(2, { kind: 'factory_reset' });
    const first = batchPumpTrade([w], request());
    await entered.promise;
    const queued = withExecution(async () => {
      throw new Error('obsolete queued action ran');
    });
    const rejected = assert.rejects(queued, ExecutionCancelledError);
    const reset = executeFactoryReset(ctx(1), RESET_PHRASE);
    await Promise.resolve();
    assert.ok(db.wallets().length > 0, 'reset waits until the active operation finishes');
    release.resolve();
    const result = await first;
    await Promise.all([reset, rejected]);
    assert.equal(sends, 0);
    assert.equal(result.results[0]!.confirmationUnknown, undefined);
    assert.match(result.results[0]!.error ?? '', /account changed/);
    assert.equal(db.wallets().length, 0);
    assert.equal(db.tradeLog().length, 0);
    assert.equal(session(2).confirmations.size, 0);
    assert.equal(session(2).pending, undefined);
    check('reset drains bookkeeping, cancels pending submissions and clears every owner session');
  }
  await assert.rejects(
    withExecution(async () => withExecutionMaintenance(async () => {})),
    ExecutionCancelledError,
  );
  check('maintenance inside an active operation rejects instead of deadlocking');

  console.log(`\n${passed} concurrency regressions passed.`);
} finally {
  globalThis.fetch = originalFetch;
  vault.lockVault();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
