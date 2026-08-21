import type { Context } from 'grammy';
import { db } from '../../store/db.js';
import { config } from '../../config.js';
import {
  allWallets,
  selectWallets,
  legacyWallets,
  exportLegacyKeys,
  forgetLegacyWallets,
} from '../../store/wallets.js';
import { isUnlocked, destroyVault, initVaultWithKeyfile } from '../../store/vault.js';
import { buildPortfolio, listPositions, type Portfolio } from '../../services/portfolio.js';
import { positionPnl, entryPrice, accountPnl } from '../../services/pnl.js';
import { getSolBalances, LAMPORTS } from '../../chains/solana.js';
import { fmtAmount, fmtUsd, fmtPriceUsd, errMessage } from '../../util.js';
import { log } from '../../logger.js';
import { tokenId, setPending, clearSession, stageConfirmation } from '../session.js';
import {
  mainMenu,
  renderPortfolio,
  portfolioKeyboard,
  renderPnl,
  pnlKeyboard,
  renderSettings,
  settingsKeyboard,
  backButton,
  confirmKeyboard,
  updatedStamp,
  h,
} from '../ui.js';
import { InlineKeyboard, InputFile } from 'grammy';

/**
 * Edit the message a callback came from, transparently handling the fact that
 * token cards are photos (caption) while every other screen is text.
 */
export async function render(
  ctx: Context,
  text: string,
  keyboard?: InlineKeyboard,
): Promise<void> {
  const msg = ctx.callbackQuery?.message;
  const opts = {
    parse_mode: 'HTML' as const,
    reply_markup: keyboard,
    link_preview_options: { is_disabled: true },
  };

  try {
    if (msg && 'photo' in msg && msg.photo) {
      await ctx.editMessageCaption({ caption: text, ...opts });
    } else if (msg) {
      await ctx.editMessageText(text, opts);
    } else {
      await ctx.reply(text, opts);
    }
  } catch (err) {
    // "message is not modified" is the common case and is not worth surfacing
    if (!/message is not modified/i.test(errMessage(err))) {
      await ctx.reply(text, opts).catch(() => {});
    }
  }
}

export async function showHome(ctx: Context): Promise<void> {
  // the vault is created and opened at boot; this is the one case that cannot be
  if (!isUnlocked()) {
    await ctx.reply(
      [
        '<b>🔑 One last passphrase</b>',
        '',
        'This vault was made before passphrases were removed, and its keys are still sealed under yours.',
        '',
        'Send it now. Everything gets re-sealed with a key the bot keeps itself, and you will never be asked again.',
      ].join('\n'),
      { parse_mode: 'HTML' },
    );
    return;
  }

  const wallets = allWallets();
  const settings = db.settings();
  const targeted = selectWallets();

  const armed = db.activeRules().length;
  const following = db.activeCopyTargets().length;

  // what is running unattended belongs on the first screen: a stop-loss you
  // forgot you armed is indistinguishable from one that is not there
  const running = [
    armed > 0 ? `🤖 ${armed} rule${armed === 1 ? '' : 's'}` : '',
    following > 0 ? `👥 ${following} followed` : '',
  ].filter(Boolean);

  const text = [
    '<b>⚡ Wraith</b>',
    '',
    `👛 <b>${wallets.length}</b> wallet${wallets.length === 1 ? '' : 's'}` +
      `   ·   🎯 <b>${targeted.length}</b> targeted${settings.activeGroup ? ` <i>(${h(settings.activeGroup)})</i>` : ''}`,
    `⚙️ ${settings.executionMode}   ·   slippage ${settings.slippagePercent}%`,
    ...(running.length > 0 ? [`${running.join('   ·   ')} <i>running</i>`] : []),
    '',
    // the boot log says this too, but nobody reads a boot log
    ...(config.solana.isPublicRpc
      ? ['⚠️ <b>Public RPC</b> — balance screens will stall.', '<i>Set SOLANA_RPC_URL to a private endpoint.</i>', '']
      : []),
    '<i>Paste a token address to trade it.</i>',
  ].join('\n');

  if (ctx.callbackQuery) await render(ctx, text, mainMenu());
  else await ctx.reply(text, { parse_mode: 'HTML', reply_markup: mainMenu() });
}

/**
 * Mark every open position in SOL, keyed by mint.
 *
 * The P&L needs to know what is still held to say whether the whole thing is
 * ahead; anything not in this map is treated as having gone to zero, which is
 * the correct reading of a token the wallets no longer hold.
 */
function openValueSol(portfolio: Portfolio): { marks: Map<string, number>; unpriced: Set<string> } {
  const solPrice = portfolio.totals.solPriceUsd;
  const marks = new Map<string, number>();
  const unpriced = new Set<string>();
  if (solPrice <= 0) return { marks, unpriced };

  for (const p of listPositions(portfolio)) {
    marks.set(p.mint, p.totalUsd / solPrice);
    if (p.unpriced) unpriced.add(p.mint);
  }
  return { marks, unpriced };
}

export async function showPortfolio(ctx: Context): Promise<void> {
  const settings = db.settings();
  await render(ctx, '<b>💼 Portfolio</b>\n\n<i>Reading balances…</i>');

  try {
    const portfolio = await buildPortfolio({ group: settings.activeGroup, includeTokens: true });
    // marked from the wallets on screen, so the line agrees with the number
    // above it; the dedicated screen always reads the whole account
    const held = openValueSol(portfolio);
    const pnl = accountPnl(db.positions(), held.marks, portfolio.totals.solPriceUsd, held.unpriced);

    await render(
      ctx,
      `${renderPortfolio(portfolio, settings.activeGroup, pnl)}\n\n${updatedStamp()}`,
      portfolioKeyboard(),
    );
  } catch (err) {
    await render(ctx, `❌ Could not load the portfolio.\n\n<i>${h(errMessage(err))}</i>`, backButton());
  }
}

/**
 * Read past sales back off the chain and repair what was never recorded.
 *
 * For most of this bot's life four code paths sold tokens and one of them
 * wrote down the proceeds, so a stop loss that rescued most of a position
 * reported it as a total loss. The money arrived; the ledger missed it. The
 * transactions are still on chain, so this is a repair rather than an excuse.
 */
export async function rebuildPnl(ctx: Context): Promise<void> {
  await render(
    ctx,
    '<b>🔧 Rebuilding from the chain</b>\n\n<i>Reading every sale these wallets made. This takes a minute.</i>',
  );

  try {
    const { rebuildRealised } = await import('../../services/reconcile.js');
    const result = await rebuildRealised();

    const lines = ['<b>🔧 Rebuilt from the chain</b>', ''];

    if (result.repaired.length === 0) {
      lines.push('<i>Nothing was missing — every recorded sale already matches the chain.</i>');
    } else {
      const recovered = result.repaired.reduce((sum, r) => sum + (r.now - r.was), 0);
      lines.push(
        `Found <b>${fmtAmount(recovered, 4)} ◎</b> of proceeds that had not been written down, ` +
          `across <b>${result.repaired.length}</b> position${result.repaired.length === 1 ? '' : 's'}.`,
        '',
      );
      for (const r of result.repaired.slice(0, 12)) {
        lines.push(
          `· <b>${h(r.symbol ?? r.mint.slice(0, 6))}</b>  ${fmtAmount(r.was, 4)} → <b>${fmtAmount(r.now, 4)} ◎</b>`,
        );
      }
      if (result.repaired.length > 12) lines.push(`<i>…and ${result.repaired.length - 12} more</i>`);
    }

    if (result.failures.length > 0) {
      lines.push('', `<i>⚠️ ${h(result.failures.slice(0, 2).join(' | '))}</i>`);
      lines.push('<i>Those wallets\' sales are still missing. Try again.</i>');
    }

    lines.push('', '<i>Only ever raises a figure. The scan reaches back a bounded distance, so a very old sale can still sit outside it.</i>');

    await render(ctx, lines.join('\n'), new InlineKeyboard().text('📈 Back to P&L', 'pnl').primary());
  } catch (err) {
    await render(ctx, `❌ Could not rebuild.\n\n<i>${h(errMessage(err))}</i>`, backButton('pnl'));
  }
}

/**
 * The whole result, on its own screen.
 *
 * Built without the group filter deliberately: a P&L is a fact about the
 * account, and hiding half the wallets would not make the money that went
 * through them stop counting.
 */
export async function showPnl(ctx: Context): Promise<void> {
  await render(ctx, '<b>📈 Profit &amp; loss</b>\n\n<i>Adding it up…</i>');

  try {
    const portfolio = await buildPortfolio({ group: null, includeTokens: true });
    const held = openValueSol(portfolio);
    const pnl = accountPnl(db.positions(), held.marks, portfolio.totals.solPriceUsd, held.unpriced);

    // a look is also a reading; the hourly loop is the backstop, not the only
    // source, so opening this screen after a redeploy still leaves a mark
    if (portfolio.errors.length === 0 && portfolio.totals.solPriceUsd > 0) {
      db.recordValueMark(portfolio.totals.grandTotalUsd, portfolio.totals.solTotal);
    }

    await render(
      ctx,
      `${renderPnl(pnl, db.valueMarks(), portfolio.totals.grandTotalUsd)}\n\n${updatedStamp()}`,
      pnlKeyboard(),
    );
  } catch (err) {
    await render(ctx, `❌ Could not work out the P&amp;L.\n\n<i>${h(errMessage(err))}</i>`, backButton());
  }
}

export async function showPositions(ctx: Context): Promise<void> {
  const settings = db.settings();
  await render(ctx, '<b>🪙 Positions</b>\n\n<i>Scanning token accounts…</i>');

  try {
    const portfolio = await buildPortfolio({ group: settings.activeGroup, includeTokens: true });
    const positions = listPositions(portfolio);

    if (positions.length === 0) {
      await render(
        ctx,
        `<b>🪙 Positions</b>\n\n<i>No token positions across the selected wallets.</i>\n\n${updatedStamp()}`,
        new InlineKeyboard()
          .text('🔄 Refresh', 'positions').primary()
          .text('📈 P&L', 'pnl').primary()
          .row()
          .text('← Menu', 'home'),
      );
      return;
    }

    const owned = positions.filter((p) => p.boughtHere);
    const unsolicited = positions.filter((p) => !p.boughtHere);

    const lines = ['<b>🪙 Positions</b>', ''];
    const kb = new InlineKeyboard();

    const solPrice = portfolio.totals.solPriceUsd;

    if (owned.length === 0) lines.push('<i>Nothing bought through this bot.</i>', '');

    /*
     * One position, four lines, no number printed twice.
     *
     * The old layout said "+4.8%" on its own line and again inside the P&L
     * line, and spent a line on a token count nobody trades on. What decides
     * an exit is: what it is worth, how far from where you got in, and what
     * you have banked — in that order.
     */
    for (const p of owned.slice(0, 12)) {
      const record = db.position(p.mint);
      const valueSol = solPrice > 0 ? p.totalUsd / solPrice : 0;
      const pnl = record && record.investedSol > 0 ? positionPnl(record, valueSol) : null;

      const light = pnl === null ? '·' : pnl.netSol >= 0 ? '🟢' : '🔴';
      const move = pnl === null ? '' : `  <b>${pnl.netPct >= 0 ? '+' : ''}${pnl.netPct.toFixed(1)}%</b>`;
      lines.push(`${light} <b>${h(p.symbol)}</b>  ${fmtUsd(p.totalUsd)}${move}`);

      if (record && record.investedSol > 0) {
        const nowSol = p.totalAmount > 0 ? valueSol / p.totalAmount : null;
        const entry = entryPrice(record);
        if (entry !== null) {
          const arrow = nowSol === null ? '' : ` → ${fmtPriceUsd(nowSol * solPrice)}`;
          lines.push(`   entry ${fmtPriceUsd(entry * solPrice)}${arrow}`);
        }

        const banked = pnl!.realisedSol > 0 ? ` · banked ${pnl!.realisedSol.toFixed(3)} ◎` : '';
        lines.push(
          `   in ${pnl!.investedSol.toFixed(3)} ◎ · worth ${valueSol.toFixed(3)} ◎${banked}`,
        );
      }

      lines.push(`   <code>${h(p.mint)}</code>`);
      lines.push('');
      kb.text(`${p.symbol} · ${fmtUsd(p.totalUsd)}`, `tokeninfo:${tokenId(p.mint)}`).row();
    }

    if (owned.length > 12) lines.push(`<i>…and ${owned.length - 12} more</i>`);

    /*
     * Tokens the bot never bought are listed apart from the ones it did.
     *
     * Solana wallets get dusted constantly — worthless tokens are mass-sent to
     * addresses to bait an interaction — and a token account opened by a
     * stranger is indistinguishable on chain from one opened by a buy. Mixed
     * into the same list they read as positions, which is exactly the confusion
     * the people sending them are counting on.
     */
    if (unsolicited.length > 0) {
      lines.push('');
      lines.push(`<b>📥 Arrived on their own</b> — ${unsolicited.length} token${unsolicited.length === 1 ? '' : 's'}`);
      lines.push('<i>Not bought here. Airdropped tokens are usually worthless and sometimes bait; "Sell everything" leaves them alone.</i>');
      for (const p of unsolicited.slice(0, 5)) {
        lines.push(`· ${h(p.symbol)} — ${fmtAmount(p.totalAmount, 2)}${p.totalUsd > 0 ? ` · ${fmtUsd(p.totalUsd)}` : ' · no market'}`);
      }
      if (unsolicited.length > 5) lines.push(`<i>…and ${unsolicited.length - 5} more</i>`);
    }

    lines.push('');
    lines.push(updatedStamp());

    kb.text('🔄 Refresh', 'positions').primary().text('📈 P&L', 'pnl').primary().row();
    if (owned.length > 0) kb.text('🔥 Sell everything', 'sell_all_confirm').danger().row();
    kb.text('← Menu', 'home');
    await render(ctx, lines.join('\n'), kb);
  } catch (err) {
    await render(ctx, `❌ Could not load positions.\n\n<i>${h(errMessage(err))}</i>`, backButton());
  }
}

// ── factory reset ─────────────────────────────────────────────────────────────

/** The operator must type this exactly. A tap is too easy to do by accident. */
export const RESET_PHRASE = 'RESET EVERYTHING';

/**
 * Show what a reset would destroy, priced in real money where possible.
 *
 * Wallet addresses are stored in the clear, so the balances can be read even
 * when the vault is locked — which matters, because a forgotten passphrase is
 * the most likely reason to be here, and "you still have 3.4 SOL in there" is
 * the one fact that should stop someone mid-reset.
 */
export async function showFactoryReset(ctx: Context): Promise<void> {
  // Balances are read below and that can be slow on a busy endpoint. Without
  // something on screen first, the operator taps and sees nothing happen.
  await render(ctx, '<b>🧨 Factory reset</b>\n\n<i>Checking what this would destroy…</i>');

  const wallets = allWallets();
  const legacy = legacyWallets();

  const lines = [
    '<b>🧨 Factory reset</b>',
    '',
    'This deletes <b>everything</b>: the vault, every private key, the seed phrase, every wallet label and group, and the trade history.',
    '',
    `<b>${wallets.length}</b> wallet${wallets.length === 1 ? '' : 's'} stored`,
  ];

  // a wipe takes these too, and they are invisible everywhere else
  if (legacy.length > 0) {
    lines.push(`<b>${legacy.length}</b> legacy wallet${legacy.length === 1 ? '' : 's'} from the multi-chain version`);
    lines.push('<i>Settings → Export legacy keys, before you do this.</i>');
  }

  if (wallets.length === 0 && legacy.length === 0) {
    lines.push('');
    lines.push('<i>Nothing is stored yet — a reset would be a no-op.</i>');
    await render(ctx, lines.join('\n'), backButton('settings'));
    return;
  }

  // the number that should stop someone who is about to make a mistake
  if (wallets.length > 0) {
    try {
      const balances = await getSolBalances(wallets.map((w) => w.address));
      let total = 0n;
      let funded = 0;
      for (const lamports of balances.values()) {
        total += lamports;
        if (lamports > 0n) funded++;
      }

      const sol = Number(total) / LAMPORTS;
      lines.push('');
      if (total > 0n) {
        lines.push(`⚠️ <b>These wallets currently hold ${fmtAmount(sol, 6)} SOL</b> across ${funded} wallet${funded === 1 ? '' : 's'}.`);
        lines.push('<b>That balance becomes permanently unspendable.</b> Sweep it to a wallet you control first, or export the keys.');
      } else {
        lines.push('<i>No SOL balance found in these wallets.</i>');
      }
    } catch {
      lines.push('');
      lines.push('<i>⚠️ Could not read balances — assume the wallets still hold funds.</i>');
    }
  }

  lines.push('');
  lines.push('There is no undo and no backup. To go ahead, send this exactly:');
  lines.push(`<code>${RESET_PHRASE}</code>`);

  setPending(ctx.from!.id, { kind: 'factory_reset' });
  await render(ctx, lines.join('\n'), backButton('settings'));
}

/** Runs only after the operator typed the phrase verbatim. */
export async function executeFactoryReset(ctx: Context, text: string): Promise<void> {
  if (text.trim() !== RESET_PHRASE) {
    await ctx.reply(
      `Reset cancelled — that did not match.\n\nSend <code>${RESET_PHRASE}</code> exactly, or open Settings again.`,
      { parse_mode: 'HTML', reply_markup: backButton('settings') },
    );
    return;
  }

  const had = allWallets().length;

  destroyVault();
  db.wipe();
  clearSession(ctx.from!.id);

  // A reset that left no vault would leave the bot unusable until a restart,
  // since nothing else creates one any more. Start the empty one right away.
  initVaultWithKeyfile();

  log.warn(`Factory reset performed. ${had} wallets and the vault were deleted.`);

  await ctx.reply(
    [
      '<b>🧨 Factory reset complete</b>',
      '',
      `Deleted ${had} wallet${had === 1 ? '' : 's'} and every stored key.`,
      '',
      'A fresh empty vault is already open — make a wallet and carry on.',
    ].join('\n'),
    { parse_mode: 'HTML', reply_markup: mainMenu() },
  );
}

export async function showSettings(ctx: Context): Promise<void> {
  const settings = db.settings();
  const wallets = allWallets();
  await render(
    ctx,
    renderSettings(settings, wallets.length),
    settingsKeyboard(settings, legacyWallets().length),
  );
}

// ── legacy wallets from the multi-chain version ───────────────────────────────

/**
 * The recovery path for wallets this version cannot trade.
 *
 * These records predate the move to Solana-only. They are dead weight here, but
 * the addresses may still hold funds on whatever chain they came from, so they
 * are kept sealed in the vault until the operator has the keys in hand.
 */
export async function showLegacyKeys(ctx: Context): Promise<void> {
  const legacy = legacyWallets();

  if (legacy.length === 0) {
    await render(
      ctx,
      '<b>📦 Legacy keys</b>\n\n<i>Nothing left — this vault holds Solana wallets only.</i>',
      backButton('settings'),
    );
    return;
  }

  const lines = [
    '<b>📦 Legacy keys</b>',
    '',
    `<b>${legacy.length}</b> wallet${legacy.length === 1 ? '' : 's'} from before this bot went Solana-only.`,
    'They cannot trade here, but the addresses may still hold funds.',
    '',
  ];

  for (const w of legacy.slice(0, 20)) {
    lines.push(`<b>${h(w.label)}</b> · ${h(w.kind)}`);
    lines.push(`<code>${h(w.address)}</code>`);
  }
  if (legacy.length > 20) lines.push(`<i>…and ${legacy.length - 20} more</i>`);

  lines.push('');
  lines.push('Download the keys, import them into a wallet that speaks that chain, then delete them here.');

  const kb = new InlineKeyboard()
    .text('🔑 Download keys', 'legacy_download').success()
    .row()
    .text('🗑 Delete them', 'legacy_forget').danger()
    .row()
    .text('← Settings', 'settings');

  await render(ctx, lines.join('\n'), kb);
}

/**
 * Send the keys as a file rather than a message.
 *
 * A message that long gets split by Telegram, and a split message cannot be
 * deleted as one unit — a file is a single object that goes away on schedule.
 */
export async function downloadLegacyKeys(ctx: Context): Promise<void> {
  try {
    const rows = exportLegacyKeys();
    if (rows.length === 0) {
      await ctx.answerCallbackQuery({ text: 'Nothing to export.', show_alert: true });
      return;
    }

    const body = rows.map((r) => `${r.label}\t${r.chain}\t${r.address}\t${r.secret}`).join('\n');
    const file = Buffer.from(`label\tchain\taddress\tprivate_key\n${body}\n`, 'utf8');

    const sent = await ctx.replyWithDocument(new InputFile(file, 'legacy-keys.tsv'), {
      caption:
        `🔑 ${rows.length} private key${rows.length === 1 ? '' : 's'} in plaintext. ` +
        'Save it somewhere offline now — this message self-destructs in 3 minutes.',
    });

    // longer than the 60s a single key gets: this one has to be saved, not read
    scheduleDelete(ctx, sent.chat.id, sent.message_id, 180_000);
    log.warn(`Exported ${rows.length} legacy private key(s).`);
  } catch (err) {
    await ctx.reply(`❌ ${h(errMessage(err))}`, { parse_mode: 'HTML' });
  }
}

/** Two taps and a warning, because the keys are gone afterwards. */
export async function promptForgetLegacy(ctx: Context): Promise<void> {
  const legacy = legacyWallets();
  if (legacy.length === 0) {
    await ctx.answerCallbackQuery({ text: 'Nothing to delete.', show_alert: true });
    return;
  }

  const id = stageConfirmation(ctx.from!.id, `delete ${legacy.length} legacy wallets`, async (confirmCtx) => {
    const removed = forgetLegacyWallets();
    log.warn(`Deleted ${removed} legacy wallet record(s).`);
    await render(
      confirmCtx,
      `🗑 Deleted <b>${removed}</b> legacy wallet record${removed === 1 ? '' : 's'}.`,
      backButton('settings'),
    );
  });

  await render(
    ctx,
    [
      `<b>🗑 Delete ${legacy.length} legacy wallet${legacy.length === 1 ? '' : 's'}?</b>`,
      '',
      'This erases the encrypted keys from the vault. If those addresses still hold anything, it is unrecoverable.',
      '',
      '<b>Download the keys first.</b>',
    ].join('\n'),
    confirmKeyboard(id, 'legacy_keys'),
  );
}

function scheduleDelete(ctx: Context, chatId: number, messageId: number, delayMs: number): void {
  const timer = setTimeout(() => {
    ctx.api.deleteMessage(chatId, messageId).catch(() => {
      /* already gone, or too old to delete */
    });
  }, delayMs);
  timer.unref?.();
}
