/** Offline public-behavior regressions. No source-code matching or live services. */
import assert from 'node:assert/strict';
import { Keypair } from '@solana/web3.js';
import type { CopySellServices } from '../../src/services/copytrade.js';

import {
  db,
  mirrorBuy,
  mirrorSell,
  reviewFeedHealth,
  queueEvictionIndex,
  check,
  deferred,
  settle,
  wallet,
  filled,
  target,
  buyServices,
} from './fixtures.js';

export async function runCopyBehaviors(): Promise<void> {
  {
    assert.equal(
      reviewFeedHealth({ socket: 1, poll: 10 }, false).rebuild,
      false,
      'a tiny sample cannot establish a broken socket',
    );
    const broken = reviewFeedHealth({ socket: 4, poll: 8 }, false);
    assert.deepEqual(broken, { rebuild: true, warned: true, claims: { socket: 0, poll: 0 } });
    assert.equal(
      reviewFeedHealth({ socket: 4, poll: 8 }, true).rebuild,
      false,
      'an outstanding warning does not cause a rebuild loop',
    );
    assert.equal(
      reviewFeedHealth({ socket: 9, poll: 3 }, true).warned,
      false,
      'healthy delivery clears the warning',
    );
    assert.equal(
      reviewFeedHealth({ socket: 4, poll: 8 }, false).rebuild,
      true,
      'a later failure can be detected again',
    );
    assert.deepEqual(reviewFeedHealth({ socket: 180, poll: 30 }, false).claims, {
      socket: 90,
      poll: 15,
    });
    assert.equal(queueEvictionIndex([]), -1);
    assert.equal(queueEvictionIndex(['quiet', 'busy', 'busy', 'quiet', 'busy']), 1);
    assert.equal(
      queueEvictionIndex(['first', 'second', 'second', 'first']),
      0,
      'ties preserve arrival order',
    );
    check(
      'feed health rebuilds once, recovers and bounds history while queue eviction protects quieter targets',
    );
  }

  // The screen and balances must both start before either finishes. This fails
  // if the production code accidentally serializes the two network reads.
  {
    db.wipe();
    const value = target();
    const screen = deferred<{ verdict: { safe: boolean; reasons: string[]; notes: string[] } }>();
    const balances = deferred<Map<string, bigint>>();
    const started: string[] = [];
    let trades = 0;
    const services = buyServices();
    services.screenToken = () => {
      started.push('screen');
      return screen.promise;
    };
    services.getMintBalances = () => {
      started.push('balances');
      return balances.promise;
    };
    services.batchPumpTrade = async () => {
      trades++;
      return filled();
    };
    const work = mirrorBuy(
      value,
      { mint: 'overlap', delta: 100, before: 0 },
      1,
      async () => {},
      services,
    );
    await settle();
    assert.deepEqual(started, ['screen', 'balances']);
    assert.equal(trades, 0);
    balances.resolve(new Map([[wallet.address, 0n]]));
    await settle();
    assert.equal(trades, 0);
    screen.resolve({ verdict: { safe: true, reasons: [], notes: [] } });
    await work;
    assert.equal(trades, 1);
    assert.equal(db.position('overlap')?.buyFills, 1);
    check('copy screening overlaps balance reads and execution waits for both answers');
  }
  {
    db.wipe();
    const value = target();
    const screen = deferred<never>();
    const services = buyServices();
    let trades = 0;
    const notices: string[] = [];
    services.screenToken = () => screen.promise;
    services.getMintBalances = async () => new Map([[wallet.address, 1n]]);
    services.batchPumpTrade = async () => {
      trades++;
      return filled();
    };
    await mirrorBuy(
      value,
      { mint: 'already-held', delta: 100, before: 0 },
      1,
      async text => {
        notices.push(text);
      },
      services,
    );
    screen.reject(new Error('late screening failure'));
    await settle();
    assert.equal(trades, 0);
    assert.equal(notices.length, 0);
    assert.match(db.copyDecisions()[0]!.reason, /already hold/);
    check('an early holding refusal records quietly and consumes a later screening rejection');
  }
  {
    db.wipe();
    const notices: string[] = [];
    let trades = 0;
    const services = buyServices();
    services.batchPumpTrade = async () => {
      trades++;
      return filled();
    };
    const notify = async (text: string) => {
      notices.push(text);
    };
    const refused = target({ refusedMints: ['refused'] });
    await mirrorBuy(refused, { mint: 'refused', delta: 100, before: 0 }, 1, notify, services);
    assert.match(db.copyDecisions()[0]!.reason, /Already refused/);
    const capped = target({ entryMode: 'every', maxEntries: 2, entryCounts: { capped: 2 } });
    await mirrorBuy(capped, { mint: 'capped', delta: 100, before: 0 }, 1, notify, services);
    assert.match(db.copyDecisions()[0]!.reason, /Already taken 2/);
    const tiny = target({ buySol: 0 });
    await mirrorBuy(tiny, { mint: 'tiny', delta: 100, before: 0 }, 1, notify, services);
    assert.match(db.copyDecisions()[0]!.reason, /too small/);
    services.screenToken = async () => ({
      verdict: { safe: false, reasons: ['fixture unsafe'], notes: [] },
    });
    const unsafe = target();
    await mirrorBuy(unsafe, { mint: 'unsafe', delta: 100, before: 0 }, 1, notify, services);
    assert.match(db.copyDecisions()[0]!.reason, /fixture unsafe/);
    assert.ok(unsafe.refusedMints?.includes('unsafe'));
    assert.equal(trades, 0);
    assert.equal(notices.length, 0);
    check(
      'refused tokens, entry caps, zero sizes and safety refusals record reasons without trading or alerts',
    );
  }
  {
    db.wipe();
    db.updateSettings({ copySafety: { ...db.settings().copySafety, maxSolPerMint: 0.02 } });
    const notices: string[] = [];
    const notify = async (text: string) => {
      notices.push(text);
    };
    const services = buyServices();
    const fixed = target();
    await mirrorBuy(fixed, { mint: 'cap-a', delta: 100, before: 0 }, 1, notify, services);
    await mirrorBuy(fixed, { mint: 'cap-b', delta: 100, before: 0 }, 1, notify, services);
    assert.equal(notices.length, 1);
    db.updateSettings({ copySafety: { ...db.settings().copySafety, maxSolPerMint: 0.01 } });
    await mirrorBuy(fixed, { mint: 'cap-c', delta: 100, before: 0 }, 1, notify, services);
    assert.equal(notices.length, 2, 'changed configuration can warn again');
    const percent = target({ sizeMode: 'percent', sizePercent: 5 });
    await mirrorBuy(percent, { mint: 'cap-percent', delta: 100, before: 0 }, 1, notify, services);
    assert.equal(notices.length, 2, 'a large followed trade is not a fixed-size misconfiguration');
    assert.equal(db.positions().length, 0);
    check('fixed copy sizing warns once per configuration while percent sizing stays quiet');
  }
  {
    db.wipe();
    const value = target({ copiedMints: ['copied-exit'] });
    db.recordBuy('copied-exit', {
      solSpent: 0.05,
      fills: 1,
      tokensBought: 100,
      costSol: 0.05,
      freshEntry: true,
      decimals: 6,
    });
    const selection: unknown[] = [];
    const notices: string[] = [];
    let trades = 0;
    let held = false;
    const notify = async (text: string) => {
      notices.push(text);
    };
    const services: CopySellServices = {
      selectWallets: options => {
        selection.push(options);
        return [wallet];
      },
      getMintBalances: async () => (held ? new Map([[wallet.address, 100_000_000n]]) : new Map()),
      getMintDecimals: async () => 6,
      batchPumpTrade: async () => {
        trades++;
        return filled();
      },
      measureTokensSold: async () => 100,
    };
    await mirrorSell(
      value,
      { mint: 'someone-elses-position', delta: -100, before: 100 },
      notify,
      services,
    );
    assert.match(db.copyDecisions()[0]!.reason, /did not copy/);
    assert.equal(selection.length, 0);
    await mirrorSell(value, { mint: 'copied-exit', delta: -100, before: 100 }, notify, services);
    assert.match(db.copyDecisions()[0]!.reason, /hold none/);
    assert.equal(trades, 0);
    assert.equal(notices.length, 0);
    held = true;
    await mirrorSell(value, { mint: 'copied-exit', delta: -100, before: 100 }, notify, services);
    assert.deepEqual(selection, [{ group: null }, { group: null }]);
    assert.equal(trades, 1);
    assert.equal(db.position('copied-exit')?.realisedSol, 0.1);
    assert.ok(notices.some(text => text.includes('Profit') && text.includes('+0.0500')));
    assert.equal(db.position('copied-exit')?.basisTokens, 0);
    db.recordBuy('copied-exit', {
      solSpent: 0.05,
      fills: 1,
      tokensBought: 100,
      costSol: 0.05,
      freshEntry: true,
      decimals: 6,
    });
    services.batchPumpTrade = async () => ({
      ...filled(),
      results: [
        ...filled().results,
        {
          walletId: 'unknown-wallet',
          address: Keypair.generate().publicKey.toBase58(),
          label: 'Unknown',
          ok: false,
          signature: 'pending',
          confirmationUnknown: true,
        },
      ],
      failed: 1,
      solReceived: undefined,
    });
    await mirrorSell(value, { mint: 'copied-exit', delta: -100, before: 100 }, notify, services);
    assert.equal(db.position('copied-exit')?.sellFills, 2);
    assert.equal(
      db.position('copied-exit')?.realisedSol,
      0.1,
      'uncertain proceeds cannot manufacture a return',
    );
    assert.equal(db.position('copied-exit')?.basisKnown, false);
    assert.ok(notices.some(text => text.includes('may still land')));
    check(
      'copied exits use every group, report pre-sale profit and preserve unknown accounting on uncertain fills',
    );
  }
}
