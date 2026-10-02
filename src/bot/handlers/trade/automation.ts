import type { Context } from 'grammy';
import { InlineKeyboard } from 'grammy';
import { config } from '../../../config.js';
import { db } from '../../../store/db.js';
import { selectWallets } from '../../../store/wallets.js';
import { getTokenInfo } from '../../../services/tokeninfo.js';
import { setPending, tokenId } from '../../session.js';
import { backButton } from '../../ui.js';
import { render } from '../core.js';
import { entryPriceSol, describe as describeRule } from '../../../services/watcher.js';
import { newRuleId } from '../../../services/rule-ids.js';
import { priceInSol } from '../../../services/price.js';

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
  const plans = db.dcaPlans().filter(p => p.mint === mint && p.enabled);

  const lines = ['<b>🤖 Automation</b>', ''];

  if (entry === null) {
    lines.push(
      '<i>No entry price recorded for this token, so take-profit and stop-loss have nothing to measure against.</i>',
    );
    lines.push('');
    lines.push(
      '<i>Buy it through the bot first — a trailing stop works regardless, since it tracks the high rather than your entry.</i>',
    );
  } else {
    lines.push(`Entry: <b>${entry.toExponential(4)} SOL</b>`);
    if (price !== null) {
      const move = ((price - entry) / entry) * 100;
      lines.push(
        `Now: <b>${price.toExponential(4)} SOL</b> (${move >= 0 ? '+' : ''}${move.toFixed(1)}%)`,
      );
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
      lines.push(
        `· ${p.buySol} SOL every ${p.intervalMinutes}m — round ${p.roundsDone}/${p.roundsTotal}`,
      );
    }
  }

  lines.push('');
  lines.push('<i>Checked every 20 seconds; rules survive restarts and fire once.</i>');
  lines.push('<i>Limit prices are fixed from the price shown above when you tap.</i>');

  const kb = new InlineKeyboard()
    .text('🎯 Take profit', `rmenu:tp:${id}`)
    .success()
    .text('🛑 Stop loss', `rmenu:sl:${id}`)
    .danger()
    .row()
    .text('📉 Trailing stop', `rmenu:trail:${id}`)
    .text('💰 Buy the dip', `rmenu:dip:${id}`)
    .row()
    .text('🚀 Limit sell', `rmenu:lsell:${id}`)
    .text('🔁 DCA', `dca_add:${id}`)
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
      await ctx.answerCallbackQuery({
        text: 'No price available for this token right now.',
        show_alert: true,
      });
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
      text:
        kind === 'limit_buy'
          ? `Dip buy armed at ${triggerPct}%`
          : `Limit sell armed at +${triggerPct}%`,
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
  const peak =
    kind === 'trailing_stop'
      ? ((await priceInSol(mint).catch(() => null)) ?? undefined)
      : undefined;

  db.addRule({
    id: newRuleId(),
    mint,
    symbol: info?.symbol,
    kind,
    triggerPct,
    // Stop-loss and take-profit rules default to a complete exit so the behavior
    // matches the 100% position size shown to the operator.
    sellPercent: 100,
    peakPriceSol: peak,
    enabled: true,
    createdAt: Date.now(),
  });

  await ctx.answerCallbackQuery({ text: 'Rule armed.' });
  return showAutoSell(ctx, mint);
}

export async function clearAutoRules(ctx: Context, mint: string): Promise<void> {
  for (const r of db.rulesFor(mint)) db.removeRule(r.id);
  for (const p of db.dcaPlans().filter(x => x.mint === mint)) db.removeDcaPlan(p.id);
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
  const parts = text
    .split(/[\s,]+/)
    .filter(Boolean)
    .map(Number);
  const [buySol, intervalMinutes, roundsTotal] = parts;

  if (parts.length !== 3 || parts.some(n => !Number.isFinite(n) || n <= 0)) {
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

/** One rule type, one small screen of choices. */
export async function showRulePresets(ctx: Context, mint: string, what: string): Promise<void> {
  await render(ctx, '<i>Reading the price…</i>');

  const id = tokenId(mint);
  const price = await priceInSol(mint).catch(() => null);
  const entry = entryPriceSol(mint);

  const menus: Record<string, { title: string; blurb: string; presets: number[]; icon: string }> = {
    tp: {
      title: '🎯 Take profit',
      blurb: 'Sells 100% of your position when it is up this much from your entry.',
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
      blurb:
        'Follows the price up and sells if it drops this far from the highest point. Works even on tokens you did not buy here.',
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
