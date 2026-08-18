import type { Context } from 'grammy';
import { InlineKeyboard } from 'grammy';
import { config } from '../../config.js';
import { db } from '../../store/db.js';
import { selectWallets, mainWallet } from '../../store/wallets.js';
import { getTokenInfo, extractTokenAddress } from '../../services/tokeninfo.js';
import { getSolPrice } from '../../services/prices.js';
import { positionPnl, formatPnl } from '../../services/pnl.js';
import { getMintBalances, getSolBalance, LAMPORTS } from '../../chains/solana.js';
import { simulateSequentialBuys, fetchBondingCurve } from '../../trade/curve.js';
import {
  batchPumpTrade,
  batchSweepSol,
  batchSweepToken,
  batchSellAllPositions,
} from '../../trade/engine.js';
import {
  planFunding,
  executeFunding,
  fundingBalances,
  partitionByBalance,
  requiredForBuy,
  type FundMode,
} from '../../trade/fund.js';
import { errMessage, fmtAmount, shortAddr } from '../../util.js';
import { log } from '../../logger.js';
import { stageConfirmation, setPending, tokenId, mintFromId } from '../session.js';
import {
  renderTokenCard,
  tokenKeyboard,
  renderHolders,
  renderBatchSummary,
  confirmKeyboard,
  backButton,
  progressBarText,
  h,
} from '../ui.js';
import { render } from './core.js';
import { newRuleId, entryPriceSol, describe as describeRule } from '../../services/watcher.js';
import { priceInSol } from '../../services/price.js';
import type { TradeRequest } from '../../types.js';

/**
 * Telegram rate limits message edits hard. Batches of 50 wallets would otherwise
 * generate 50 edits and get the bot throttled mid-execution, so progress updates
 * are coalesced to at most one every 1.5 seconds.
 */
function throttledProgress(ctx: Context, title: string) {
  let last = 0;
  return async (done: number, total: number, note?: string) => {
    const now = Date.now();
    if (now - last < 1500 && done < total) return;
    last = now;

    const text = [
      `<b>${h(title)}</b>`,
      '',
      progressBarText(done, total),
      note ? `<i>${h(note)}</i>` : '',
    ]
      .filter(Boolean)
      .join('\n');

    await render(ctx, text).catch(() => {});
  };
}

// ── token info card ───────────────────────────────────────────────────────────

export async function showTokenCard(ctx: Context, mint: string, replace = false): Promise<void> {
  const loading = '<b>🔎 Looking up token…</b>';

  if (replace) await render(ctx, loading);
  else await ctx.reply(loading, { parse_mode: 'HTML' });

  try {
    const info = await getTokenInfo(mint, mint.startsWith('0x') ? 'evm' : 'solana');
    const settings = db.settings();

    // Does any selected wallet already hold this? Decides whether to offer
    // sells. Reading the derived token accounts in one batched call covers
    // every wallet, where the old per-wallet scan covered the first ten and
    // cost ten sequential round trips to do it.
    let holdsPosition = false;
    let heldRaw = 0n;
    if (info.chain === 'solana') {
      try {
        const wallets = selectWallets();
        const held = await getMintBalances(wallets.map((w) => w.address), mint);
        holdsPosition = held.size > 0;
        for (const amount of held.values()) heldRaw += amount;
      } catch {
        /* a failed balance read should not hide the card */
      }
    }

    const heldTokens = Number(heldRaw) / 10 ** (info.decimals ?? 6);
    const solPriceUsd = await getSolPrice().catch(() => 0);

    let text = renderTokenCard(info);

    // what this position has cost and returned, if it was bought through here
    const record = db.position(mint);
    if (record && record.investedSol > 0) {
      const heldSol =
        info.priceUsd !== undefined && solPriceUsd > 0
          ? (heldTokens * info.priceUsd) / solPriceUsd
          : 0;
      const pnl = positionPnl(record, heldSol);
      text +=
        `\n\n<b>📒 Your position</b>\n` +
        `In ${pnl.investedSol.toFixed(3)} · back ${pnl.realisedSol.toFixed(3)} · held ${heldSol.toFixed(3)} SOL\n` +
        `${formatPnl(pnl)}`;
    }

    if (info.chain !== 'solana') {
      text += '\n\n<i>ℹ️ Research only — this bot holds and trades Solana wallets. It cannot buy this.</i>';
    }

    const keyboard =
      info.chain === 'solana' ? tokenKeyboard(mint, settings, holdsPosition) : backButton();

    // Attaching the logo as a link preview keeps the full 4096-char budget,
    // where a photo caption would cap the card at 1024.
    const linkPreview = info.imageUrl
      ? { url: info.imageUrl, prefer_small_media: true, show_above_text: true }
      : { is_disabled: true };

    if (info.imageUrl) text = `<a href="${h(info.imageUrl)}">​</a>${text}`;

    const opts = {
      parse_mode: 'HTML' as const,
      reply_markup: keyboard,
      link_preview_options: linkPreview,
    };

    if (replace && ctx.callbackQuery?.message) {
      await ctx.editMessageText(text, opts).catch(async () => {
        await ctx.reply(text, opts);
      });
    } else {
      await ctx.reply(text, opts);
    }
  } catch (err) {
    log.error(`Token lookup failed for ${mint}`, err);
    const msg = `❌ Could not load that token.\n\n<i>${h(errMessage(err))}</i>`;
    if (replace) await render(ctx, msg, backButton());
    else await ctx.reply(msg, { parse_mode: 'HTML' });
  }
}

export async function showHolders(ctx: Context, mint: string): Promise<void> {
  await render(ctx, '<b>👥 Loading holder distribution…</b>');
  try {
    const info = await getTokenInfo(mint, 'solana');
    await render(
      ctx,
      renderHolders(info),
      new InlineKeyboard().text('← Back to token', `tokeninfo:${tokenId(mint)}`),
    );
  } catch (err) {
    await render(ctx, `❌ ${h(errMessage(err))}`, backButton());
  }
}

// ── buying ────────────────────────────────────────────────────────────────────

export async function promptBuy(ctx: Context, mint: string, solPerWallet: number): Promise<void> {
  const settings = db.settings();
  const wallets = selectWallets();

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
    const balances = await fundingBalances(wallets.map((w) => w.address));
    const { unfunded } = partitionByBalance(
      wallets,
      balances,
      requiredForBuy(solPerWallet, settings.priorityFeeSol),
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
      lines.push(`Price after: ${sim.finalPrice.toExponential(4)} SOL (<b>+${sim.priceMovePct.toFixed(1)}%</b>)`);

      if (wallets.length > 1) {
        lines.push(
          `<i>First wallet gets ${fmtAmount(sim.firstWalletTokens, 0)}, ` +
            `last gets ${fmtAmount(sim.lastWalletTokens, 0)} for the same ${solPerWallet} SOL.</i>`,
        );
      }

      // the number worth stopping for, not buried in a paragraph of italics
      if (sim.priceMovePct >= 25) {
        lines.push('');
        lines.push(`⚠️ <b>This batch moves the price +${sim.priceMovePct.toFixed(0)}% on its own.</b>`);
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
    await executeBuy(confirmCtx, mint, solPerWallet);
  };

  if (!config.safety.requireConfirmation) {
    await run(ctx);
    return;
  }

  const id = stageConfirmation(ctx.from!.id, `buy ${solPerWallet} SOL × ${wallets.length}`, run);
  await render(ctx, lines.join('\n'), confirmKeyboard(id, `tokeninfo:${tokenId(mint)}`));
}

async function executeBuy(ctx: Context, mint: string, solPerWallet: number): Promise<void> {
  const settings = db.settings();
  const wallets = selectWallets();

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
  const buyAddresses = wallets.map((w) => w.address);
  const heldBefore = await getMintBalances(buyAddresses, mint).catch(() => undefined);

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
    const fills = summary.results.filter((r) => r.ok && r.signature).length;

    let tokensGained = 0;
    if (heldBefore) {
      const heldAfter = await getMintBalances(buyAddresses, mint).catch(() => undefined);
      if (heldAfter) {
        let deltaRaw = 0n;
        for (const [address, after] of heldAfter) deltaRaw += after - (heldBefore.get(address) ?? 0n);
        if (deltaRaw > 0n) {
          const info = await getTokenInfo(mint, 'solana').catch(() => null);
          tokensGained = Number(deltaRaw) / 10 ** (info?.decimals ?? 6);
        }
      }
    }

    db.recordBuy(mint, solPerWallet * fills, fills, tokensGained);

    await render(
      ctx,
      renderBatchSummary(`🟢 Bought ${solPerWallet} SOL × ${wallets.length}`, summary),
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
  const settings = db.settings();
  const wallets = selectWallets();

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
    await executeSell(confirmCtx, mint, percent);
  };

  if (!config.safety.requireConfirmation) {
    await run(ctx);
    return;
  }

  const id = stageConfirmation(ctx.from!.id, `sell ${percent}% × ${wallets.length}`, run);
  await render(ctx, lines.join('\n'), confirmKeyboard(id, `tokeninfo:${tokenId(mint)}`));
}

async function executeSell(ctx: Context, mint: string, percent: number): Promise<void> {
  const settings = db.settings();
  const wallets = selectWallets();

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

  // Proceeds are measured, not quoted: the SOL these wallets hold before and
  // after the batch is what actually arrived, fees already deducted. A quote
  // taken beforehand would flatter every fill.
  const addresses = wallets.map((w) => w.address);
  const solBefore = await fundingBalances(addresses).catch(() => undefined);

  try {
    const summary = await batchPumpTrade(
      wallets,
      request,
      settings.executionMode,
      throttledProgress(ctx, `Selling ${percent}% per wallet`),
    );

    if (solBefore) {
      const solAfter = await fundingBalances(addresses).catch(() => undefined);
      if (solAfter) {
        let delta = 0n;
        for (const [address, after] of solAfter) delta += after - (solBefore.get(address) ?? 0n);
        const fills = summary.results.filter((r) => r.ok && r.signature).length;
        if (delta > 0n) db.recordSell(mint, Number(delta) / LAMPORTS, fills);
      }
    }

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
      renderBatchSummary(`🔴 Sold ${percent}% × ${wallets.length}`, summary),
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

  const run = async (ctx: Context) => {
    await render(ctx, '<b>🔥 Selling every position…</b>\n\n<i>Discovering token accounts…</i>');

    try {
      const { mints, summaries } = await batchSellAllPositions(
        wallets,
        throttledProgress(ctx, 'Selling all positions'),
      );

      if (mints.length === 0) {
        await render(ctx, '<b>🔥 Nothing to sell</b>\n\n<i>No token positions found.</i>', backButton());
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
        new InlineKeyboard().text('💸 Sweep SOL → main', 'sweep_sol_confirm').row().text('← Menu', 'home'),
      );
    } catch (err) {
      await render(ctx, `❌ ${h(errMessage(err))}`, backButton());
    }
  };

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

// ── consolidation ─────────────────────────────────────────────────────────────

export async function showConsolidateMenu(ctx: Context): Promise<void> {
  const mainSol = mainWallet();

  const lines = ['<b>💸 Move funds</b>', ''];
  lines.push(
    mainSol
      ? `Solana main: <b>${h(mainSol.label)}</b> <code>${shortAddr(mainSol.address, 6, 6)}</code>`
      : '<i>No Solana main wallet set.</i>',
  );
  lines.push('');
  lines.push(`<i>Sweeps leave ${db.settings().sweepReserveSol} SOL in each wallet for future fees.</i>`);

  const kb = new InlineKeyboard();
  if (mainSol) kb.text('⬇️ Fund wallets from main', 'fund_menu').row();
  if (mainSol) kb.text('◎ Sweep all SOL → main', 'sweep_sol_confirm').row();
  if (mainSol) kb.text('🪙 Sweep a token → main', 'sweep_token_prompt').row();


  kb.text('← Menu', 'home');
  await render(ctx, lines.join('\n'), kb);
}

// ── funding: main wallet → every trading wallet ───────────────────────────────

export async function showFundMenu(ctx: Context): Promise<void> {
  const main = mainWallet();
  if (!main) {
    await ctx.answerCallbackQuery({ text: 'Set a main Solana wallet first.', show_alert: true });
    return;
  }

  const targets = selectWallets({ excludeMain: true });

  let balanceLine = '';
  try {
    const { sol } = await getSolBalance(main.address);
    balanceLine = `Main wallet holds <b>${fmtAmount(sol, 4)} SOL</b>`;
  } catch {
    balanceLine = '<i>Could not read the main wallet balance.</i>';
  }

  await render(
    ctx,
    [
      '<b>⬇️ Fund wallets from main</b>',
      '',
      balanceLine,
      `Targets: <b>${targets.length}</b> wallets${db.settings().activeGroup ? ` in <i>${h(db.settings().activeGroup!)}</i>` : ''}`,
      '',
      '<b>Send each</b> — every wallet receives the same amount, on top of whatever it already has.',
      '<b>Top up each to</b> — every wallet is brought <i>up to</i> the amount. Wallets already there are skipped.',
      '',
      '<i>Transfers are packed into batched transactions, so fifty wallets cost a handful of fees rather than fifty.</i>',
    ].join('\n'),
    new InlineKeyboard()
      .text('◎ Send each…', 'fund:each')
      .text('◎ Top up each to…', 'fund:topup')
      .row()
      .text('← Back', 'consolidate_menu'),
  );
}

export async function promptFundAmount(ctx: Context, mode: FundMode): Promise<void> {
  setPending(ctx.from!.id, { kind: 'fund_amount', mode });

  await render(
    ctx,
    mode === 'each'
      ? '<b>⬇️ Send how much SOL to each wallet?</b>\n\n<i>e.g. 0.1</i>'
      : '<b>⬇️ Top every wallet up to how much SOL?</b>\n\n<i>e.g. 0.5 — wallets already holding that much are skipped.</i>',
    backButton('fund_menu'),
  );
}

export async function promptFund(ctx: Context, mode: FundMode, sol: number): Promise<void> {
  const main = mainWallet();
  if (!main) {
    await ctx.reply('Set a main Solana wallet first.');
    return;
  }

  const targets = selectWallets({ excludeMain: true });
  if (targets.length === 0) {
    await ctx.reply('No wallets to fund. Generate or derive some first.');
    return;
  }

  const settings = db.settings();

  let plan;
  try {
    const [balances, source] = await Promise.all([
      // a top-up needs to know what each wallet already holds; sending a flat
      // amount does not, but the numbers cost one call either way
      fundingBalances(targets.map((w) => w.address)),
      getSolBalance(main.address),
    ]);

    plan = planFunding({
      targets,
      balances,
      mode,
      sol,
      sourceLamports: source.lamports,
      priorityFeeSol: settings.priorityFeeSol,
      reserveSol: settings.sweepReserveSol,
    });
  } catch (err) {
    await ctx.reply(`❌ ${errMessage(err)}`, { reply_markup: backButton('fund_menu') });
    return;
  }

  if (plan.transfers.length === 0) {
    await ctx.reply(
      mode === 'topup'
        ? `Every wallet already holds at least ${sol} SOL. Nothing to do.`
        : 'Nothing to send — the amount is below the transfer fee.',
      { reply_markup: backButton('fund_menu') },
    );
    return;
  }

  const total = Number(plan.totalLamports) / LAMPORTS;
  const fees = Number(plan.feeLamports) / LAMPORTS;

  const lines = [
    '<b>⬇️ Confirm funding</b>',
    '',
    `From: <b>${h(main.label)}</b> <code>${shortAddr(main.address, 6, 6)}</code>`,
    `To: <b>${plan.transfers.length}</b> wallets`,
    mode === 'each'
      ? `Amount: <b>${sol} SOL</b> each`
      : `Topping up to: <b>${sol} SOL</b> each`,
    `Total: <b>${fmtAmount(total, 6)} SOL</b> + ~${fmtAmount(fees, 6)} SOL fees`,
    `Transactions: ${plan.txCount}`,
  ];

  if (plan.skipped.length > 0) {
    lines.push('');
    lines.push(`<i>${plan.skipped.length} wallet${plan.skipped.length === 1 ? '' : 's'} skipped — already funded.</i>`);
  }

  const run = async (ctx: Context) => {
    await render(ctx, `<b>⬇️ Funding ${plan.transfers.length} wallets…</b>`);

    try {
      const summary = await executeFunding(
        main,
        plan,
        settings.priorityFeeSol,
        throttledProgress(ctx, 'Funding wallets'),
      );

      db.appendTradeLog({
        at: Date.now(),
        action: mode === 'each' ? `fund ${sol} SOL each` : `top up to ${sol} SOL`,
        walletCount: plan.transfers.length,
        succeeded: summary.succeeded,
        failed: summary.failed,
      });

      await render(
        ctx,
        renderBatchSummary(`⬇️ Funded ${plan.transfers.length} wallets`, summary),
        new InlineKeyboard().text('💼 Portfolio', 'portfolio').row().text('← Menu', 'home'),
      );
    } catch (err) {
      await render(ctx, `❌ ${h(errMessage(err))}`, backButton('fund_menu'));
    }
  };

  if (!config.safety.requireConfirmation) {
    await run(ctx);
    return;
  }

  const id = stageConfirmation(ctx.from!.id, `fund ${plan.transfers.length} wallets`, run);
  await ctx.reply(lines.join('\n'), {
    parse_mode: 'HTML',
    reply_markup: confirmKeyboard(id, 'fund_menu'),
  });
}

export async function promptSweepSol(ctx: Context): Promise<void> {
  const main = mainWallet();
  if (!main) {
    await ctx.answerCallbackQuery({ text: 'Set a main Solana wallet first.', show_alert: true });
    return;
  }

  const settings = db.settings();
  const wallets = selectWallets({ excludeMain: true });

  if (wallets.length === 0) {
    await ctx.answerCallbackQuery({ text: 'No wallets to sweep from.', show_alert: true });
    return;
  }

  const run = async (ctx: Context) => {
    await render(ctx, `<b>💸 Sweeping ${wallets.length} wallets…</b>`);
    try {
      const summary = await batchSweepSol(wallets, main.address, throttledProgress(ctx, 'Sweeping SOL'));

      db.appendTradeLog({
        at: Date.now(),
        action: 'sweep SOL',
        walletCount: wallets.length,
        succeeded: summary.succeeded,
        failed: summary.failed,
      });

      await render(
        ctx,
        renderBatchSummary(`💸 Swept SOL → ${main.label}`, summary),
        new InlineKeyboard().text('💼 Portfolio', 'portfolio').row().text('← Menu', 'home'),
      );
    } catch (err) {
      await render(ctx, `❌ ${h(errMessage(err))}`, backButton());
    }
  };

  const id = stageConfirmation(ctx.from!.id, 'sweep SOL', run);

  await render(
    ctx,
    [
      '<b>💸 Sweep all SOL to main wallet</b>',
      '',
      `From: <b>${wallets.length}</b> wallets`,
      `To: <b>${h(main.label)}</b> <code>${shortAddr(main.address, 6, 6)}</code>`,
      `Reserve kept per wallet: <b>${settings.sweepReserveSol} SOL</b>`,
      '',
      '<i>Wallets holding less than the fee are skipped, not failed.</i>',
    ].join('\n'),
    confirmKeyboard(id),
  );
}

export async function promptSweepToken(ctx: Context): Promise<void> {
  setPending(ctx.from!.id, { kind: 'send_to_address' });
  await render(
    ctx,
    [
      '<b>🪙 Sweep a token to the main wallet</b>',
      '',
      'Send the token mint address now.',
      '',
      '<i>Every selected wallet transfers its full balance of that token, and the emptied token account is closed to reclaim its rent.</i>',
    ].join('\n'),
    backButton('consolidate_menu'),
  );
}

export async function executeSweepToken(ctx: Context, mint: string): Promise<void> {
  const main = mainWallet();
  if (!main) {
    await ctx.reply('Set a main Solana wallet first.');
    return;
  }

  const wallets = selectWallets({ excludeMain: true });
  const msg = await ctx.reply(`<b>🪙 Sweeping token across ${wallets.length} wallets…</b>`, {
    parse_mode: 'HTML',
  });

  try {
    const summary = await batchSweepToken(wallets, mint, main.address);
    await ctx.api.editMessageText(
      msg.chat.id,
      msg.message_id,
      renderBatchSummary(`🪙 Swept token → ${main.label}`, summary),
      { parse_mode: 'HTML', reply_markup: new InlineKeyboard().text('← Menu', 'home') },
    );
  } catch (err) {
    await ctx.reply(`❌ ${errMessage(err)}`);
  }
}

// ── quick trade menu ──────────────────────────────────────────────────────────

export async function showTradeMenu(ctx: Context): Promise<void> {
  const settings = db.settings();
  const wallets = selectWallets();

  setPending(ctx.from!.id, { kind: 'manual_token_lookup' });

  await render(
    ctx,
    [
      '<b>⚡ Quick trade</b>',
      '',
      `Batch target: <b>${wallets.length}</b> Solana wallets`,
      `Slippage <b>${settings.slippagePercent}%</b> · Priority <b>${settings.priorityFeeSol} SOL</b> · Mode <b>${settings.executionMode}</b>`,
      '',
      'Send a token address and I will pull up its stats with buy and sell buttons.',
    ].join('\n'),
    backButton(),
  );
}

export { mintFromId };


// ── auto-sell rules ───────────────────────────────────────────────────────────

/** Presets chosen to cover the usual memecoin exits without typing anything. */
const TP_PRESETS = [50, 100, 200, 500];
const SL_PRESETS = [-20, -35, -50];
const TRAIL_PRESETS = [-15, -25, -40];

export async function showAutoSell(ctx: Context, mint: string): Promise<void> {
  const id = tokenId(mint);
  const rules = db.rulesFor(mint);
  const entry = entryPriceSol(mint);
  const price = await priceInSol(mint).catch(() => null);

  const lines = ['<b>🎯 Auto-sell</b>', ''];

  if (entry === null) {
    lines.push('<i>No entry price recorded for this token, so take-profit and stop-loss have nothing to measure against.</i>');
    lines.push('');
    lines.push('<i>Buy it through the bot first — a trailing stop works regardless, since it tracks the high rather than your entry.</i>');
  } else {
    lines.push(`Entry: <b>${entry.toExponential(4)} SOL</b>`);
    if (price !== null) {
      const move = ((price - entry) / entry) * 100;
      lines.push(`Now: <b>${price.toExponential(4)} SOL</b> (${move >= 0 ? '+' : ''}${move.toFixed(1)}%)`);
    }
  }

  if (rules.length > 0) {
    lines.push('');
    lines.push('<b>Armed:</b>');
    for (const r of rules) lines.push(`· ${describeRule(r)} → sell ${r.sellPercent}%`);
  }

  lines.push('');
  lines.push('<i>Rules are checked every 20 seconds and survive restarts. A rule fires once.</i>');

  const kb = new InlineKeyboard();
  for (const pct of TP_PRESETS) kb.text(`🎯 +${pct}%`, `rule:tp:${id}:${pct}`);
  kb.row();
  for (const pct of SL_PRESETS) kb.text(`🛑 ${pct}%`, `rule:sl:${id}:${pct}`);
  kb.row();
  for (const pct of TRAIL_PRESETS) kb.text(`📉 trail ${pct}%`, `rule:trail:${id}:${pct}`);
  kb.row();
  if (rules.length > 0) kb.text('🗑 Clear all rules', `rule:clear:${id}:0`).row();
  kb.text('← Back to token', `tokeninfo:${id}`);

  await render(ctx, lines.join('\n'), kb);
}

export async function addAutoRule(
  ctx: Context,
  mint: string,
  kind: 'take_profit' | 'stop_loss' | 'trailing_stop',
  triggerPct: number,
): Promise<void> {
  // A take-profit or stop-loss is measured from entry; without one there is
  // nothing to measure and the rule would never fire correctly.
  if (kind !== 'trailing_stop' && entryPriceSol(mint) === null) {
    await ctx.answerCallbackQuery({
      text: 'No entry price recorded — buy through the bot first, or use a trailing stop.',
      show_alert: true,
    });
    return;
  }

  const info = await getTokenInfo(mint, 'solana').catch(() => null);
  const peak = kind === 'trailing_stop' ? ((await priceInSol(mint).catch(() => null)) ?? undefined) : undefined;

  db.addRule({
    id: newRuleId(),
    mint,
    symbol: info?.symbol,
    kind,
    triggerPct,
    // A stop-loss that sells half is a half-measure; exits default to the whole
    // position, and take-profit to half so the rest can keep running.
    sellPercent: kind === 'take_profit' ? 50 : 100,
    peakPriceSol: peak,
    enabled: true,
    createdAt: Date.now(),
  });

  await ctx.answerCallbackQuery({ text: 'Rule armed.' });
  return showAutoSell(ctx, mint);
}

export async function clearAutoRules(ctx: Context, mint: string): Promise<void> {
  for (const r of db.rulesFor(mint)) db.removeRule(r.id);
  await ctx.answerCallbackQuery({ text: 'Rules cleared.' });
  return showAutoSell(ctx, mint);
}


// ── copy trading ──────────────────────────────────────────────────────────────

export async function showCopyTrade(ctx: Context): Promise<void> {
  const targets = db.copyTargets();

  const lines = ['<b>👥 Copy trading</b>', ''];

  if (targets.length === 0) {
    lines.push('<i>No wallets followed yet.</i>');
  } else {
    for (const t of targets) {
      lines.push(
        `${t.enabled ? '▶️' : '⏸'} <b>${h(t.label)}</b> <code>${shortAddr(t.address, 4, 4)}</code>`,
      );
      lines.push(
        `   ${t.buySol} SOL per wallet · ${t.copySells ? 'copies exits too' : 'entries only'} · ${t.copiedMints.length} copied`,
      );
    }
  }

  lines.push('');
  lines.push('<b>Read this before following anyone.</b>');
  lines.push(
    '<i>The bot polls their wallet every 20 seconds, so your copy lands seconds behind theirs — on a memecoin, that is often the whole move. This follows a trader; it cannot race one.</i>',
  );
  lines.push('');
  lines.push(
    `<i>Each buy is mirrored at your configured size across all ${selectWallets().length} wallets, once per token. Their sells are mirrored proportionally if enabled.</i>`,
  );

  const kb = new InlineKeyboard().text('➕ Follow a wallet', 'copy_add').row();
  for (const t of targets.slice(0, 8)) {
    kb.text(`${t.enabled ? '⏸ Pause' : '▶️ Resume'} ${t.label}`, `copy_toggle:${t.id}`)
      .text('🗑', `copy_remove:${t.id}`)
      .row();
  }
  kb.text('← Menu', 'home');

  await render(ctx, lines.join('\n'), kb);
}

export async function promptCopyAdd(ctx: Context): Promise<void> {
  setPending(ctx.from!.id, { kind: 'copy_address' });
  await render(
    ctx,
    [
      '<b>👥 Send the wallet address to follow.</b>',
      '',
      '<i>A Solana address. Their buys will be mirrored across your wallets at the size you set next.</i>',
    ].join('\n'),
    backButton('copy_trade'),
  );
}

export async function handleCopyAddress(ctx: Context, text: string): Promise<void> {
  const token = extractTokenAddress(text);
  if (!token || token.kind !== 'solana') {
    await ctx.reply('That is not a valid Solana address.');
    return;
  }

  if (db.copyTargets().some((t) => t.address === token.address)) {
    await ctx.reply('Already following that wallet.');
    return;
  }

  setPending(ctx.from!.id, { kind: 'copy_size', address: token.address });
  await ctx.reply(
    [
      `<b>Following</b> <code>${shortAddr(token.address, 6, 6)}</code>`,
      '',
      'How much SOL should each of your wallets buy when they buy?',
      '',
      `<i>e.g. 0.05 — across ${selectWallets().length} wallets that is ${(0.05 * selectWallets().length).toFixed(3)} SOL per copied trade.</i>`,
    ].join('\n'),
    { parse_mode: 'HTML' },
  );
}

export async function handleCopySize(ctx: Context, address: string, buySol: number): Promise<void> {
  if (buySol > config.safety.maxBuySolPerWallet) {
    await ctx.reply(`That exceeds the per-wallet cap of ${config.safety.maxBuySolPerWallet} SOL.`);
    return;
  }

  db.addCopyTarget({
    id: newRuleId(),
    address,
    label: shortAddr(address, 4, 4),
    buySol,
    copySells: true,
    enabled: true,
    copiedMints: [],
    createdAt: Date.now(),
  });

  await ctx.reply(
    [
      '✅ <b>Now following.</b>',
      '',
      `<code>${shortAddr(address, 6, 6)}</code> · ${buySol} SOL per wallet`,
      '',
      '<i>Their existing positions are ignored — only trades from now on are mirrored.</i>',
    ].join('\n'),
    { parse_mode: 'HTML', reply_markup: new InlineKeyboard().text('👥 Copy trading', 'copy_trade') },
  );
}

export async function toggleCopyTarget(ctx: Context, id: string): Promise<void> {
  const t = db.copyTargets().find((x) => x.id === id);
  if (!t) return;
  db.updateCopyTarget(id, { enabled: !t.enabled });
  await ctx.answerCallbackQuery({ text: t.enabled ? 'Paused' : 'Resumed' });
  return showCopyTrade(ctx);
}

export async function removeCopyTarget(ctx: Context, id: string): Promise<void> {
  db.removeCopyTarget(id);
  await ctx.answerCallbackQuery({ text: 'Unfollowed' });
  return showCopyTrade(ctx);
}
