import type { Context } from 'grammy';
import { db } from '../../store/db.js';
import { allWallets, selectWallets } from '../../store/wallets.js';
import { isUnlocked, vaultExists } from '../../store/vault.js';
import { buildPortfolio, listPositions } from '../../services/portfolio.js';
import { fmtAmount, fmtUsd, errMessage } from '../../util.js';
import { tokenId } from '../session.js';
import {
  mainMenu,
  renderPortfolio,
  portfolioKeyboard,
  renderSettings,
  settingsKeyboard,
  backButton,
  h,
} from '../ui.js';
import { InlineKeyboard } from 'grammy';

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
  if (!vaultExists()) {
    await ctx.reply(
      [
        '<b>🔐 First run — set up your vault</b>',
        '',
        'Choose a passphrase. It encrypts every private key this bot stores.',
        'There is no recovery: lose it and the wallets are gone.',
        '',
        'Send it now as a normal message. I will delete your message immediately.',
      ].join('\n'),
      { parse_mode: 'HTML' },
    );
    return;
  }

  if (!isUnlocked()) {
    await ctx.reply(
      ['<b>🔒 Vault is locked</b>', '', 'Send <code>/unlock &lt;passphrase&gt;</code> to continue.'].join('\n'),
      { parse_mode: 'HTML' },
    );
    return;
  }

  const wallets = allWallets();
  const settings = db.settings();
  const targeted = selectWallets({ kind: 'solana' });

  const text = [
    '<b>⚡ Wallet Command Center</b>',
    '',
    `Wallets: <b>${wallets.filter((w) => w.kind === 'solana').length}</b> Solana · <b>${wallets.filter((w) => w.kind === 'evm').length}</b> EVM`,
    `Batch target: <b>${targeted.length}</b> wallets${settings.activeGroup ? ` in <i>${h(settings.activeGroup)}</i>` : ''}`,
    `Mode: <b>${settings.executionMode}</b> · Slippage <b>${settings.slippagePercent}%</b>`,
    '',
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
    const portfolio = await buildPortfolio({ group: settings.activeGroup, includeTokens: true, includeEvm: false });
    const positions = listPositions(portfolio);

    if (positions.length === 0) {
      await render(ctx, '<b>🪙 Positions</b>\n\n<i>No token positions across the selected wallets.</i>', backButton());
      return;
    }

    const lines = ['<b>🪙 Open positions</b>', ''];
    const kb = new InlineKeyboard();

    for (const p of positions.slice(0, 12)) {
      lines.push(
        `<b>${h(p.symbol)}</b> — ${fmtAmount(p.totalAmount, 2)} across ${p.walletCount} wallet${p.walletCount === 1 ? '' : 's'}` +
          (p.totalUsd > 0 ? ` · ${fmtUsd(p.totalUsd)}` : ''),
      );
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

export async function showSettings(ctx: Context): Promise<void> {
  const settings = db.settings();
  const wallets = allWallets();
  await render(
    ctx,
    renderSettings(settings, {
      solana: wallets.filter((w) => w.kind === 'solana').length,
      evm: wallets.filter((w) => w.kind === 'evm').length,
    }),
    settingsKeyboard(settings),
  );
}
