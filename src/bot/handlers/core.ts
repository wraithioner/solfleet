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
import { buildPortfolio, listPositions } from '../../services/portfolio.js';
import { positionPnl, formatPnl } from '../../services/pnl.js';
import { getSolBalances, LAMPORTS } from '../../chains/solana.js';
import { fmtAmount, fmtUsd, errMessage } from '../../util.js';
import { log } from '../../logger.js';
import { tokenId, setPending, clearSession, stageConfirmation } from '../session.js';
import {
  mainMenu,
  renderPortfolio,
  portfolioKeyboard,
  renderSettings,
  settingsKeyboard,
  backButton,
  confirmKeyboard,
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

  const text = [
    '<b>⚡ Wallet Command Center</b>',
    '',
    `Wallets: <b>${wallets.length}</b>`,
    `Batch target: <b>${targeted.length}</b> wallets${settings.activeGroup ? ` in <i>${h(settings.activeGroup)}</i>` : ''}`,
    `Mode: <b>${settings.executionMode}</b> · Slippage <b>${settings.slippagePercent}%</b>`,
    '',
    // the boot log says this too, but nobody reads a boot log
    ...(config.solana.isPublicRpc
      ? ['⚠️ <b>Public RPC.</b> Balance screens will stall or time out.', 'Set <code>SOLANA_RPC_URL</code> to a Helius or QuickNode endpoint.', '']
      : []),
    '<i>Paste any token address to see its stats and trade it.</i>',
  ].join('\n');

  if (ctx.callbackQuery) await render(ctx, text, mainMenu());
  else await ctx.reply(text, { parse_mode: 'HTML', reply_markup: mainMenu() });
}

export async function showPortfolio(ctx: Context): Promise<void> {
  const settings = db.settings();
  await render(ctx, '<b>💼 Portfolio</b>\n\n<i>Reading balances…</i>');

  try {
    const portfolio = await buildPortfolio({ group: settings.activeGroup, includeTokens: true });
    await render(ctx, renderPortfolio(portfolio, settings.activeGroup), portfolioKeyboard());
  } catch (err) {
    await render(ctx, `❌ Could not load the portfolio.\n\n<i>${h(errMessage(err))}</i>`, backButton());
  }
}

export async function showPositions(ctx: Context): Promise<void> {
  const settings = db.settings();
  await render(ctx, '<b>🪙 Positions</b>\n\n<i>Scanning token accounts…</i>');

  try {
    const portfolio = await buildPortfolio({ group: settings.activeGroup, includeTokens: true });
    const positions = listPositions(portfolio);

    if (positions.length === 0) {
      await render(ctx, '<b>🪙 Positions</b>\n\n<i>No token positions across the selected wallets.</i>', backButton());
      return;
    }

    const lines = ['<b>🪙 Open positions</b>', ''];
    const kb = new InlineKeyboard();

    const solPrice = portfolio.totals.solPriceUsd;

    for (const p of positions.slice(0, 12)) {
      lines.push(
        `<b>${h(p.symbol)}</b> — ${fmtAmount(p.totalAmount, 2)} across ${p.walletCount} wallet${p.walletCount === 1 ? '' : 's'}` +
          (p.totalUsd > 0 ? ` · ${fmtUsd(p.totalUsd)}` : ''),
      );

      // what it cost versus what it is worth, for positions bought through here
      const record = db.position(p.mint);
      if (record && record.investedSol > 0) {
        const valueSol = solPrice > 0 ? p.totalUsd / solPrice : 0;
        const pnl = positionPnl(record, valueSol);
        lines.push(
          `   in ${pnl.investedSol.toFixed(3)} · back ${pnl.realisedSol.toFixed(3)} · ` +
            `held ${valueSol.toFixed(3)} SOL`,
        );
        lines.push(`   ${formatPnl(pnl)}`);
      }

      lines.push(`<code>${h(p.mint)}</code>`);
      lines.push('');
      kb.text(`${p.symbol} · ${fmtUsd(p.totalUsd)}`, `tokeninfo:${tokenId(p.mint)}`).row();
    }

    if (positions.length > 12) lines.push(`<i>…and ${positions.length - 12} more</i>`);

    kb.text('🔥 Sell everything', 'sell_all_confirm').row().text('← Menu', 'home');
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
    .text('🔑 Download keys', 'legacy_download')
    .row()
    .text('🗑 Delete them', 'legacy_forget')
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
