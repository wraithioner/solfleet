import type { Context } from 'grammy';
import { InlineKeyboard } from 'grammy';
import { config } from '../../../config.js';
import { db, type CopyTarget, type CopyExitMode } from '../../../store/db.js';
import { selectWallets } from '../../../store/wallets.js';
import { extractTokenAddress } from '../../../services/tokeninfo.js';
import { shortAddr } from '../../../util.js';
import { setPending } from '../../session.js';
import { backButton, h } from '../../ui.js';
import { render } from '../core.js';
import { newRuleId } from '../../../services/rule-ids.js';

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

  /*
   * How many trades were passed up today, on the button itself.
   *
   * Skips are deliberately silent — a coin you do not own, declined for a
   * reason that has not changed, is not worth a message. Silent should not
   * mean hidden, though, so the count rides on the button that opens them.
   */
  const recentSkips = db
    .copyDecisions(40)
    .filter(d => Date.now() - d.at < 24 * 60 * 60 * 1000).length;

  lines.push('');
  lines.push(
    '<i>A trade the limits turn down does not message you — it is a coin you do not own. 📋 Why it skipped lists every one, newest first.</i>',
  );

  const kb = new InlineKeyboard()
    .text('➕ Follow a wallet', 'copy_add')
    .success()
    .text('🛡 Safety', 'copy_safety')
    .primary()
    .row()
    // the answer to "they bought something and nothing happened"
    .text(
      recentSkips > 0 ? `📋 Why it skipped (${recentSkips})` : '📋 Why it skipped',
      'copy_decisions',
    )
    .primary()
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
  if (token?.kind !== 'solana') {
    await ctx.reply('That is not a valid Solana address.');
    return;
  }

  if (db.copyTargets().some(t => t.address === token.address)) {
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
    await ctx.reply(
      'Send a SOL amount like <code>0.05</code>, or a share of their trade like <code>5%</code>.',
      {
        parse_mode: 'HTML',
      },
    );
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
    {
      parse_mode: 'HTML',
      reply_markup: new InlineKeyboard().text('👥 Copy trading', 'copy_trade'),
    },
  );
}

// ── one followed wallet ───────────────────────────────────────────────────────

export function describeCopySize(t: CopyTarget): string {
  return t.sizeMode === 'percent'
    ? `${t.sizePercent}% of their size`
    : `${t.buySol} SOL per wallet`;
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
  const t = db.copyTargets().find(x => x.id === id);
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
        (t.takeProfitPct !== undefined
          ? (t.takeProfitSellPct ?? 100) >= 100
            ? '. Take profit exits the whole position'
            : `. Take profit sells ${t.takeProfitSellPct}% and lets the rest run`
          : '') +
        '.</i>',
    '',
    // the old wording promised something this screen cannot deliver: the cap it
    // described is stored per followed wallet, so following three of them into
    // one coin took three entries, and the reader had no way to know
    `<i>${t.copiedMints.length} token${t.copiedMints.length === 1 ? '' : 's'} copied from this wallet. ` +
      `It will not re-enter one of them${t.entryMode === 'every' ? ` past ${t.maxEntries} entries` : ''}; ` +
      `total size per coin is capped in <b>Safety</b>, across every wallet you follow.</i>`,
  ];

  const kb = new InlineKeyboard()
    .text('💰 Size', `copy_size:${t.id}`)
    .row()
    .text(`🔁 ${describeCopyEntries(t)}`, `copy_entries:${t.id}`)
    .row()
    .text(`📤 ${describeCopyExits(t)}`, `copy_exits:${t.id}`)
    .row()
    .text(`🎯 ${describeCopyTakeProfit(t)}`, `copy_tp:${t.id}`)
    .success()
    .row()
    .text(`🛑 ${describeCopyStopLoss(t)}`, `copy_sl:${t.id}`)
    .danger()
    .row()
    .text(t.enabled ? '⏸ Pause' : '▶️ Resume', `copy_toggle:${t.id}:stay`)
    .primary()
    .text('🗑 Unfollow', `copy_remove:${t.id}`)
    .danger()
    .row()
    .text('← Copy trading', 'copy_trade');

  await render(ctx, lines.join('\n'), kb);
}

/** Cycle: first buy only → follow their DCA at 3, 5, then 10 entries. */
export async function cycleCopyEntries(ctx: Context, id: string): Promise<void> {
  const t = db.copyTargets().find(x => x.id === id);
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
  const t = db.copyTargets().find(x => x.id === id);
  if (!t) return;

  const next: CopyExitMode =
    t.exitMode === 'proportional' ? 'all' : t.exitMode === 'all' ? 'off' : 'proportional';

  db.updateCopyTarget(id, { exitMode: next });
  await showCopyTarget(ctx, id);
}

/**
 * Targets worth offering, and why these.
 *
 * The ladder starts at 20% for the trade that takes a quick win off a copied
 * entry, then climbs in multiples, because a memecoin that works does not do
 * 25% — it does 3x, and a ladder in 5% steps would take a dozen taps to reach
 * anywhere useful. Stops are shallower than the swings these tokens make on
 * purpose: anything tighter fires on noise, anything looser is not a stop.
 */
const COPY_TP_STEPS = [20, 50, 100, 200, 500];
const COPY_SL_STEPS = [30, 50, 70];

export async function cycleCopyTakeProfit(ctx: Context, id: string): Promise<void> {
  const t = db.copyTargets().find(x => x.id === id);
  if (!t) return;

  const next = nextStep(COPY_TP_STEPS, t.takeProfitPct);
  db.updateCopyTarget(id, { takeProfitPct: next });
  await showCopyTarget(ctx, id);
}

export async function cycleCopyStopLoss(ctx: Context, id: string): Promise<void> {
  const t = db.copyTargets().find(x => x.id === id);
  if (!t) return;

  const next = nextStep(
    COPY_SL_STEPS,
    t.stopLossPct === undefined ? undefined : Math.abs(t.stopLossPct),
  );
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

export async function promptCopyResize(ctx: Context, id: string): Promise<void> {
  const t = db.copyTargets().find(x => x.id === id);
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

export async function handleCopyResize(
  ctx: Context,
  targetId: string,
  text: string,
): Promise<void> {
  const t = db.copyTargets().find(x => x.id === targetId);
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

  await ctx.reply(
    `✅ Copies of <b>${h(t.label)}</b> are now ${size.mode === 'percent' ? `${size.value}% of their size` : `${size.value} SOL per wallet`}.`,
    {
      parse_mode: 'HTML',
      reply_markup: new InlineKeyboard().text('⚙️ Back to the wallet', `copy_open:${targetId}`),
    },
  );
}

/**
 * Pause or resume. `stay` keeps the operator on the wallet's own screen, which
 * is where the button reads "Pause" rather than being one row among eight.
 */
export async function toggleCopyTarget(ctx: Context, id: string, stay = false): Promise<void> {
  const t = db.copyTargets().find(x => x.id === id);
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
