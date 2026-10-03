import { getMintBalances, getMintDecimals } from '../../chains/solana.js';
import { db, type CopyTarget } from '../../store/db.js';
import { selectWallets } from '../../store/wallets.js';
import { batchPumpTrade, measureTokensSold } from '../../trade/engine.js';
import { classifyFills, recordMeasuredSell } from '../../trade/accounting.js';
import { errMessage, escapeHtml as h } from '../../util.js';
import { log } from '../../logger.js';
import type { Notifier } from '../watcher.js';
import { exitResult, formatExit } from '../pnl.js';
import { withExecution, executionEpoch, assertExecutionEpoch } from '../execution.js';
import type { TokenMove } from './events.js';
import { copySellPercent, lifetimeCostSol } from './policy.js';
import { currentTarget, assertCopyCurrent, copyIntent, withMintLock, noted } from './state.js';
import { firstReason } from './reporting.js';

export interface CopySellServices {
  selectWallets: typeof selectWallets;
  getMintBalances: typeof getMintBalances;
  getMintDecimals: typeof getMintDecimals;
  batchPumpTrade: typeof batchPumpTrade;
  measureTokensSold: typeof measureTokensSold;
}

const sellServices: CopySellServices = {
  selectWallets,
  getMintBalances,
  getMintDecimals,
  batchPumpTrade,
  measureTokensSold,
};

export async function mirrorSell(
  target: CopyTarget,
  move: TokenMove,
  notify: Notifier,
  services: CopySellServices = sellServices,
): Promise<void> {
  const epoch = executionEpoch();
  const intent = copyIntent(target);
  /*
   * Behind the same lock the buys queue on.
   *
   * A trader who flips a coin inside a minute can have their sell reach us
   * while our copy of their buy is still in flight, and the state this function
   * reads to decide — whether the coin was copied, what it cost — is written by
   * that buy. Unlocked, the exit reads the world as it was before the entry and
   * concludes there is nothing to close, which leaves the position open on a
   * trade the trader has already left.
   */
  return withExecution(
    () => {
      assertExecutionEpoch(epoch);
      return withMintLock(move.mint, () => mirrorSellLocked(target, move, notify, services));
    },
    () => {
      const current = currentTarget(target);
      return !!current && copyIntent(current) === intent;
    },
  );
}

async function mirrorSellLocked(
  target: CopyTarget,
  move: TokenMove,
  notify: Notifier,
  services: CopySellServices,
): Promise<void> {
  assertCopyCurrent(target);
  /*
   * Only exit what this trader actually put you into.
   *
   * Holding the coin used to be the entire test, which made every followed
   * wallet a trigger for every position in the book. A trader selling a token
   * they had nothing to do with — one bought by hand, or copied from somebody
   * else entirely — closed it anyway, and in `all` mode closed all of it. The
   * trader whose exit this mirrors has to be the trader whose entry opened it.
   *
   * Two conditions, because neither is sufficient alone. `copiedMints` says
   * this target opened it; a recorded cost basis says a buy actually landed,
   * which covers records written before refusals were kept in their own list
   * and so cannot distinguish a rejected coin from a bought one.
   */
  if (!target.copiedMints.includes(move.mint)) {
    log.info(`Ignored ${target.label} selling ${move.mint}: never copied from them.`);
    noted(target, move.mint, 'They sold a coin you did not copy from them');
    return;
  }

  /*
   * Every wallet, not the group currently selected.
   *
   * The position was opened under whatever group was active then, and the
   * filter is one tap. An exit that only looks where you happen to be trading
   * finds nothing and leaves the position open — see the note in the watcher.
   */
  const wallets = services.selectWallets({ group: null });
  if (wallets.length === 0) return;

  // only act if we actually hold it
  const held = await services
    .getMintBalances(
      wallets.map(w => w.address),
      move.mint,
    )
    .catch(() => new Map());
  assertCopyCurrent(target);
  if (held.size === 0) {
    // the wallets that built this position may sit outside the active group,
    // in which case the exit silently does nothing — say so rather than not
    log.warn(`Copied exit for ${move.mint} found nothing to sell in the selected wallets.`);
    noted(target, move.mint, 'They sold, but your wallets hold none of it');
    return;
  }

  /*
   * Listed as copied, held in the wallets, and yet no cost basis anywhere.
   *
   * Two different histories produce this and neither can be told from the
   * other: a buy that landed on chain while the process died before writing it
   * down, or a coin refused back when refusals shared a list with copies. The
   * safe reading is to leave the position alone — an exit taken on a guess
   * sells something the operator chose to hold — but leaving it alone silently
   * is how somebody finds out days later. The rules armed on the position still
   * stand, and so does selling it by hand.
   */
  if (lifetimeCostSol(move.mint) <= 0) {
    log.warn(`Copied exit for ${move.mint} skipped: listed as copied but no recorded cost basis.`);
    await notify(
      [
        `⚠️ <b>${h(target.label)} sold a coin you hold, and it was not mirrored</b>`,
        `<code>${move.mint}</code>`,
        '',
        'The wallets hold it, but nothing recorded what it cost — so there is no',
        'way to tell a copy whose confirmation was lost from a coin this trader',
        'was refused. It was left alone rather than sold on a guess.',
        '',
        '<i>Open it from Positions to sell by hand.</i>',
      ].join('\n'),
    ).catch(() => {});
    return;
  }

  const percent = copySellPercent(target.exitMode, move);
  if (percent <= 0) return;

  const settings = db.settings();
  log.info(`Copying ${target.label} out of ${move.mint} (${percent}%)`);

  try {
    assertCopyCurrent(target);
    const summary = await services.batchPumpTrade(wallets, {
      action: 'sell',
      mint: move.mint,
      amount: percent,
      denominatedInSol: false,
      slippagePercent: settings.slippagePercent,
      priorityFeeSol: settings.priorityFeeSol,
      pool: 'auto',
    });

    // the proceeds, so the position's P&L reflects a copied exit as a return
    // rather than as the disappearance of everything it cost
    const { uncertain } = classifyFills(summary);
    if (uncertain) db.invalidateBasis(move.mint);

    /*
     * What this exit made, priced before the sale is recorded — recording
     * changes the position the profit is measured against.
     */
    const storedPosition = db.position(move.mint);
    const position = storedPosition ? { ...storedPosition } : undefined;
    const decimals =
      position?.decimals ?? (await services.getMintDecimals(move.mint).catch(() => undefined));
    const { tokensSold } = await recordMeasuredSell(
      {
        mint: move.mint,
        summary,
        before: held,
        decimals,
      },
      { ledger: db, measureTokensSold: services.measureTokensSold },
    );
    const outcome =
      !uncertain && summary.solReceived !== undefined
        ? exitResult(position, tokensSold, summary.solReceived)
        : null;

    db.appendTradeLog({
      at: Date.now(),
      action: `copy sell ${percent}%`,
      mint: move.mint,
      walletCount: wallets.length,
      succeeded: summary.succeeded,
      failed: summary.failed,
      note: `copied ${target.label}`,
    });

    await notify(
      `👥 <b>${h(target.label)} sold ${percent}%</b>\n<code>${move.mint}</code>\n\n` +
        `Mirrored — ✅ ${summary.succeeded}  ❌ ${summary.failed}` +
        (outcome ? `\n${formatExit(outcome)}` : '') +
        (uncertain
          ? '\nSome trades may still land. Entry basis and proceeds are unknown; check the wallets.'
          : '') +
        `${firstReason(summary)}`,
    ).catch(() => {});
  } catch (err) {
    await notify(`❌ Copy sell failed: <i>${errMessage(err)}</i>`).catch(() => {});
  }
}
