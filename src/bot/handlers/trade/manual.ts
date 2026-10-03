import type { Context } from 'grammy';
import { InlineKeyboard } from 'grammy';
import { config } from '../../../config.js';
import { db, type Settings } from '../../../store/db.js';
import { selectWallets, allWallets } from '../../../store/wallets.js';
import { getTokenInfo } from '../../../services/tokeninfo.js';
import { exitResult, formatExit } from '../../../services/pnl.js';
import { getMintBalances, getMintDecimals, LAMPORTS } from '../../../chains/solana.js';
import { simulateSequentialBuys, fetchBondingCurve } from '../../../trade/curve.js';
import {
  batchPumpTrade,
  measureTokensGained,
  measureTokensSold,
  batchSellAllPositions,
} from '../../../trade/engine.js';
import { classifyFills, recordMeasuredBuy, recordMeasuredSell } from '../../../trade/accounting.js';
import { fundingBalances, partitionByBalance, requiredForBuy } from '../../../trade/fund.js';
import { errMessage, fmtAmount, shortAddr } from '../../../util.js';
import { stageConfirmation, tokenId } from '../../session.js';
import { renderBatchSummary, confirmKeyboard, backButton, h } from '../../ui.js';
import { render } from '../core.js';
import { withExecution } from '../../../services/execution.js';
import type { TradeRequest, WalletRecord } from '../../../types.js';
import { throttledProgress } from './progress.js';

// ── buying ────────────────────────────────────────────────────────────────────

export async function promptBuy(ctx: Context, mint: string, solPerWallet: number): Promise<void> {
  const settings = structuredClone(db.settings());
  const wallets = structuredClone(selectWallets());

  // rejections come first, while the tap can still be answered with an alert
  if (wallets.length === 0) {
    await ctx.answerCallbackQuery({ text: 'No Solana wallets selected.', show_alert: true });
    return;
  }

  if (solPerWallet > config.safety.maxBuySolPerWallet) {
    await ctx.answerCallbackQuery({
      text: `Blocked: ${solPerWallet} SOL exceeds the per-wallet cap of ${config.safety.maxBuySolPerWallet}.`,
      show_alert: true,
    });
    return;
  }

  // balances are read below, and that is slow enough to need something on screen
  await render(ctx, `<b>🟢 Buy ${solPerWallet} SOL per wallet</b>\n\n<i>Checking balances…</i>`);

  const total = solPerWallet * wallets.length;
  const lines = [
    '<b>🟢 Confirm batch buy</b>',
    '',
    `Token: <code>${h(mint)}</code>`,
    `Wallets: <b>${wallets.length}</b>${settings.activeGroup ? ` (group <i>${h(settings.activeGroup)}</i>)` : ''}`,
    `Amount: <b>${solPerWallet} SOL</b> each`,
    `Total spend: <b>${fmtAmount(total, 4)} SOL</b> + fees`,
    `Slippage: ${settings.slippagePercent}%  ·  Mode: ${settings.executionMode}`,
  ];

  // which wallets can actually pay for this — better seen now than as a column
  // of identical failures afterwards
  try {
    const balances = await fundingBalances(wallets.map(w => w.address));
    // a bundled send carries a tip per transaction, which is money the wallet
    // needs to hold just as much as the trade itself
    const needed = requiredForBuy(solPerWallet, settings.priorityFeeSol, {
      jitoTipSol: settings.executionMode === 'bundle' ? settings.jitoTipSol : 0,
    });
    const { unfunded } = partitionByBalance(wallets, balances, needed);

    lines.push(
      `Each wallet needs <b>${fmtAmount(Number(needed) / LAMPORTS, 4)} SOL</b> ` +
        `<i>(the buy, fees, token account rent, and enough left to sell)</i>`,
    );

    if (unfunded.length > 0) {
      lines.push('');
      lines.push(
        `⚠️ <b>${unfunded.length} of ${wallets.length} wallets cannot cover this</b> and will be skipped.`,
      );
      lines.push('<i>Move Funds → Fund wallets from main.</i>');
    }
  } catch {
    /* the trade is not blocked on a balance read */
  }

  // walk the curve so the operator sees the real average fill, not N × spot
  try {
    const curve = await fetchBondingCurve(mint);
    if (curve && !curve.complete) {
      const sim = simulateSequentialBuys(curve, solPerWallet, wallets.length);

      lines.push('');
      lines.push(`Est. tokens: <b>${fmtAmount(sim.totalTokens, 0)}</b>`);
      lines.push(`Spot now: ${sim.startPrice.toExponential(4)} SOL`);
      lines.push(
        `Avg fill: <b>${sim.avgPrice.toExponential(4)} SOL</b>` +
          ` (${sim.avgVsSpotPct >= 0 ? '+' : ''}${sim.avgVsSpotPct.toFixed(1)}% vs spot)`,
      );
      lines.push(
        `Price after: ${sim.finalPrice.toExponential(4)} SOL (<b>+${sim.priceMovePct.toFixed(1)}%</b>)`,
      );

      if (wallets.length > 1) {
        lines.push(
          `<i>First wallet gets ${fmtAmount(sim.firstWalletTokens, 0)}, ` +
            `last gets ${fmtAmount(sim.lastWalletTokens, 0)} for the same ${solPerWallet} SOL.</i>`,
        );
      }

      // the number worth stopping for, not buried in a paragraph of italics
      if (sim.priceMovePct >= 25) {
        lines.push('');
        lines.push(
          `⚠️ <b>This batch moves the price +${sim.priceMovePct.toFixed(0)}% on its own.</b>`,
        );
      }

      /*
       * The batch competing with itself. Each wallet's transaction carries the
       * slippage tolerance as a limit, and the wallets ahead of it in the same
       * batch have already moved the price. Once the cumulative move exceeds
       * that tolerance the later transactions revert on arrival — the operator
       * pays the fees and gets no fill, with nothing on screen having warned
       * them their own settings were in conflict.
       */
      if (sim.priceMovePct > settings.slippagePercent) {
        lines.push('');
        lines.push(
          `🚨 <b>Your slippage is ${settings.slippagePercent}% but this batch moves the price ` +
            `${sim.priceMovePct.toFixed(0)}%.</b> Later wallets will revert and pay fees for nothing.`,
        );
        lines.push(
          `<i>Raise slippage above ${Math.ceil(sim.priceMovePct)}%, buy less per wallet, or use fewer wallets.</i>`,
        );
      }
    }
  } catch {
    /* quoting is a nicety; never block the trade on it */
  }

  const run = async (confirmCtx: Context) => {
    await executeBuy(confirmCtx, mint, solPerWallet, wallets, settings);
  };

  if (!config.safety.requireConfirmation) {
    await run(ctx);
    return;
  }

  const id = stageConfirmation(ctx.from!.id, `buy ${solPerWallet} SOL × ${wallets.length}`, run);
  await render(ctx, lines.join('\n'), confirmKeyboard(id, `tokeninfo:${tokenId(mint)}`));
}

async function executeBuy(
  ctx: Context,
  mint: string,
  solPerWallet: number,
  wallets: WalletRecord[],
  settings: Settings,
): Promise<void> {
  return withExecution(() => executeBuyLocked(ctx, mint, solPerWallet, wallets, settings));
}

async function executeBuyLocked(
  ctx: Context,
  mint: string,
  solPerWallet: number,
  wallets: WalletRecord[],
  settings: Settings,
): Promise<void> {
  const request: TradeRequest = {
    action: 'buy',
    mint,
    amount: solPerWallet,
    denominatedInSol: true,
    slippagePercent: settings.slippagePercent,
    priorityFeeSol: settings.priorityFeeSol,
    pool: 'auto',
  };

  await render(ctx, `<b>🟢 Buying across ${wallets.length} wallets…</b>`);

  // Tokens received are measured, not quoted: the entry price every auto-sell
  // rule is measured against comes from what the batch actually acquired.
  const buyAddresses = wallets.map(w => w.address);
  const accountAddresses = [...new Set([...buyAddresses, ...allWallets().map(w => w.address)])];
  const heldBefore = await getMintBalances(accountAddresses, mint).catch(() => undefined);
  const decimals = await getMintDecimals(mint).catch(() => undefined);

  try {
    const summary = await batchPumpTrade(
      wallets,
      request,
      settings.executionMode,
      throttledProgress(ctx, `Buying ${solPerWallet} SOL per wallet`),
    );

    db.appendTradeLog({
      at: Date.now(),
      action: `buy ${solPerWallet} SOL`,
      mint,
      walletCount: wallets.length,
      succeeded: summary.succeeded,
      failed: summary.failed,
    });

    // cost basis: only the wallets that actually filled spent anything
    const { uncertain } = classifyFills(summary);
    if (uncertain) db.invalidateBasis(mint);

    const bought = await getTokenInfo(mint, 'solana').catch(() => null);
    await recordMeasuredBuy(
      {
        mint,
        summary,
        solPerWallet,
        before: heldBefore,
        decimals,
        symbol: bought?.symbol,
      },
      { ledger: db, measureTokensGained },
    );

    await render(
      ctx,
      renderBatchSummary(`🟢 Bought ${solPerWallet} SOL × ${wallets.length}`, summary) +
        (uncertain
          ? '\n\n<i>Some trades may still land. Entry basis is unknown; check the wallets before another order.</i>'
          : ''),
      new InlineKeyboard()
        .text('🔄 Token', `tokeninfo:${tokenId(mint)}`)
        .text('🪙 Positions', 'positions')
        .row()
        .text('← Menu', 'home'),
    );
  } catch (err) {
    await render(ctx, `❌ Batch buy failed.\n\n<i>${h(errMessage(err))}</i>`, backButton());
  }
}

// ── selling ───────────────────────────────────────────────────────────────────

export async function promptSell(ctx: Context, mint: string, percent: number): Promise<void> {
  const settings = structuredClone(db.settings());
  const wallets = structuredClone(selectWallets());

  if (wallets.length === 0) {
    await ctx.answerCallbackQuery({ text: 'No Solana wallets selected.', show_alert: true });
    return;
  }

  const lines = [
    '<b>🔴 Confirm batch sell</b>',
    '',
    `Token: <code>${h(mint)}</code>`,
    `Wallets: <b>${wallets.length}</b>`,
    `Selling: <b>${percent}%</b> of each wallet's holding`,
    `Slippage: ${settings.slippagePercent}%  ·  Mode: ${settings.executionMode}`,
  ];

  const run = async (confirmCtx: Context) => {
    await executeSell(confirmCtx, mint, percent, wallets, settings);
  };

  if (!config.safety.requireConfirmation) {
    await run(ctx);
    return;
  }

  const id = stageConfirmation(ctx.from!.id, `sell ${percent}% × ${wallets.length}`, run);
  await render(ctx, lines.join('\n'), confirmKeyboard(id, `tokeninfo:${tokenId(mint)}`));
}

async function executeSell(
  ctx: Context,
  mint: string,
  percent: number,
  wallets: WalletRecord[],
  settings: Settings,
): Promise<void> {
  return withExecution(() => executeSellLocked(ctx, mint, percent, wallets, settings));
}

async function executeSellLocked(
  ctx: Context,
  mint: string,
  percent: number,
  wallets: WalletRecord[],
  settings: Settings,
): Promise<void> {
  const request: TradeRequest = {
    action: 'sell',
    mint,
    amount: percent,
    denominatedInSol: false,
    slippagePercent: settings.slippagePercent,
    priorityFeeSol: settings.priorityFeeSol,
    pool: 'auto',
  };

  await render(ctx, `<b>🔴 Selling ${percent}% across ${wallets.length} wallets…</b>`);

  // read before the trade, so the tokens sold can be measured against it
  const addresses = wallets.map(w => w.address);
  const heldBefore = await getMintBalances(addresses, mint).catch(() => undefined);

  // Proceeds are measured, not quoted: the SOL these wallets hold before and
  // after the batch is what actually arrived, fees already deducted. A quote
  // taken beforehand would flatter every fill. The engine takes both readings
  // now, so every exit path gets it rather than only this one.
  try {
    const summary = await batchPumpTrade(
      wallets,
      request,
      settings.executionMode,
      throttledProgress(ctx, `Selling ${percent}% per wallet`),
    );

    // the engine measures this for every sell now, so the manual screen no
    // longer needs its own copy of the arithmetic — and every other exit path
    // gets the recording that only this one used to have
    const { uncertain } = classifyFills(summary);
    if (uncertain) db.invalidateBasis(mint);

    const storedPosition = db.position(mint);
    const position = storedPosition ? { ...storedPosition } : undefined;
    const decimals = position?.decimals ?? (await getMintDecimals(mint).catch(() => undefined));
    const { tokensSold } = await recordMeasuredSell(
      {
        mint,
        summary,
        before: heldBefore,
        decimals,
      },
      { ledger: db, measureTokensSold },
    );
    const sellOutcome =
      !uncertain && summary.solReceived !== undefined
        ? exitResult(position, tokensSold, summary.solReceived)
        : null;

    db.appendTradeLog({
      at: Date.now(),
      action: `sell ${percent}%`,
      mint,
      walletCount: wallets.length,
      succeeded: summary.succeeded,
      failed: summary.failed,
    });

    await render(
      ctx,
      renderBatchSummary(`🔴 Sold ${percent}% × ${wallets.length}`, summary) +
        (uncertain
          ? '\n\n<i>Some trades may still land. Entry basis and proceeds are unknown; check the wallets.</i>'
          : '') +
        (sellOutcome ? `\n\n${formatExit(sellOutcome)}` : ''),
      new InlineKeyboard()
        .text('🔄 Token', `tokeninfo:${tokenId(mint)}`)
        .text('💸 Sweep to main', 'sweep_sol_confirm')
        .row()
        .text('← Menu', 'home'),
    );
  } catch (err) {
    await render(ctx, `❌ Batch sell failed.\n\n<i>${h(errMessage(err))}</i>`, backButton());
  }
}

// ── nuclear option: sell every position everywhere ────────────────────────────

export async function promptSellEverything(ctx: Context): Promise<void> {
  const wallets = selectWallets();

  const run = async (ctx: Context) =>
    withExecution(async () => {
      await render(ctx, '<b>🔥 Selling every position…</b>\n\n<i>Discovering token accounts…</i>');

      try {
        const { mints, summaries, skipped } = await batchSellAllPositions(
          wallets,
          throttledProgress(ctx, 'Selling all positions'),
        );

        const dust =
          skipped.length > 0
            ? `\n\n<i>Left ${skipped.length} token${skipped.length === 1 ? '' : 's'} alone — this bot never bought ` +
              `${skipped.length === 1 ? 'it' : 'them'}, so ${skipped.length === 1 ? 'it is' : 'they are'} almost ` +
              'certainly airdropped. Sell one from its own screen if you actually want to.</i>'
            : '';

        if (mints.length === 0) {
          await render(
            ctx,
            `<b>🔥 Nothing to sell</b>\n\n<i>No positions this bot opened.</i>${dust}`,
            backButton(),
          );
          return;
        }

        const lines = ['<b>🔥 Sold everything</b>', ''];
        let ok = 0;
        let bad = 0;

        for (const mint of mints) {
          const s = summaries[mint];
          if (!s) continue;
          ok += s.succeeded;
          bad += s.failed;
          lines.push(`<code>${shortAddr(mint, 6, 6)}</code> — ✅ ${s.succeeded} / ❌ ${s.failed}`);
        }

        lines.push('');
        lines.push(`<b>${mints.length} tokens · ✅ ${ok} fills · ❌ ${bad} failures</b>`);
        if (dust) lines.push(dust);

        db.appendTradeLog({
          at: Date.now(),
          action: 'sell everything',
          walletCount: wallets.length,
          succeeded: ok,
          failed: bad,
          note: `${mints.length} tokens`,
        });

        await render(
          ctx,
          lines.join('\n'),
          new InlineKeyboard()
            .text('💸 Sweep SOL → main', 'sweep_sol_confirm')
            .row()
            .text('← Menu', 'home'),
        );
      } catch (err) {
        await render(ctx, `❌ ${h(errMessage(err))}`, backButton());
      }
    });

  const id = stageConfirmation(ctx.from!.id, 'sell everything', run);

  await render(
    ctx,
    [
      '<b>🔥 Sell EVERY position</b>',
      '',
      `This dumps every SPL token held by all <b>${wallets.length}</b> selected wallets, one token at a time, at ${db.settings().slippagePercent}% slippage.`,
      '',
      '<i>There is no undo. Illiquid tokens may fill badly or not at all.</i>',
    ].join('\n'),
    confirmKeyboard(id),
  );
}
