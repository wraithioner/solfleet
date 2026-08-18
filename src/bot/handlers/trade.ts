import type { Context } from 'grammy';
import { InlineKeyboard } from 'grammy';
import { config } from '../../config.js';
import { db, type CopyTarget, type CopyExitMode } from '../../store/db.js';
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
import { describeLimits } from '../../services/safety.js';
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
    const balances = await fundingBalances(wallets.map((w) => w.address));
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

  await render(ctx, '<b>⬇️ Fund wallets from main</b>\n\n<i>Reading balances…</i>');

  const targets = selectWallets({ excludeMain: true });

  let balanceLine = '';
  try {
    const { sol } = await getSolBalance(main.address);
    balanceLine = `Main wallet holds <b>${fmtAmount(sol, 4)} SOL</b>`;
  } catch {
    balanceLine = '<i>Could not read the main wallet balance.</i>';
  }

  const settings = db.settings();
  const buyPreset = settings.quickBuyPresets[0] ?? 0.05;
  const neededPerWallet = requiredForBuy(buyPreset, settings.priorityFeeSol, {
    jitoTipSol: settings.executionMode === 'bundle' ? settings.jitoTipSol : 0,
  });

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
      // funding a wallet with exactly the buy size is the classic mistake: it
      // fills, and then there is nothing left to pay for the way out
      `<i>To buy <b>${buyPreset}</b> SOL a wallet needs <b>${fmtAmount(Number(neededPerWallet) / LAMPORTS, 4)}</b> — ` +
        'the trade, its fees, the token account rent, and enough kept back to sell.</i>',
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
/** Buy the dip: how far below the current price to place the order. */
const DIP_PRESETS = [-20, -35, -50];
/** Sell into strength: how far above the current price. */
const LIMIT_SELL_PRESETS = [50, 100, 300];

export async function showAutoSell(ctx: Context, mint: string): Promise<void> {
  await render(ctx, '<b>🤖 Automation</b>\n\n<i>Reading the price…</i>');

  const id = tokenId(mint);
  const rules = db.rulesFor(mint);
  const entry = entryPriceSol(mint);
  const price = await priceInSol(mint).catch(() => null);
  const plans = db.dcaPlans().filter((p) => p.mint === mint && p.enabled);

  const lines = ['<b>🤖 Automation</b>', ''];

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
    for (const r of rules) lines.push(`· ${describeRule(r)}`);
  }

  if (plans.length > 0) {
    lines.push('');
    lines.push('<b>Averaging in:</b>');
    for (const p of plans) {
      lines.push(`· ${p.buySol} SOL every ${p.intervalMinutes}m — round ${p.roundsDone}/${p.roundsTotal}`);
    }
  }

  lines.push('');
  lines.push('<i>Checked every 20 seconds; rules survive restarts and fire once.</i>');
  lines.push('<i>Limit prices are fixed from the price shown above when you tap.</i>');

  const kb = new InlineKeyboard()
    .text('🎯 Take profit', `rmenu:tp:${id}`).text('🛑 Stop loss', `rmenu:sl:${id}`)
    .row()
    .text('📉 Trailing stop', `rmenu:trail:${id}`).text('💰 Buy the dip', `rmenu:dip:${id}`)
    .row()
    .text('🚀 Limit sell', `rmenu:lsell:${id}`).text('🔁 DCA', `dca_add:${id}`)
    .row();

  if (rules.length > 0 || plans.length > 0) kb.text('🗑 Clear all', `rule:clear:${id}:0`).row();
  kb.text('← Back to token', `tokeninfo:${id}`);

  await render(ctx, lines.join('\n'), kb);
}

export async function addAutoRule(
  ctx: Context,
  mint: string,
  kind: 'take_profit' | 'stop_loss' | 'trailing_stop' | 'limit_buy' | 'limit_sell',
  triggerPct: number,
): Promise<void> {
  // A limit order needs a price to anchor to, and it is fixed now rather than
  // recomputed later so the target cannot drift with the market.
  if (kind === 'limit_buy' || kind === 'limit_sell') {
    const now = await priceInSol(mint).catch(() => null);
    if (now === null) {
      await ctx.answerCallbackQuery({ text: 'No price available for this token right now.', show_alert: true });
      return;
    }

    const info = await getTokenInfo(mint, 'solana').catch(() => null);
    const settings = db.settings();
    const buySol = settings.quickBuyPresets[0] ?? 0.05;

    db.addRule({
      id: newRuleId(),
      mint,
      symbol: info?.symbol,
      kind,
      triggerPct,
      triggerPriceSol: now * (1 + triggerPct / 100),
      sellPercent: kind === 'limit_sell' ? 100 : 0,
      buySol: kind === 'limit_buy' ? buySol : undefined,
      enabled: true,
      createdAt: Date.now(),
    });

    await ctx.answerCallbackQuery({
      text: kind === 'limit_buy' ? `Dip buy armed at ${triggerPct}%` : `Limit sell armed at +${triggerPct}%`,
    });
    return showAutoSell(ctx, mint);
  }

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
  for (const p of db.dcaPlans().filter((x) => x.mint === mint)) db.removeDcaPlan(p.id);
  await ctx.answerCallbackQuery({ text: 'Automation cleared.' });
  return showAutoSell(ctx, mint);
}

export async function promptDca(ctx: Context, mint: string): Promise<void> {
  setPending(ctx.from!.id, { kind: 'dca_setup', mint });
  await render(
    ctx,
    [
      '<b>🔁 Average into this token over time</b>',
      '',
      'Send three numbers: <b>SOL per wallet, minutes between rounds, number of rounds</b>.',
      '',
      '<i>e.g. "0.05 30 6" buys 0.05 SOL per wallet every 30 minutes, six times.</i>',
      '',
      `<i>Across ${selectWallets().length} wallets that would commit ${(0.05 * selectWallets().length * 6).toFixed(3)} SOL in total.</i>`,
    ].join('\n'),
    backButton(`autosell:${tokenId(mint)}`),
  );
}

export async function handleDcaSetup(ctx: Context, mint: string, text: string): Promise<void> {
  const parts = text.split(/[\s,]+/).filter(Boolean).map(Number);
  const [buySol, intervalMinutes, roundsTotal] = parts;

  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n) || n <= 0)) {
    await ctx.reply('Send three positive numbers: SOL per wallet, minutes, rounds. e.g. 0.05 30 6');
    return;
  }
  if (buySol! > config.safety.maxBuySolPerWallet) {
    await ctx.reply(`That exceeds the per-wallet cap of ${config.safety.maxBuySolPerWallet} SOL.`);
    return;
  }

  const info = await getTokenInfo(mint, 'solana').catch(() => null);
  const wallets = selectWallets().length;

  db.addDcaPlan({
    id: newRuleId(),
    mint,
    symbol: info?.symbol,
    buySol: buySol!,
    intervalMinutes: intervalMinutes!,
    roundsTotal: Math.round(roundsTotal!),
    roundsDone: 0,
    // the first round runs on the next tick, so the plan starts immediately
    nextRunAt: Date.now(),
    enabled: true,
    createdAt: Date.now(),
  });

  await ctx.reply(
    [
      '🔁 <b>DCA plan armed.</b>',
      '',
      `${buySol} SOL per wallet × ${wallets} wallets, every ${intervalMinutes}m, ${Math.round(roundsTotal!)} rounds.`,
      `Total commitment: <b>${(buySol! * wallets * Math.round(roundsTotal!)).toFixed(3)} SOL</b>.`,
      '',
      '<i>The first round runs within the next 20 seconds.</i>',
    ].join('\n'),
    { parse_mode: 'HTML' },
  );
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
      lines.push(`   ${describeCopySize(t)} · ${describeCopyEntries(t)} · ${describeCopyExits(t)}`);
    }
  }

  lines.push('');
  lines.push('<b>Read this before following anyone.</b>');
  lines.push(
    '<i>The bot polls their wallet every 20 seconds, so your copy lands seconds behind theirs — on a memecoin, that is often the whole move. This follows a trader; it cannot race one.</i>',
  );
  lines.push('');
  lines.push(
    `<i>Every copy is spread across your ${selectWallets().length} selected wallets. Tap ⚙️ to change size, how far to follow them in, and what to do when they sell.</i>`,
  );

  const kb = new InlineKeyboard()
    .text('➕ Follow a wallet', 'copy_add')
    .text('🛡 Safety', 'copy_safety')
    .row();
  for (const t of targets.slice(0, 8)) {
    kb.text(`⚙️ ${t.label}`, `copy_open:${t.id}`)
      .text(t.enabled ? '⏸' : '▶️', `copy_toggle:${t.id}`)
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

/**
 * One prompt accepts both sizings, because "how big" is one question.
 *
 * `0.05` is a fixed 0.05 SOL in every wallet whatever they risked; `5%` scales
 * the copy to 5% of what they just spent. Anything else is rejected rather than
 * guessed at — this number decides how much money moves.
 */
export function parseCopySize(text: string): { mode: 'fixed' | 'percent'; value: number } | null {
  const raw = text.trim().replace(',', '.');

  const percent = /^(\d+(?:\.\d+)?)\s*%$/.exec(raw);
  if (percent) {
    const value = Number(percent[1]);
    if (!Number.isFinite(value) || value <= 0 || value > 100) return null;
    return { mode: 'percent', value };
  }

  if (!/^\d+(?:\.\d+)?$/.test(raw)) return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return null;
  return { mode: 'fixed', value };
}

export async function handleCopySize(ctx: Context, address: string, text: string): Promise<void> {
  const size = parseCopySize(text);
  if (!size) {
    await ctx.reply('Send a SOL amount like <code>0.05</code>, or a share of their trade like <code>5%</code>.', {
      parse_mode: 'HTML',
    });
    setPending(ctx.from!.id, { kind: 'copy_size', address });
    return;
  }

  if (size.mode === 'fixed' && size.value > config.safety.maxBuySolPerWallet) {
    await ctx.reply(`That exceeds the per-wallet cap of ${config.safety.maxBuySolPerWallet} SOL.`);
    setPending(ctx.from!.id, { kind: 'copy_size', address });
    return;
  }

  db.addCopyTarget({
    id: newRuleId(),
    address,
    label: shortAddr(address, 4, 4),
    buySol: size.mode === 'fixed' ? size.value : 0.05,
    sizeMode: size.mode,
    sizePercent: size.mode === 'percent' ? size.value : 5,
    // the conservative defaults: their opening buy only, exits mirrored as trims
    entryMode: 'first',
    maxEntries: 3,
    exitMode: 'proportional',
    enabled: true,
    copiedMints: [],
    entryCounts: {},
    createdAt: Date.now(),
  });

  await ctx.reply(
    [
      '✅ <b>Now following.</b>',
      '',
      `<code>${shortAddr(address, 6, 6)}</code>`,
      size.mode === 'percent'
        ? `Size: <b>${size.value}%</b> of each trade they make`
        : `Size: <b>${size.value} SOL</b> per wallet`,
      'Entries: <b>their first buy only</b>',
      'Exits: <b>mirror the share they sell</b>',
      '',
      '<i>Their existing positions are ignored — only trades from now on are mirrored. Tap ⚙️ to change any of this.</i>',
    ].join('\n'),
    { parse_mode: 'HTML', reply_markup: new InlineKeyboard().text('👥 Copy trading', 'copy_trade') },
  );
}

// ── one followed wallet ───────────────────────────────────────────────────────

export function describeCopySize(t: CopyTarget): string {
  return t.sizeMode === 'percent' ? `${t.sizePercent}% of their size` : `${t.buySol} SOL per wallet`;
}

export function describeCopyEntries(t: CopyTarget): string {
  return t.entryMode === 'every' ? `follows their DCA (max ${t.maxEntries})` : 'first buy only';
}

export function describeCopyExits(t: CopyTarget): string {
  if (t.exitMode === 'off') return 'ignores their sells';
  return t.exitMode === 'all' ? 'exits fully on any sell' : 'mirrors the share they sell';
}

export function describeCopyTakeProfit(t: CopyTarget): string {
  if (t.takeProfitPct === undefined) return 'no take profit';
  return `take profit at +${t.takeProfitPct}%`;
}

export function describeCopyStopLoss(t: CopyTarget): string {
  if (t.stopLossPct === undefined) return 'no stop loss';
  return `stop loss at -${Math.abs(t.stopLossPct)}%`;
}

export async function showCopyTarget(ctx: Context, id: string): Promise<void> {
  const t = db.copyTargets().find((x) => x.id === id);
  if (!t) {
    await ctx.answerCallbackQuery({ text: 'That wallet is no longer followed.', show_alert: true });
    return;
  }

  const wallets = selectWallets().length;

  const lines = [
    `<b>👥 ${h(t.label)}</b> ${t.enabled ? '' : '<i>(paused)</i>'}`,
    `<code>${h(t.address)}</code>`,
    '',
    `<b>Size</b> — ${describeCopySize(t)}`,
    t.sizeMode === 'percent'
      ? `<i>They spend 10 SOL, you spend ${((10 * t.sizePercent) / 100).toFixed(2)} SOL split across ${wallets} wallet${wallets === 1 ? '' : 's'}.</i>`
      : `<i>${t.buySol} SOL in each of ${wallets} wallet${wallets === 1 ? '' : 's'} — ${(t.buySol * wallets).toFixed(3)} SOL per copied buy, whatever they risked.</i>`,
    '',
    `<b>Entries</b> — ${describeCopyEntries(t)}`,
    t.entryMode === 'every'
      ? '<i>They average in, you average in with them, up to the cap.</i>'
      : '<i>Their opening buy is copied. Later buys into the same token are ignored.</i>',
    '',
    `<b>Follow them out</b> — ${describeCopyExits(t)}`,
    t.exitMode === 'proportional'
      ? '<i>They sell 10% of their bag, you sell 10% of yours.</i>'
      : t.exitMode === 'all'
        ? '<i>Any sell of theirs closes your whole position.</i>'
        : '<i>Their sells are ignored entirely.</i>',
    '',
    `<b>Your own exits</b> — ${describeCopyTakeProfit(t)} · ${describeCopyStopLoss(t)}`,
    t.takeProfitPct === undefined && t.stopLossPct === undefined
      ? '<i>Nothing armed. Every position rides on their timing alone.</i>'
      : `<i>Armed on each position this wallet opens for you, measured from what you paid` +
        (t.takeProfitPct !== undefined ? `. Take profit sells ${t.takeProfitSellPct ?? 50}% and lets the rest run` : '') +
        '.</i>',
    '',
    `<i>${t.copiedMints.length} token${t.copiedMints.length === 1 ? '' : 's'} copied so far. Once copied, a token is never re-entered.</i>`,
  ];

  const kb = new InlineKeyboard()
    .text('💰 Size', `copy_size:${t.id}`)
    .row()
    .text(`🔁 ${describeCopyEntries(t)}`, `copy_entries:${t.id}`)
    .row()
    .text(`📤 ${describeCopyExits(t)}`, `copy_exits:${t.id}`)
    .row()
    .text(`🎯 ${describeCopyTakeProfit(t)}`, `copy_tp:${t.id}`)
    .row()
    .text(`🛑 ${describeCopyStopLoss(t)}`, `copy_sl:${t.id}`)
    .row()
    .text(t.enabled ? '⏸ Pause' : '▶️ Resume', `copy_toggle:${t.id}:stay`)
    .text('🗑 Unfollow', `copy_remove:${t.id}`)
    .row()
    .text('← Copy trading', 'copy_trade');

  await render(ctx, lines.join('\n'), kb);
}

/** Cycle: first buy only → follow their DCA at 3, 5, then 10 entries. */
export async function cycleCopyEntries(ctx: Context, id: string): Promise<void> {
  const t = db.copyTargets().find((x) => x.id === id);
  if (!t) return;

  const next =
    t.entryMode === 'first'
      ? { entryMode: 'every' as const, maxEntries: 3 }
      : t.maxEntries < 5
        ? { entryMode: 'every' as const, maxEntries: 5 }
        : t.maxEntries < 10
          ? { entryMode: 'every' as const, maxEntries: 10 }
          : { entryMode: 'first' as const, maxEntries: 3 };

  db.updateCopyTarget(id, next);
  await showCopyTarget(ctx, id);
}

/** Cycle: mirror the share they sell → full exit on any sell → ignore sells. */
export async function cycleCopyExits(ctx: Context, id: string): Promise<void> {
  const t = db.copyTargets().find((x) => x.id === id);
  if (!t) return;

  const next: CopyExitMode =
    t.exitMode === 'proportional' ? 'all' : t.exitMode === 'all' ? 'off' : 'proportional';

  db.updateCopyTarget(id, { exitMode: next });
  await showCopyTarget(ctx, id);
}

/**
 * Targets worth offering, and why these.
 *
 * A memecoin that works does multiples, so the useful take-profits are whole
 * multiples rather than the 5% steps a slower market would want. Stops are
 * shallower than the swings these tokens make on purpose — anything tighter
 * fires on noise, anything looser is not a stop.
 */
const COPY_TP_STEPS = [50, 100, 200, 500];
const COPY_SL_STEPS = [30, 50, 70];

export async function cycleCopyTakeProfit(ctx: Context, id: string): Promise<void> {
  const t = db.copyTargets().find((x) => x.id === id);
  if (!t) return;

  const next = nextStep(COPY_TP_STEPS, t.takeProfitPct);
  db.updateCopyTarget(id, { takeProfitPct: next });
  await showCopyTarget(ctx, id);
}

export async function cycleCopyStopLoss(ctx: Context, id: string): Promise<void> {
  const t = db.copyTargets().find((x) => x.id === id);
  if (!t) return;

  const next = nextStep(COPY_SL_STEPS, t.stopLossPct === undefined ? undefined : Math.abs(t.stopLossPct));
  db.updateCopyTarget(id, { stopLossPct: next });
  await showCopyTarget(ctx, id);
}

/**
 * Walk a list of presets, then back to off. Returning undefined rather than 0
 * matters: zero would be a rule that fires the instant the price does not move.
 */
export function nextStep(steps: number[], current: number | undefined): number | undefined {
  if (current === undefined) return steps[0];
  const i = steps.indexOf(current);
  if (i === -1) return steps[0];
  return steps[i + 1];
}

// ── the limits a copied buy has to clear ──────────────────────────────────────

const TOP10_STEPS = [10, 20, 30, 40, 60, 100];
const DEV_STEPS = [0, 1, 2, 5, 10, 100];
const LIQ_STEPS = [0, 1_000, 3_000, 10_000, 25_000];

export async function showCopySafety(ctx: Context): Promise<void> {
  const limits = db.settings().copySafety;

  await render(
    ctx,
    [
      '<b>🛡 Copy trade safety</b>',
      '',
      'Checked on every copied buy, before any money moves. A token that fails is skipped and never reconsidered.',
      '',
      ...describeLimits(limits).map((l) => `· ${l}`),
      '',
      '<i>Only copy trading is gated. Buying by hand shows you the same warnings and lets you decide.</i>',
      '',
      '<i>Anything unreadable counts as a failure — a holder query the RPC refused means concentration is unknown, not zero.</i>',
    ].join('\n'),
    new InlineKeyboard()
      .text(`👥 Top 10 max ${limits.maxTop10Pct}%`, 'safety_top10')
      .row()
      .text(`👤 Dev max ${limits.maxDevPct}%`, 'safety_dev')
      .row()
      .text(`🔒 Authorities: ${limits.requireRevokedAuthorities ? 'must be revoked' : 'not checked'}`, 'safety_auth')
      .row()
      .text(
        limits.minLiquidityUsd > 0
          ? `💧 Liquidity min $${limits.minLiquidityUsd.toLocaleString('en-US')}`
          : '💧 Liquidity not checked',
        'safety_liq',
      )
      .row()
      .text('← Copy trading', 'copy_trade'),
  );
}

/** Each limit cycles its presets; 100% and $0 are the "not checked" ends. */
export async function cycleSafety(ctx: Context, which: string): Promise<void> {
  const limits = { ...db.settings().copySafety };

  if (which === 'top10') limits.maxTop10Pct = cycleStep(TOP10_STEPS, limits.maxTop10Pct);
  else if (which === 'dev') limits.maxDevPct = cycleStep(DEV_STEPS, limits.maxDevPct);
  else if (which === 'liq') limits.minLiquidityUsd = cycleStep(LIQ_STEPS, limits.minLiquidityUsd);
  else if (which === 'auth') limits.requireRevokedAuthorities = !limits.requireRevokedAuthorities;

  db.updateSettings({ copySafety: limits });
  await showCopySafety(ctx);
}

/** Wrap around rather than bottoming out, so no tap is a dead end. */
export function cycleStep(steps: number[], current: number): number {
  const i = steps.indexOf(current);
  return steps[(i + 1) % steps.length] ?? steps[0]!;
}

export async function promptCopyResize(ctx: Context, id: string): Promise<void> {
  const t = db.copyTargets().find((x) => x.id === id);
  if (!t) return;

  setPending(ctx.from!.id, { kind: 'copy_resize', targetId: id });
  await render(
    ctx,
    [
      `<b>💰 How big should copies of ${h(t.label)} be?</b>`,
      '',
      `<code>0.05</code> — a fixed 0.05 SOL in every wallet, whatever they risked.`,
      `<code>5%</code> — a position 5% the size of theirs, split across your wallets.`,
      '',
      `<i>Currently ${describeCopySize(t)}.</i>`,
    ].join('\n'),
    backButton(`copy_open:${t.id}`),
  );
}

export async function handleCopyResize(ctx: Context, targetId: string, text: string): Promise<void> {
  const t = db.copyTargets().find((x) => x.id === targetId);
  if (!t) return;

  const size = parseCopySize(text);
  if (!size) {
    await ctx.reply('Send a SOL amount like <code>0.05</code>, or a share like <code>5%</code>.', {
      parse_mode: 'HTML',
    });
    setPending(ctx.from!.id, { kind: 'copy_resize', targetId });
    return;
  }

  if (size.mode === 'fixed' && size.value > config.safety.maxBuySolPerWallet) {
    await ctx.reply(`That exceeds the per-wallet cap of ${config.safety.maxBuySolPerWallet} SOL.`);
    setPending(ctx.from!.id, { kind: 'copy_resize', targetId });
    return;
  }

  db.updateCopyTarget(targetId, {
    sizeMode: size.mode,
    ...(size.mode === 'fixed' ? { buySol: size.value } : { sizePercent: size.value }),
  });

  await ctx.reply(`✅ Copies of <b>${h(t.label)}</b> are now ${size.mode === 'percent' ? `${size.value}% of their size` : `${size.value} SOL per wallet`}.`, {
    parse_mode: 'HTML',
    reply_markup: new InlineKeyboard().text('⚙️ Back to the wallet', `copy_open:${targetId}`),
  });
}

/**
 * Pause or resume. `stay` keeps the operator on the wallet's own screen, which
 * is where the button reads "Pause" rather than being one row among eight.
 */
export async function toggleCopyTarget(ctx: Context, id: string, stay = false): Promise<void> {
  const t = db.copyTargets().find((x) => x.id === id);
  if (!t) return;
  db.updateCopyTarget(id, { enabled: !t.enabled });
  await ctx.answerCallbackQuery({ text: t.enabled ? 'Paused' : 'Resumed' });
  return stay ? showCopyTarget(ctx, id) : showCopyTrade(ctx);
}

export async function removeCopyTarget(ctx: Context, id: string): Promise<void> {
  db.removeCopyTarget(id);
  await ctx.answerCallbackQuery({ text: 'Unfollowed' });
  return showCopyTrade(ctx);
}


/** One rule type, one small screen of choices. */
export async function showRulePresets(ctx: Context, mint: string, what: string): Promise<void> {
  await render(ctx, '<i>Reading the price…</i>');

  const id = tokenId(mint);
  const price = await priceInSol(mint).catch(() => null);
  const entry = entryPriceSol(mint);

  const menus: Record<string, { title: string; blurb: string; presets: number[]; icon: string }> = {
    tp: {
      title: '🎯 Take profit',
      blurb: 'Sells half your position when it is up this much from your entry, letting the rest run.',
      presets: TP_PRESETS,
      icon: '+',
    },
    sl: {
      title: '🛑 Stop loss',
      blurb: 'Sells everything if it falls this far below your entry.',
      presets: SL_PRESETS,
      icon: '',
    },
    trail: {
      title: '📉 Trailing stop',
      blurb: 'Follows the price up and sells if it drops this far from the highest point. Works even on tokens you did not buy here.',
      presets: TRAIL_PRESETS,
      icon: '',
    },
    dip: {
      title: '💰 Buy the dip',
      blurb: 'Buys automatically if the price falls this far from where it is now.',
      presets: DIP_PRESETS,
      icon: '',
    },
    lsell: {
      title: '🚀 Limit sell',
      blurb: 'Sells everything if the price rises this far above where it is now.',
      presets: LIMIT_SELL_PRESETS,
      icon: '+',
    },
  };

  const menu = menus[what];
  if (!menu) return showAutoSell(ctx, mint);

  const lines = [`<b>${menu.title}</b>`, '', menu.blurb, ''];
  if (price !== null) lines.push(`Price now: <b>${price.toExponential(4)} SOL</b>`);
  if (entry !== null && (what === 'tp' || what === 'sl')) {
    lines.push(`Your entry: <b>${entry.toExponential(4)} SOL</b>`);
  }
  if (entry === null && (what === 'tp' || what === 'sl')) {
    lines.push('<i>No entry recorded — buy through the bot first, or use a trailing stop.</i>');
  }

  const kb = new InlineKeyboard();
  for (const pct of menu.presets) kb.text(`${menu.icon}${pct}%`, `rule:${what}:${id}:${pct}`);
  kb.row().text('← Back', `autosell:${id}`);

  await render(ctx, lines.join('\n'), kb);
}
