/** Offline public-behavior regressions. No source-code matching or live services. */
import assert from 'node:assert/strict';
import type { AutoRule } from '../../src/store/db.js';
import type { WatcherTradeServices } from '../../src/services/watcher.js';

import { db, fire, createNotifier, check, wallet, filled, rejected } from './fixtures.js';

export async function runWatcherBehaviors(): Promise<void> {
  // These complement the filled/uncertain/rejected cases in copytrade-regressions.
  for (const kind of ['stop_loss', 'trailing_stop', 'take_profit', 'limit_buy'] as const) {
    db.wipe();
    db.updateSettings({ slippagePercent: 15 });
    const rule: AutoRule = {
      id: `selection-${kind}`,
      mint: 'watcher-mint',
      symbol: '</b><script>',
      kind,
      triggerPct: -20,
      triggerPriceSol: 1,
      sellPercent: 100,
      buySol: 0.05,
      enabled: true,
      createdAt: 1,
      failedAttempts: 2,
    };
    db.addRule(rule);
    const selection: unknown[] = [];
    const notices: string[] = [];
    let slippage: number | undefined;
    const services: WatcherTradeServices = {
      selectWallets: options => {
        selection.push(options);
        return [wallet];
      },
      getMintBalances: async () => new Map([[wallet.address, 100n]]),
      getMintDecimals: async () => 6,
      batchPumpTrade: async (_wallets, request) => {
        slippage = request.slippagePercent;
        return filled();
      },
      measureTokensGained: async () => 100,
      measureTokensSold: async () => 100,
    };
    await fire(
      rule,
      1,
      async text => {
        notices.push(text);
      },
      services,
    );
    assert.deepEqual(selection, kind === 'limit_buy' ? [undefined] : [{ group: null }]);
    assert.equal(slippage, kind === 'stop_loss' || kind === 'trailing_stop' ? 35 : 15);
    assert.equal(rule.failedAttempts, 0);
    assert.ok(notices.some(text => text.includes('&lt;/b&gt;&lt;script&gt;')));
    assert.ok(notices.every(text => !text.includes('<script>')));
    check(`${kind}: correct wallet scope/slippage, escaped alerts and cleared prior failures`);
  }
  {
    db.wipe();
    const value: AutoRule = {
      id: 'bounded',
      mint: 'bounded-mint',
      kind: 'stop_loss',
      triggerPct: -20,
      sellPercent: 100,
      enabled: true,
      createdAt: 1,
    };
    db.addRule(value);
    let trades = 0;
    const services: WatcherTradeServices = {
      selectWallets: () => [wallet],
      getMintBalances: async () => new Map([[wallet.address, 100n]]),
      batchPumpTrade: async () => {
        trades++;
        return rejected();
      },
      measureTokensGained: async () => 0,
      measureTokensSold: async () => 0,
    };
    for (let attempt = 1; attempt <= 3; attempt++) {
      await fire(value, 1, async () => {}, services);
      assert.equal(value.failedAttempts, attempt);
      assert.equal(
        db.activeRules().some(rule => rule.id === value.id),
        attempt < 3,
      );
    }
    await fire(value, 1, async () => {}, services);
    assert.equal(trades, 3);
    check('three definite failures retire protection visibly and never start a fourth trade');
  }
  {
    const calls: { owner: number; text: string; options: unknown }[] = [];
    const warnings: string[] = [];
    let failHtml = false;
    let failPlain = false;
    const notify = createNotifier(
      {
        sendMessage: async (owner, text, options) => {
          calls.push({ owner, text, options });
          if ((options && failHtml) || (!options && failPlain))
            throw new Error(options ? 'bad markup' : 'offline Telegram');
        },
      },
      1,
      message => {
        warnings.push(message);
      },
    );
    await notify('<b>Filled</b>');
    assert.deepEqual(calls, [{ owner: 1, text: '<b>Filled</b>', options: { parse_mode: 'HTML' } }]);
    calls.length = 0;
    failHtml = true;
    await notify('<b>Filled</b>');
    assert.deepEqual(
      calls.map(call => call.text),
      ['<b>Filled</b>', 'Filled'],
    );
    assert.equal(calls[1]!.options, undefined);
    assert.match(warnings[0]!, /without formatting/);
    failPlain = true;
    await assert.doesNotReject(notify('<b>Filled</b>'));
    assert.match(warnings[1]!, /offline Telegram.*bad markup/);
    check('alerts fall back to plain text and report both failures without throwing');
  }
}
