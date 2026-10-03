import { db, type CopyTarget } from '../../store/db.js';
import { escapeHtml as h } from '../../util.js';
import { log } from '../../logger.js';
import { newRuleId } from '../rule-ids.js';
import type { Notifier } from '../watcher.js';

/**
 * Arm this target's own exits on a position it just opened.
 *
 * Only ever adds what is missing. A second entry into the same token must not
 * stack a second stop-loss on it, and a rule the operator changed by hand on
 * the token's own screen is theirs — this does not overwrite either.
 */
export function armCopyRules(target: CopyTarget, mint: string, notify?: Notifier): void {
  const existing = db.rulesFor(mint);
  const armed: string[] = [];
  const skipped: string[] = [];

  const add = (kind: 'take_profit' | 'stop_loss', triggerPct: number, sellPercent: number) => {
    if (existing.some(r => r.kind === kind && !r.firedAt)) {
      skipped.push(kind === 'take_profit' ? `TP +${triggerPct}%` : `SL ${triggerPct}%`);
      return;
    }
    db.addRule({
      id: newRuleId(),
      mint,
      kind,
      triggerPct,
      sellPercent,
      enabled: true,
      createdAt: Date.now(),
    });
    armed.push(kind === 'take_profit' ? `TP +${triggerPct}%` : `SL ${triggerPct}%`);
  };

  if (target.takeProfitPct !== undefined) {
    add('take_profit', target.takeProfitPct, target.takeProfitSellPct ?? 100);
  }
  if (target.stopLossPct !== undefined) {
    add('stop_loss', -Math.abs(target.stopLossPct), 100);
  }

  if (armed.length > 0) {
    log.info(`Armed ${armed.join(' and ')} on ${mint} from ${target.label}.`);
    void notify?.(`🤖 Armed <b>${armed.join('</b> and <b>')}</b> on this position.`).catch(
      () => {},
    );
  }

  /*
   * A rule already on the mint wins, and the operator is told which of this
   * target's settings were therefore not used.
   *
   * One position takes one set of exits — stacking a second stop-loss on the
   * same coin would sell it twice. But when two followed wallets are configured
   * differently the surviving set is a mixture of the two, and it used to
   * assemble itself in silence. Someone who set a trader to −30% has a right to
   * know their position is running on somebody else's −50%.
   */
  if (skipped.length > 0) {
    log.info(
      `${target.label}'s ${skipped.join(' and ')} not armed on ${mint}: ` +
        'the position already carries a rule of that kind.',
    );
    void notify?.(
      `ℹ️ <b>${h(target.label)}</b>'s ${skipped.join(' and ')} was not added — ` +
        'this position already has one of each. The existing rules stand.',
    ).catch(() => {});
  }
}
