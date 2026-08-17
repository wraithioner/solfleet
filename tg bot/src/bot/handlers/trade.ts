import type { Context } from 'grammy';
import { InlineKeyboard } from 'grammy';
import { config } from '../../config.js';
import { db } from '../../store/db.js';
import { selectWallets, mainWallet } from '../../store/wallets.js';
import { getTokenInfo } from '../../services/tokeninfo.js';
import { getMintBalances, getSolBalance, LAMPORTS } from '../../chains/solana.js';
import { simulateSequentialBuys, fetchBondingCurve } from '../../trade/curve.js';
import {
  batchPumpTrade,
  batchSweepSol,
  batchSweepToken,
  batchSellAllPositions,
  batchSweepEvmNative,
} from '../../trade/engine.js';
import { planFunding, executeFunding, fundingBalances, type FundMode } from '../../trade/fund.js';
import { enabledChains } from '../../chains/evm.js';
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
import type { TradeRequest, EvmChain } from '../../types.js';

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
    if (info.chain === 'solana') {
      try {
        const wallets = selectWallets({ kind: 'solana' });
        const held = await getMintBalances(wallets.map((w) => w.address), mint);
        holdsPosition = held.size > 0;
      } catch {
        /* a failed balance read should not hide the card */
      }
    }

    let text = renderTokenCard(info);

    if (info.chain !== 'solana') {
      text += '\n\n<i>ℹ️ EVM token — batch trading is Solana-only for now. Balances and sweeps work.</i>';
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
  const wallets = selectWallets({ kind: 'solana' });

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
  const wallets = selectWallets({ kind: 'solana' });

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
  const wallets = selectWallets({ kind: 'solana' });

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
  const wallets = selectWallets({ kind: 'solana' });

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

  try {
    const summary = await batchPumpTrade(
      wallets,
      request,
      settings.executionMode,
      throttledProgress(ctx, `Selling ${percent}% per wallet`),
    );

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
  const wallets = selectWallets({ kind: 'solana' });

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
  const mainSol = mainWallet('solana');
  const mainEvm = mainWallet('evm');

  const lines = ['<b>💸 Move funds</b>', ''];
  lines.push(
    mainSol
      ? `Solana main: <b>${h(mainSol.label)}</b> <code>${shortAddr(mainSol.address, 6, 6)}</code>`
      : '<i>No Solana main wallet set.</i>',
  );
  lines.push(
    mainEvm
      ? `EVM main: <b>${h(mainEvm.label)}</b> <code>${shortAddr(mainEvm.address, 6, 6)}</code>`
      : '<i>No EVM main wallet set.</i>',
  );
  lines.push('');
  lines.push(`<i>Sweeps leave ${db.settings().sweepReserveSol} SOL in each wallet for future fees.</i>`);

  const kb = new InlineKeyboard();
  if (mainSol) kb.text('⬇️ Fund wallets from main', 'fund_menu').row();
  if (mainSol) kb.text('◎ Sweep all SOL → main', 'sweep_sol_confirm').row();
  if (mainSol) kb.text('🪙 Sweep a token → main', 'sweep_token_prompt').row();

  for (const chain of enabledChains()) {
    if (mainEvm) kb.text(`⬡ Sweep ${chain.name} → main`, `sweep_evm:${chain.key}`).row();
  }

  kb.text('← Menu', 'home');
  await render(ctx, lines.join('\n'), kb);
}

// ── funding: main wallet → every trading wallet ───────────────────────────────

export async function showFundMenu(ctx: Context): Promise<void> {
  const main = mainWallet('solana');
  if (!main) {
    await ctx.answerCallbackQuery({ text: 'Set a main Solana wallet first.', show_alert: true });
    return;
  }

  const targets = selectWallets({ kind: 'solana', excludeMain: true });

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
  const main = mainWallet('solana');
  if (!main) {
    await ctx.reply('Set a main Solana wallet first.');
    return;
  }

  const targets = selectWallets({ kind: 'solana', excludeMain: true });
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
  const main = mainWallet('solana');
  if (!main) {
    await ctx.answerCallbackQuery({ text: 'Set a main Solana wallet first.', show_alert: true });
    return;
  }

  const settings = db.settings();
  const wallets = selectWallets({ kind: 'solana', excludeMain: true });

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
  setPending(ctx.from!.id, { kind: 'send_to_address', chainKind: 'solana' });
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
  const main = mainWallet('solana');
  if (!main) {
    await ctx.reply('Set a main Solana wallet first.');
    return;
  }

  const wallets = selectWallets({ kind: 'solana', excludeMain: true });
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

export async function promptSweepEvm(ctx: Context, chain: EvmChain): Promise<void> {
  const main = mainWallet('evm');
  if (!main) {
    await ctx.answerCallbackQuery({ text: 'Set a main EVM wallet first.', show_alert: true });
    return;
  }

  const wallets = selectWallets({ kind: 'evm', excludeMain: true });
  const info = enabledChains().find((c) => c.key === chain);

  const run = async (ctx: Context) => {
    await render(ctx, `<b>⬡ Sweeping ${info?.name ?? chain}…</b>`);
    try {
      const summary = await batchSweepEvmNative(
        chain,
        wallets,
        main.address,
        throttledProgress(ctx, `Sweeping ${info?.name ?? chain}`),
      );
      await render(
        ctx,
        renderBatchSummary(`⬡ Swept ${info?.name ?? chain} → ${main.label}`, summary, chain),
        new InlineKeyboard().text('← Menu', 'home'),
      );
    } catch (err) {
      await render(ctx, `❌ ${h(errMessage(err))}`, backButton());
    }
  };

  const id = stageConfirmation(ctx.from!.id, `sweep ${chain}`, run);

  await render(
    ctx,
    [
      `<b>⬡ Sweep ${h(info?.name ?? chain)} to main wallet</b>`,
      '',
      `From: <b>${wallets.length}</b> wallets`,
      `To: <b>${h(main.label)}</b> <code>${shortAddr(main.address, 6, 6)}</code>`,
      '',
      '<i>Sends the full native balance minus gas. Wallets that cannot cover their own gas are skipped.</i>',
    ].join('\n'),
    confirmKeyboard(id, 'consolidate_menu'),
  );
}

// ── quick trade menu ──────────────────────────────────────────────────────────

export async function showTradeMenu(ctx: Context): Promise<void> {
  const settings = db.settings();
  const wallets = selectWallets({ kind: 'solana' });

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
