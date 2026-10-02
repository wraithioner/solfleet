/** Offline execution regressions. Every RPC and trade operation is injected. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AutoRule, CopyTarget, DcaPlan } from '../src/store/db.js';
import type { BatchSummary, ExecutionResult, WalletRecord } from '../src/types.js';
import type { WatcherTradeServices } from '../src/services/watcher.js';
import type { CopyBuyServices } from '../src/services/copytrade.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'solfleet-copy-regressions-'));
process.env.BOT_TOKEN = '123:OFFLINE_TEST';
process.env.OWNER_IDS = '1';
process.env.DATA_DIR = dataDir;
process.env.VAULT_AUTOLOCK_MINUTES = '0';

const { db } = await import('../src/store/db.js');
const { fire, runDueDca } = await import('../src/services/watcher.js');
const { mirrorBuy } = await import('../src/services/copytrade.js');

const wallet: WalletRecord = {
  id: 'offline-wallet',
  kind: 'solana',
  address: 'offline-address',
  label: 'Offline wallet',
  secret: '',
  groups: [],
  isMain: false,
  disabled: false,
  createdAt: 1,
};
const result = (patch: Partial<ExecutionResult> = {}): ExecutionResult => ({
  walletId: wallet.id,
  address: wallet.address,
  label: wallet.label,
  ok: true,
  signature: 'offline-confirmed-signature',
  ...patch,
});
const summary = (results = [result()]): BatchSummary => ({
  results,
  succeeded: results.filter((r) => r.ok).length,
  failed: results.filter((r) => !r.ok).length,
  startedAt: 1,
  finishedAt: 2,
  solReceived: 0.1,
  solSpent: 0.05,
});
const rejected = () => summary([result({ ok: false, signature: undefined, error: 'Build rejected' })]);
const uncertain = () => summary([
  result({ ok: false, signature: 'offline-pending-signature', error: 'Confirmation timed out', confirmationUnknown: true }),
]);
const noopNotify = async (_text: string) => {};
const rejectNotify = async (_text: string) => { throw new Error('Telegram unavailable'); };
const baseServices = (): WatcherTradeServices => ({
  selectWallets: () => [wallet],
  getMintBalances: async () => new Map([[wallet.address, 100_000_000n]]),
  batchPumpTrade: async () => summary(),
  measureTokensGained: async () => 100,
  measureTokensSold: async () => 100,
});
let sequence = 0;
const rule = (kind: AutoRule['kind'] = 'stop_loss'): AutoRule => {
  const id = `offline-rule-${++sequence}`;
  const value: AutoRule = {
    id,
    mint: `${id}-mint`,
    kind,
    triggerPct: -30,
    sellPercent: 50,
    buySol: 0.05,
    triggerPriceSol: 1,
    enabled: true,
    createdAt: 1,
  };
  db.addRule(value);
  return value;
};
const plan = (): DcaPlan => {
  const id = `offline-plan-${++sequence}`;
  const value: DcaPlan = {
    id,
    mint: `${id}-mint`,
    buySol: 0.05,
    roundsDone: 2,
    roundsTotal: 4,
    intervalMinutes: 60,
    nextRunAt: 0,
    enabled: true,
    createdAt: 1,
  };
  db.addDcaPlan(value);
  return value;
};
let passed = 0;
const check = (name: string) => {
  passed++;
  console.log(`  ✓ ${name}`);
};

try {
  for (const kind of ['stop_loss', 'limit_buy'] as const) {
    const value = rule(kind);
    let trades = 0;
    const services = baseServices();
    services.batchPumpTrade = async () => { trades++; return summary(); };
    await fire(value, 1, rejectNotify, services);
    assert.equal(trades, 1);
    assert.ok(value.firedAt, 'a notification failure must not re-arm a filled order');
    assert.equal(value.failedAttempts, undefined);
    assert.ok(!db.activeRules().some((r) => r.id === value.id));
    check(`${kind}: filled order stays fired when Telegram fails`);
  }

  {
    const value = rule();
    const services = baseServices();
    services.measureTokensSold = async () => { throw new Error('Post-trade balance unavailable'); };
    await fire(value, 1, noopNotify, services);
    assert.ok(value.firedAt);
    assert.equal(value.failedAttempts, undefined);
    check('post-fill processing failure does not repeat the trade');
  }

  {
    const value = rule();
    let trades = 0;
    const services = baseServices();
    services.getMintBalances = async () => { throw new Error('RPC unavailable'); };
    services.batchPumpTrade = async () => { trades++; return summary(); };
    await fire(value, 1, noopNotify, services);
    assert.equal(trades, 0);
    assert.equal(value.firedAt, undefined);
    assert.equal(value.failedAttempts, 1);
    check('unreadable exit balances preserve protection for a bounded retry');
  }

  {
    const value = rule();
    const services = baseServices();
    services.getMintBalances = async () => new Map();
    await fire(value, 1, noopNotify, services);
    assert.ok(value.firedAt);
    assert.equal(value.failedAttempts, undefined);
    check('confirmed empty holdings retire the exit rule');
  }

  for (const kind of ['stop_loss', 'limit_buy'] as const) {
    const value = rule(kind);
    const services = baseServices();
    services.batchPumpTrade = async () => rejected();
    await fire(value, 1, noopNotify, services);
    assert.equal(value.firedAt, undefined);
    assert.equal(value.failedAttempts, 1);
    check(`${kind}: definitely rejected order is re-armed`);
  }

  {
    const value = rule();
    const services = baseServices();
    services.batchPumpTrade = async () => uncertain();
    const notices: string[] = [];
    await fire(value, 1, async (text) => { notices.push(text); }, services);
    assert.ok(value.firedAt);
    assert.equal(value.failedAttempts, undefined);
    assert.ok(notices.some((text) => text.includes('may still land')));
    check('unconfirmed submission is held for review instead of retried');
  }

  {
    const value = rule();
    const services = baseServices();
    services.batchPumpTrade = async () => summary([result(), result({ ok: false, signature: undefined, error: 'Rejected' })]);
    await fire(value, 1, noopNotify, services);
    assert.ok(value.firedAt);
    assert.equal(value.failedAttempts, undefined);
    check('partial fills never replay the successful wallets');
  }

  {
    const value = rule();
    const services = baseServices();
    services.batchPumpTrade = async () => { throw new Error('Execution interrupted'); };
    await fire(value, 1, noopNotify, services);
    assert.ok(value.firedAt);
    assert.equal(value.failedAttempts, undefined);
    check('a thrown batch with unknown submission state is never blindly retried');
  }

  {
    const value = plan();
    const services = baseServices();
    services.batchPumpTrade = async () => rejected();
    await runDueDca(noopNotify, services);
    assert.equal(value.roundsDone, 2, 'rollback must use the count before the store mutated the plan');
    assert.ok(value.nextRunAt <= Date.now());
    db.removeDcaPlan(value.id);
    check('DCA round with no fills returns its original round count');
  }

  {
    const value = plan();
    const services = baseServices();
    services.batchPumpTrade = async () => uncertain();
    await runDueDca(noopNotify, services);
    assert.equal(value.roundsDone, 3, 'an unconfirmed round remains claimed');
    assert.equal(value.enabled, false, 'future spending pauses until confirmation is checked');
    assert.ok(!db.dueDcaPlans().some((p) => p.id === value.id));
    db.removeDcaPlan(value.id);
    check('unconfirmed DCA execution pauses the plan without retrying the round');
  }

  {
    const value = plan();
    const services = baseServices();
    services.batchPumpTrade = async () => summary([result(), uncertain().results[0]!]);
    await runDueDca(noopNotify, services);
    assert.equal(value.roundsDone, 3);
    assert.equal(value.enabled, false);
    assert.equal(db.position(value.mint)?.buyFills, 1, 'confirmed fills still reach the ledger');
    db.removeDcaPlan(value.id);
    check('partial DCA fills are recorded while an unconfirmed wallet pauses further spending');
  }

  {
    const value = plan();
    const services = baseServices();
    services.batchPumpTrade = async () => { throw new Error('Batch interrupted'); };
    const notices: string[] = [];
    await runDueDca(async (text) => { notices.push(text); }, services);
    assert.equal(value.roundsDone, 3);
    assert.equal(value.enabled, false);
    assert.ok(notices.some((text) => text.includes('plan is paused')));
    db.removeDcaPlan(value.id);
    check('a thrown DCA batch keeps its round claimed and reports the paused plan');
  }

  {
    const mint = 'offline-copy-mint';
    db.recordBuy(mint, { solSpent: 0.4, fills: 1, tokensBought: 100, freshEntry: true });
    const priorPosition = structuredClone(db.position(mint));
    const target: CopyTarget = {
      id: 'offline-copy-target',
      address: 'offline-trader',
      label: 'Offline trader',
      buySol: 0.05,
      sizeMode: 'fixed',
      sizePercent: 5,
      entryMode: 'first',
      maxEntries: 1,
      exitMode: 'all',
      copiedMints: [],
      enabled: true,
      createdAt: 1,
    };
    db.addCopyTarget(target);
    let trades = 0;
    const services: CopyBuyServices = {
      selectWallets: () => [wallet],
      getMintBalances: async () => { throw new Error('RPC unavailable'); },
      screenToken: async () => ({ verdict: { safe: true, reasons: [], notes: [] } }),
      batchPumpTrade: async () => { trades++; return summary(); },
      measureTokensGained: async () => 100,
    };
    await mirrorBuy(target, { mint, delta: 100, before: 0 }, 1, noopNotify, services);
    assert.equal(trades, 0);
    assert.equal(target.entryCounts?.[mint], undefined, 'a refused balance read must not consume an entry');
    assert.deepEqual(target.copiedMints, []);
    assert.deepEqual(db.position(mint), priorPosition, 'existing basis and exposure remain intact');
    assert.match(db.copyDecisions()[0]!.reason, /balances could not be read/);
    check('copy trades fail closed on unreadable holdings without resetting the cost basis');
  }

  console.log(`\n${passed} offline copy-trade and watcher regressions passed.`);
} finally {
  fs.rmSync(dataDir, { recursive: true, force: true });
}
