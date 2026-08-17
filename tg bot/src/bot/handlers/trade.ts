import type { Context } from 'grammy';
import { InlineKeyboard } from 'grammy';
import { config } from '../../config.js';
import { db } from '../../store/db.js';
import { selectWallets, mainWallet } from '../../store/wallets.js';
import { getTokenInfo } from '../../services/tokeninfo.js';
import { getSplBalances } from '../../chains/solana.js';
import { simulateSequentialBuys, fetchBondingCurve } from '../../trade/curve.js';
import {
  batchPumpTrade,
  batchSweepSol,
  batchSweepToken,
  batchSellAllPositions,
  batchSweepEvmNative,
} from '../../trade/engine.js';
import { enabledChains } from '../../chains/evm.js';
import { errMessage, fmtAmount, fmtUsd, shortAddr } from '../../util.js';
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

    // does any selected wallet already hold this? decides whether to offer sells
    let holdsPosition = false;
    if (info.chain === 'solana') {
      const wallets = selectWallets({ kind: 'solana' });
      for (const w of wallets.slice(0, 10)) {
        try {
          const held = await getSplBalances(w.address);
          if (held.some((t) => t.mint === mint && t.rawAmount > 0n)) {
            holdsPosition = true;
            break;
          }
        } catch {
          /* a single wallet failing to read should not hide the card */
        }
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
      lines.push(`Est. avg price: ${sim.avgPrice.toExponential(4)} SOL`);
      const impact = ((sim.finalPrice - (sim.totalSol / sim.totalTokens)) / sim.finalPrice) * 100;
      if (Number.isFinite(impact)) {
        lines.push(`<i>Sequential fills move the curve — later wallets pay more.</i>`);
      }
    }
  } catch {
    /* quoting is a nicety; never block the trade on it */
  }

  const run = async () => {
    await executeBuy(ctx, mint, solPerWallet);
  };

  if (!config.safety.requireConfirmation) {
    await run();
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

  const run = async () => {
    await executeSell(ctx, mint, percent);
  };

  if (!config.safety.requireConfirmation) {
    await run();
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

  const run = async () => {
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

  const lines = ['<b>💸 Consolidate</b>', ''];
  lines.push(
    mainSol
      ? `Solana destination: <b>${h(mainSol.label)}</b> <code>${shortAddr(mainSol.address, 6, 6)}</code>`
      : '<i>No Solana main wallet set.</i>',
  );
  lines.push(
    mainEvm
      ? `EVM destination: <b>${h(mainEvm.label)}</b> <code>${shortAddr(mainEvm.address, 6, 6)}</code>`
      : '<i>No EVM main wallet set.</i>',
  );
  lines.push('');
  lines.push(`<i>Each wallet keeps ${db.settings().sweepReserveSol} SOL back for future fees.</i>`);

  const kb = new InlineKeyboard();
  if (mainSol) kb.text('◎ Sweep all SOL → main', 'sweep_sol_confirm').row();
  if (mainSol) kb.text('🪙 Sweep a token → main', 'sweep_token_prompt').row();

  for (const chain of enabledChains()) {
    if (mainEvm) kb.text(`⬡ Sweep ${chain.name} → main`, `sweep_evm:${chain.key}`).row();
  }

  kb.text('← Menu', 'home');
  await render(ctx, lines.join('\n'), kb);
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

  const run = async () => {
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

  const run = async () => {
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
