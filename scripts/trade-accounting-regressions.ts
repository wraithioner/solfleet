/** Shared accounting behavior with injected measurements and an offline ledger. */
import assert from 'node:assert/strict';
import type { BuyEntry } from '../src/store/db.js';
import type { BatchSummary, ExecutionResult } from '../src/types.js';
import {
  classifyFills,
  isFreshEntry,
  recordMeasuredBuy,
  recordMeasuredSell,
} from '../src/trade/accounting.js';

let passed = 0;
const check = (name: string) => {
  passed++;
  console.log(`  ✓ ${name}`);
};

function result(address: string, patch: Partial<ExecutionResult> = {}): ExecutionResult {
  return {
    address,
    walletId: address,
    label: address,
    ok: true,
    signature: `sig-${address}`,
    ...patch,
  };
}

function summary(results: ExecutionResult[], patch: Partial<BatchSummary> = {}): BatchSummary {
  return {
    results,
    succeeded: results.filter(fill => fill.ok).length,
    failed: results.filter(fill => !fill.ok).length,
    startedAt: 1,
    finishedAt: 2,
    ...patch,
  };
}

function ledger() {
  const buys: Array<{ mint: string; entry: BuyEntry }> = [];
  const sells: Array<{
    mint: string;
    proceeds: number;
    fills: number;
    quantity: number | undefined;
  }> = [];
  const invalidated: string[] = [];
  const events: string[] = [];
  return {
    buys,
    sells,
    invalidated,
    events,
    invalidateBasis(mint: string) {
      invalidated.push(mint);
      events.push('invalidate');
    },
    recordBuy(mint: string, entry: BuyEntry) {
      buys.push({ mint, entry });
      events.push('buy');
    },
    recordSell(mint: string, proceeds: number, fills: number, quantity?: number) {
      sells.push({ mint, proceeds, fills, quantity });
      events.push('sell');
    },
  };
}

const mint = 'offline-mint';
const before = new Map([
  ['confirmed', 0n],
  ['other-group', 1_000_000_000n],
]);
const confirmed = result('confirmed');
const idle = result('idle', { signature: undefined, detail: 'unfunded' });
const failed = result('failed', { ok: false, signature: undefined, error: 'build rejected' });
const pending = result('pending', { ok: false, confirmationUnknown: true });

{
  const batch = summary([confirmed, idle, failed, pending]);
  const original = structuredClone(batch);
  assert.deepEqual(classifyFills(batch), { filled: [confirmed], fills: 1, uncertain: true });
  assert.deepEqual(batch, original);
  check(
    'classification distinguishes confirmed fills, idle wallets, failures and unresolved submissions',
  );
}

assert.equal(isFreshEntry(undefined), false);
assert.equal(isFreshEntry(before), false);
assert.equal(isFreshEntry(new Map()), true);
assert.equal(isFreshEntry(new Map([['confirmed', 0n]])), true);
check('a fresh basis requires readable balances with no existing holding in any group');

for (const decimals of [6, 9]) {
  const store = ledger();
  const batch = summary([confirmed, idle, failed], { solSpent: 0.104 });
  const booked = await recordMeasuredBuy(
    { mint, summary: batch, before, decimals, solPerWallet: 0.1, symbol: 'COIN' },
    {
      ledger: store,
      measureTokensGained: async (addresses, actualMint, actualBefore, actualDecimals) => {
        assert.deepEqual(addresses, ['confirmed']);
        assert.equal(actualMint, mint);
        assert.equal(actualBefore, before);
        assert.equal(actualDecimals, decimals);
        return 25;
      },
    },
  );
  assert.equal(booked.tokensBought, 25);
  assert.deepEqual(store.buys, [
    {
      mint,
      entry: {
        solSpent: 0.1,
        fills: 1,
        tokensBought: 25,
        symbol: 'COIN',
        costSol: 0.104,
        freshEntry: false,
        decimals,
        quantityComplete: true,
      },
    },
  ]);
  assert.deepEqual(store.invalidated, []);
}
check(
  'buy accounting uses confirmed wallets, actual decimals, measured cost and account-wide entry state',
);

{
  const store = ledger();
  const booked = await recordMeasuredBuy(
    {
      mint,
      summary: summary([confirmed, pending]),
      before: new Map(),
      decimals: 9,
      solPerWallet: 0.1,
    },
    {
      ledger: store,
      measureTokensGained: async addresses => {
        assert.deepEqual(addresses, ['confirmed']);
        assert.deepEqual(store.events, ['invalidate']);
        return 25;
      },
    },
  );
  assert.equal(booked.uncertain, true);
  assert.equal(store.buys[0]!.entry.quantityComplete, false);
  assert.equal(store.buys[0]!.entry.fills, 1);
  assert.equal(store.buys[0]!.entry.costSol, undefined);
  assert.deepEqual(store.events, ['invalidate', 'buy']);
  check(
    'mixed buys invalidate prior basis before measurements and cannot restore complete quantities',
  );
}

for (const results of [[idle, failed], [pending]]) {
  const store = ledger();
  const booked = await recordMeasuredBuy(
    { mint, summary: summary(results), before, decimals: 9, solPerWallet: 0.1 },
    {
      ledger: store,
      measureTokensGained: async () => {
        assert.fail('a batch without confirmed fills must not measure or book a purchase');
      },
    },
  );
  assert.equal(booked.fills, 0);
  assert.equal(booked.tokensBought, 0);
  assert.deepEqual(store.buys, []);
  assert.deepEqual(store.invalidated, results.includes(pending) ? [mint] : []);
}
check(
  'empty buys never book notional spending, while unresolved submissions still invalidate the basis',
);

{
  const store = ledger();
  await recordMeasuredBuy(
    {
      mint,
      summary: summary([confirmed]),
      before: new Map(),
      decimals: undefined,
      solPerWallet: 0.1,
    },
    {
      ledger: store,
      measureTokensGained: async () => {
        assert.fail('unknown decimals must not invent token units');
      },
    },
  );
  assert.equal(store.buys[0]!.entry.tokensBought, 0);
  assert.equal(store.buys[0]!.entry.decimals, undefined);
  assert.equal(store.buys[0]!.entry.costSol, undefined);
  assert.equal(store.buys[0]!.entry.freshEntry, true);
  check(
    'unreadable mint decimals preserve an explicitly unmeasured purchase instead of assuming six decimals',
  );
}

{
  const store = ledger();
  const booked = await recordMeasuredSell(
    {
      mint,
      summary: summary([confirmed, idle, failed], { solReceived: 0.075 }),
      before,
      decimals: 9,
    },
    {
      ledger: store,
      measureTokensSold: async (addresses, actualMint, actualBefore, actualDecimals) => {
        assert.deepEqual(addresses, ['confirmed']);
        assert.equal(actualMint, mint);
        assert.equal(actualBefore, before);
        assert.equal(actualDecimals, 9);
        return 25;
      },
    },
  );
  assert.equal(booked.tokensSold, 25);
  assert.deepEqual(store.sells, [{ mint, proceeds: 0.075, fills: 1, quantity: 25 }]);
  assert.deepEqual(store.invalidated, []);
  check(
    'sale accounting books measured proceeds and confirmed quantity with the original token units',
  );
}

{
  const store = ledger();
  const booked = await recordMeasuredSell(
    { mint, summary: summary([confirmed, pending]), before, decimals: 9 },
    {
      ledger: store,
      measureTokensSold: async addresses => {
        assert.deepEqual(addresses, ['confirmed']);
        assert.deepEqual(store.events, ['invalidate']);
        return 25;
      },
    },
  );
  assert.equal(booked.tokensSold, 25);
  assert.equal(booked.uncertain, true);
  assert.deepEqual(store.sells, [{ mint, proceeds: 0, fills: 1, quantity: undefined }]);
  assert.deepEqual(store.events, ['invalidate', 'sell']);
  check('mixed sales never use a confirmed token delta to retire an uncertain basis');
}

{
  const store = ledger();
  await recordMeasuredSell(
    { mint, summary: summary([confirmed]), before: undefined, decimals: undefined },
    {
      ledger: store,
      measureTokensSold: async (_addresses, _mint, actualBefore, actualDecimals) => {
        assert.equal(actualBefore, undefined);
        assert.equal(actualDecimals, undefined);
        return 0;
      },
    },
  );
  assert.deepEqual(store.sells, [{ mint, proceeds: 0, fills: 1, quantity: undefined }]);
  check('unmeasured sale proceeds and quantity retain the existing conservative ledger contract');
}

for (const results of [[idle, failed], [pending]]) {
  const store = ledger();
  const booked = await recordMeasuredSell(
    { mint, summary: summary(results), before, decimals: 9 },
    {
      ledger: store,
      measureTokensSold: async () => {
        assert.fail('a batch without confirmed fills must not measure or book a sale');
      },
    },
  );
  assert.equal(booked.fills, 0);
  assert.deepEqual(store.sells, []);
  assert.deepEqual(store.invalidated, results.includes(pending) ? [mint] : []);
}
check('empty sales never book proceeds, while unresolved submissions still invalidate the basis');

{
  const store = ledger();
  await assert.rejects(
    recordMeasuredBuy(
      { mint, summary: summary([confirmed, pending]), before, decimals: 9, solPerWallet: 0.1 },
      {
        ledger: store,
        measureTokensGained: async () => {
          throw new Error('balance read failed');
        },
      },
    ),
    /balance read failed/,
  );
  await assert.rejects(
    recordMeasuredSell(
      { mint, summary: summary([confirmed, pending]), before, decimals: 9 },
      {
        ledger: store,
        measureTokensSold: async () => {
          throw new Error('balance read failed');
        },
      },
    ),
    /balance read failed/,
  );
  assert.deepEqual(store.invalidated, [mint, mint]);
  assert.deepEqual(store.buys, []);
  assert.deepEqual(store.sells, []);
  check(
    'measurement errors preserve uncertain-basis invalidation and propagate for caller retry safeguards',
  );
}

console.log(`\n${passed} shared trade accounting regressions passed.`);
