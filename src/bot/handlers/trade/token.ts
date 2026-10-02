import type { Context } from 'grammy';
import { InlineKeyboard } from 'grammy';
import { db } from '../../../store/db.js';
import { selectWallets, allWallets } from '../../../store/wallets.js';
import { getTokenInfo } from '../../../services/tokeninfo.js';
import { getSolPrice } from '../../../services/prices.js';
import { positionPnl, formatPnl, formatEntry } from '../../../services/pnl.js';
import { getMintBalances, getMintDecimals } from '../../../chains/solana.js';
import { errMessage } from '../../../util.js';
import { log } from '../../../logger.js';
import { setPending, tokenId } from '../../session.js';
import { renderTokenCard, tokenKeyboard, renderHolders, backButton, h } from '../../ui.js';
import { render } from '../core.js';

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
    let holdingKnown = false;
    if (info.chain === 'solana') {
      try {
        const wallets = selectWallets();
        const held = await getMintBalances(
          allWallets().map(w => w.address),
          mint,
        );
        holdsPosition = wallets.some(w => (held.get(w.address) ?? 0n) > 0n);
        for (const amount of held.values()) heldRaw += amount;
        holdingKnown = true;
      } catch {
        /* a failed balance read should not hide the card */
      }
    }

    const decimals = info.decimals ?? (await getMintDecimals(mint).catch(() => undefined));
    const heldTokens = decimals === undefined ? undefined : Number(heldRaw) / 10 ** decimals;
    const solPriceUsd = await getSolPrice().catch(() => 0);

    // judged against the same limits copy trading uses, so the card and the
    // gate can never disagree about the same token
    let text = renderTokenCard(info, settings.copySafety);

    // what this position has cost and returned, if it was bought through here
    const record = db.position(mint);
    if (
      record &&
      record.investedSol > 0 &&
      holdingKnown &&
      heldTokens !== undefined &&
      info.priceUsd !== undefined &&
      solPriceUsd > 0
    ) {
      const heldSol =
        info.priceUsd !== undefined && solPriceUsd > 0
          ? (heldTokens * info.priceUsd) / solPriceUsd
          : 0;
      const pnl = positionPnl(record, heldSol);

      // the price paid belongs next to the price now, on the screen where the
      // buy and sell buttons are — that is where the comparison gets acted on
      const nowSol = heldTokens > 0 ? heldSol / heldTokens : null;
      const entryLine = formatEntry(record, nowSol);

      text +=
        `\n\n<b>📒 Your position</b>\n` +
        (entryLine ? `${entryLine}\n` : '') +
        `In ${pnl.investedSol.toFixed(3)} · back ${pnl.realisedSol.toFixed(3)} · held ${heldSol.toFixed(3)} SOL\n` +
        `${formatPnl(pnl)}`;
    }

    if (info.chain !== 'solana') {
      text +=
        '\n\n<i>ℹ️ Research only — this bot holds and trades Solana wallets. It cannot buy this.</i>';
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
