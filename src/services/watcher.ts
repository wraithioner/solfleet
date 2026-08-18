import crypto from 'node:crypto';
import { db, type AutoRule } from '../store/db.js';
import { isUnlocked } from '../store/vault.js';
import { selectWallets } from '../store/wallets.js';
import { batchPumpTrade } from '../trade/engine.js';
import { getMintBalances } from '../chains/solana.js';
import { pricesInSol } from './price.js';
import { errMessage } from '../util.js';
import { pollCopyTargets } from './copytrade.js';
import { log } from '../logger.js';

/**
 * The background loop behind take-profit, stop-loss and trailing stops.
 *
 * Everything here is written on the assumption that nobody is watching. That
 * shapes three decisions:
 *
 *  - **A missing price never fires a rule.** An unreadable price is not a price
 *    of zero, and treating it as one would dump a position because an RPC
 *    hiccupped.
 *  - **A rule fires once.** It is marked as fired before the sell is attempted,
 *    so a crash mid-execution cannot replay it into a second sell on the next
 *    tick.
 *  - **A locked vault pauses, it does not fail.** After a redeploy the keys are
 *    gone from memory until the operator unlocks; rules stay armed and the
 *    operator is told once, rather than the loop grinding through errors.
 */

export type Notifier = (text: string) => Promise<void>;

const TICK_MS = 20_000;

let timer: NodeJS.Timeout | null = null;
let running = false;
let warnedLocked = false;

export function newRuleId(): string {
  return crypto.randomBytes(4).toString('hex');
}

/**
 * Entry price in SOL for a position, derived from what it actually cost.
 *
 * Returns null rather than guessing when the tokens acquired were never
 * measured — a percentage from an unknown entry is a number with no meaning,
 * and rules built on it would fire at arbitrary prices.
 */
export function entryPriceSol(mint: string): number | null {
  const pos = db.position(mint);
  if (!pos || pos.investedSol <= 0 || pos.tokensBought <= 0) return null;
  return pos.investedSol / pos.tokensBought;
}

/** Has this rule's condition been met? Pure, so the thresholds are testable. */
export function ruleTriggered(
  rule: AutoRule,
  currentPrice: number,
  entryPrice: number | null,
): boolean {
  if (currentPrice <= 0) return false;

  // Limit orders are absolute: the target was fixed when the rule was made, so
  // it cannot drift with the market the way a percentage would.
  if (rule.kind === 'limit_buy' || rule.kind === 'limit_sell') {
    const target = rule.triggerPriceSol;
    if (target === undefined || target <= 0) return false;
    return rule.kind === 'limit_buy' ? currentPrice <= target : currentPrice >= target;
  }

  if (rule.kind === 'trailing_stop') {
    const peak = rule.peakPriceSol ?? currentPrice;
    // triggerPct is negative: how far below the peak is far enough
    return currentPrice <= peak * (1 + rule.triggerPct / 100);
  }

  if (entryPrice === null || entryPrice <= 0) return false;
  const movePct = ((currentPrice - entryPrice) / entryPrice) * 100;

  return rule.kind === 'take_profit' ? movePct >= rule.triggerPct : movePct <= rule.triggerPct;
}

export function startWatcher(notify: Notifier): void {
  if (timer) return;
  timer = setInterval(() => void tick(notify), TICK_MS);
  timer.unref?.();
  log.info(`Watcher started (auto-sell + copy trading), checking every ${TICK_MS / 1000}s.`);
}

export function stopWatcher(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

async function tick(notify: Notifier): Promise<void> {
  if (running) return; // a slow tick must not overlap the next one
  running = true;

  try {
    const rules = db.activeRules();
    const copyTargets = db.activeCopyTargets();
    const dca = db.dueDcaPlans();
    if (rules.length === 0 && copyTargets.length === 0 && dca.length === 0) return;

    if (!isUnlocked()) {
      if (!warnedLocked) {
        warnedLocked = true;
        const armed = [
          rules.length > 0 ? `${rules.length} auto-sell rule${rules.length === 1 ? '' : 's'}` : '',
          copyTargets.length > 0 ? `${copyTargets.length} copy target${copyTargets.length === 1 ? '' : 's'}` : '',
        ].filter(Boolean).join(' and ');

        await notify(
          `🔒 <b>${armed} armed, but the vault is locked.</b>\n\n` +
            'Send your passphrase to resume — nothing can trade until then.',
        ).catch(() => {});
      }
      return;
    }
    warnedLocked = false;

    // mirroring runs before the rules: a copied exit should not be delayed by
    // a price sweep that has nothing to do with it
    if (copyTargets.length > 0) await pollCopyTargets(notify);
    await runDueDca(notify);

    if (rules.length === 0) return;
    const prices = await pricesInSol([...new Set(rules.map((r) => r.mint))]);

    for (const rule of rules) {
      const price = prices.get(rule.mint);
      if (price === undefined) continue; // unknown price is not a trigger

      // trailing stops track the high-water mark between ticks
      if (rule.kind === 'trailing_stop' && price > (rule.peakPriceSol ?? 0)) {
        db.updateRule(rule.id, { peakPriceSol: price });
        rule.peakPriceSol = price;
      }

      if (!ruleTriggered(rule, price, entryPriceSol(rule.mint))) continue;

      await fire(rule, price, notify);
    }
  } catch (err) {
    log.error('Watcher tick failed', err);
  } finally {
    running = false;
  }
}

async function fire(rule: AutoRule, price: number, notify: Notifier): Promise<void> {
  // Marked before the attempt, never after: a crash between here and the sell
  // must not leave a rule that fires again on the next tick.
  db.updateRule(rule.id, { firedAt: Date.now() });

  const label = rule.symbol ?? rule.mint.slice(0, 8);
  const entry = entryPriceSol(rule.mint);
  const movePct = entry && entry > 0 ? ((price - entry) / entry) * 100 : 0;

  log.info(`Rule ${rule.kind} fired for ${rule.mint} at ${price.toExponential(4)} SOL`);

  try {
    const wallets = selectWallets();
    const settings = db.settings();

    if (rule.kind === 'limit_buy') {
      const summary = await batchPumpTrade(wallets, {
        action: 'buy',
        mint: rule.mint,
        amount: rule.buySol ?? 0,
        denominatedInSol: true,
        slippagePercent: settings.slippagePercent,
        priorityFeeSol: settings.priorityFeeSol,
        pool: 'auto',
      });

      const fills = summary.results.filter((r) => r.ok && r.signature).length;
      db.recordBuy(rule.mint, (rule.buySol ?? 0) * fills, fills);
      db.appendTradeLog({
        at: Date.now(),
        action: `limit buy ${rule.buySol} SOL`,
        mint: rule.mint,
        walletCount: wallets.length,
        succeeded: summary.succeeded,
        failed: summary.failed,
        note: 'automatic',
      });

      await notify(
        [
          `📉 <b>Limit buy filled — ${label}</b>`,
          '',
          `Price reached ${price.toExponential(4)} SOL`,
          `Bought ${rule.buySol} SOL × ${wallets.length} wallets`,
          `✅ ${summary.succeeded}   ❌ ${summary.failed}`,
        ].join('\n'),
      );
      return;
    }

    const holders = await getMintBalances(wallets.map((w) => w.address), rule.mint).catch(() => new Map());
    if (holders.size === 0) {
      await notify(`⚠️ <b>${label}</b>: ${describe(rule)} triggered, but no wallet holds it any more.`);
      return;
    }
    const summary = await batchPumpTrade(wallets, {
      action: 'sell',
      mint: rule.mint,
      amount: rule.sellPercent,
      denominatedInSol: false,
      slippagePercent: settings.slippagePercent,
      priorityFeeSol: settings.priorityFeeSol,
      pool: 'auto',
    });

    db.appendTradeLog({
      at: Date.now(),
      action: `${rule.kind} ${rule.sellPercent}%`,
      mint: rule.mint,
      walletCount: summary.results.length,
      succeeded: summary.succeeded,
      failed: summary.failed,
      note: 'automatic',
    });

    await notify(
      [
        `${rule.kind === 'stop_loss' ? '🛑' : '🎯'} <b>${describe(rule)} fired — ${label}</b>`,
        '',
        `Price: ${price.toExponential(4)} SOL${entry ? ` (${movePct >= 0 ? '+' : ''}${movePct.toFixed(1)}% from entry)` : ''}`,
        `Sold ${rule.sellPercent}% across ${summary.results.length} wallets`,
        `✅ ${summary.succeeded}   ❌ ${summary.failed}`,
      ].join('\n'),
    );
  } catch (err) {
    await notify(`❌ <b>${label}</b>: ${describe(rule)} fired but the sell failed.\n\n<i>${errMessage(err)}</i>`).catch(
      () => {},
    );
  }
}

export function describe(rule: AutoRule): string {
  if (rule.kind === 'take_profit') return `Take profit +${rule.triggerPct}%`;
  if (rule.kind === 'stop_loss') return `Stop loss ${rule.triggerPct}%`;
  if (rule.kind === 'trailing_stop') return `Trailing stop ${rule.triggerPct}%`;
  if (rule.kind === 'limit_buy') return `Limit buy ${rule.buySol} SOL at ${rule.triggerPriceSol?.toExponential(3)}`;
  return `Limit sell ${rule.sellPercent}% at ${rule.triggerPriceSol?.toExponential(3)}`;
}

// ── DCA ───────────────────────────────────────────────────────────────────────

/**
 * Run any averaging-in rounds that have come due.
 *
 * A round that fails still advances the schedule. Retrying a missed buy at the
 * next tick would bunch the purchases together, which is the opposite of what
 * averaging in is for.
 */
async function runDueDca(notify: Notifier): Promise<void> {
  for (const plan of db.dueDcaPlans()) {
    const wallets = selectWallets();
    const settings = db.settings();
    const round = plan.roundsDone + 1;

    db.updateDcaPlan(plan.id, {
      roundsDone: round,
      nextRunAt: Date.now() + plan.intervalMinutes * 60_000,
    });

    try {
      const summary = await batchPumpTrade(wallets, {
        action: 'buy',
        mint: plan.mint,
        amount: plan.buySol,
        denominatedInSol: true,
        slippagePercent: settings.slippagePercent,
        priorityFeeSol: settings.priorityFeeSol,
        pool: 'auto',
      });

      const fills = summary.results.filter((r) => r.ok && r.signature).length;
      db.recordBuy(plan.mint, plan.buySol * fills, fills);
      db.appendTradeLog({
        at: Date.now(),
        action: `DCA ${round}/${plan.roundsTotal}`,
        mint: plan.mint,
        walletCount: wallets.length,
        succeeded: summary.succeeded,
        failed: summary.failed,
        note: 'automatic',
      });

      const done = round >= plan.roundsTotal;
      await notify(
        [
          `🔁 <b>DCA round ${round}/${plan.roundsTotal} — ${plan.symbol ?? plan.mint.slice(0, 8)}</b>`,
          `Bought ${plan.buySol} SOL × ${wallets.length} wallets`,
          `✅ ${summary.succeeded}   ❌ ${summary.failed}`,
          done ? '\n<i>Plan complete.</i>' : `\n<i>Next round in ${plan.intervalMinutes} minutes.</i>`,
        ].join('\n'),
      );
    } catch (err) {
      await notify(`❌ DCA round ${round} failed: <i>${errMessage(err)}</i>`).catch(() => {});
    }
  }
}
