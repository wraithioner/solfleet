import type { Context } from 'grammy';
import { InlineKeyboard } from 'grammy';
import { db } from '../../../store/db.js';
import { renderCopyDecisions, copyDecisionsKeyboard } from '../../ui.js';
import { render } from '../core.js';
import { describeLimits, formatAge } from '../../../services/safety.js';

// ── the limits a copied buy has to clear ──────────────────────────────────────

const TOP10_STEPS = [10, 20, 30, 40, 60, 100];
/*
 * How far away an unlock has to be before locked supply stops counting as
 * concentration. Shorter is more permissive, and the right value follows how
 * long positions are held rather than how long the contract runs — a copy
 * closed in minutes is not reached by a ninety-day cliff.
 */
const DEV_STEPS = [0, 1, 2, 5, 10, 100];
const LIQ_STEPS = [0, 1_000, 3_000, 10_000, 25_000];
/*
 * Hours, ending in 0 for "not checked".
 *
 * The rungs are shaped by what a copied trade actually is. 6h and 24h are for
 * following launch snipers, where anything older is somebody else's exit; 72h
 * is the default and the boundary past which a coin stops being a new launch;
 * a week is for following a trader who buys established names.
 */
const AGE_STEPS = [6, 24, 72, 168, 0];
/** Dollars of volume in the last hour. Live launches clear the top rung easily. */
const VOL_STEPS = [0, 500, 1_000, 5_000, 25_000];
/** Total SOL allowed into one coin, counting every trader and hand buys alike. */
const MINT_CAP_STEPS = [0.1, 0.25, 0.5, 1, 2, 0];
/** Share of supply allowed in wallets the index reads as one person. */
const INSIDER_STEPS = [10, 20, 30, 50, 0];
/** Mints before a developer counts as a factory. Sampled worst case: 11,284. */
const DEVMINT_STEPS = [5, 20, 50, 200, 0];
/** Distinct wallets in five minutes before a market counts as live. */
const TRADERS_STEPS = [3, 5, 10, 25, 0];

/**
 * The answer to "the trader bought something and nothing happened".
 *
 * Kept as a screen rather than a stream of messages: most skips are
 * non-events, and a notification per dusting airdrop would teach the operator
 * to ignore the notifications that matter.
 */
export async function showCopyDecisions(ctx: Context): Promise<void> {
  await render(ctx, renderCopyDecisions(db.copyDecisions(10)), copyDecisionsKeyboard());
}

export async function showCopySafety(ctx: Context): Promise<void> {
  const limits = db.settings().copySafety;

  await render(
    ctx,
    [
      '<b>🛡 Copy trade safety</b>',
      '',
      'Checked on every copied buy, before any money moves. A token that fails is skipped and never reconsidered.',
      '',
      "<i>Age is measured from the token's first market, not the pool it trades in now — a coin that graduates gets a brand-new pool and would otherwise read as minutes old.</i>",
      '',
      '<i>Both per-coin limits span every wallet you follow. Without them, three traders buying the same coin means three full-size entries — each one only knows what it bought itself.</i>',
      '',
      ...describeLimits(limits).map(l => `· ${l}`),
      '',
      '<i>Only copy trading is gated. Buying by hand shows you the same warnings and lets you decide.</i>',
      '',
      '<i>Unreadable on-chain mint, holder or developer-balance data refuses a copy. Optional index checks can have no answer; absence does not certify safety.</i>',
    ].join('\n'),
    new InlineKeyboard()
      .text(`👥 Top 10 max ${limits.maxTop10Pct}%`, 'safety_top10')
      .primary()
      .row()
      .text(`👤 Dev max ${limits.maxDevPct}%`, 'safety_dev')
      .primary()
      .row()
      .text(
        `🔒 Authorities: ${limits.requireRevokedAuthorities ? 'must be revoked' : 'not checked'}`,
        'safety_auth',
      )
      .row()
      .text(
        limits.minLiquidityUsd > 0
          ? `💧 Liquidity min $${limits.minLiquidityUsd.toLocaleString('en-US')}`
          : '💧 Liquidity not checked',
        'safety_liq',
      )
      .row()
      .text(
        limits.maxAgeHours > 0
          ? `🕐 Max age ${formatAge(limits.maxAgeHours)}`
          : '🕐 Age not checked',
        'safety_age',
      )
      .primary()
      .row()
      .text(
        limits.minVolume1hUsd > 0
          ? `📈 1h volume min $${limits.minVolume1hUsd.toLocaleString('en-US')}`
          : '📈 1h volume not checked',
        'safety_vol',
      )
      .primary()
      .row()
      .text(
        limits.refuseSerialRuggers
          ? '🧑‍💻 Dev rug history: refuse'
          : '🧑‍💻 Dev history: not checked',
        'safety_rugger',
      )
      .primary()
      .row()
      .text(
        limits.maxInsiderPct > 0
          ? `🕸 Connected wallets max ${limits.maxInsiderPct}%`
          : '🕸 Connected wallets not checked',
        'safety_insider',
      )
      .primary()
      .row()
      .text(
        limits.maxDevMints > 0
          ? `🏭 Dev factory max ${limits.maxDevMints} mints`
          : '🏭 Dev factory not checked',
        'safety_factory',
      )
      .primary()
      .row()
      .text(
        limits.minTraders5m > 0
          ? `🧑‍🤝‍🧑 Min ${limits.minTraders5m} traders / 5m`
          : '🧑‍🤝‍🧑 Live market not checked',
        'safety_traders',
      )
      .primary()
      .row()
      .text(
        limits.oneEntryPerMint ? '🚫 Already in it: skip' : '➕ Already in it: buy anyway',
        'safety_oneentry',
      )
      .primary()
      .row()
      .text(
        limits.maxSolPerMint > 0
          ? `🧯 Max ${limits.maxSolPerMint} ◎ per coin`
          : '🧯 No cap per coin',
        'safety_mintcap',
      )
      .primary()
      .row()
      // reachable from both screens, so it offers both ways back
      .text('← Copy trading', 'copy_trade')
      .text('⚙️ Settings', 'settings'),
  );
}

/** Each limit cycles its presets; 100% and $0 are the "not checked" ends. */
export async function cycleSafety(ctx: Context, which: string): Promise<void> {
  const limits = { ...db.settings().copySafety };

  if (which === 'top10') limits.maxTop10Pct = cycleStep(TOP10_STEPS, limits.maxTop10Pct);
  else if (which === 'dev') limits.maxDevPct = cycleStep(DEV_STEPS, limits.maxDevPct);
  else if (which === 'liq') limits.minLiquidityUsd = cycleStep(LIQ_STEPS, limits.minLiquidityUsd);
  else if (which === 'auth') limits.requireRevokedAuthorities = !limits.requireRevokedAuthorities;
  else if (which === 'age') limits.maxAgeHours = cycleStep(AGE_STEPS, limits.maxAgeHours);
  else if (which === 'vol') limits.minVolume1hUsd = cycleStep(VOL_STEPS, limits.minVolume1hUsd);
  else if (which === 'mintcap')
    limits.maxSolPerMint = cycleStep(MINT_CAP_STEPS, limits.maxSolPerMint);
  else if (which === 'oneentry') limits.oneEntryPerMint = !limits.oneEntryPerMint;
  else if (which === 'rugger') limits.refuseSerialRuggers = !limits.refuseSerialRuggers;
  else if (which === 'insider')
    limits.maxInsiderPct = cycleStep(INSIDER_STEPS, limits.maxInsiderPct);
  else if (which === 'factory') limits.maxDevMints = cycleStep(DEVMINT_STEPS, limits.maxDevMints);
  else if (which === 'traders') limits.minTraders5m = cycleStep(TRADERS_STEPS, limits.minTraders5m);

  db.updateSettings({ copySafety: limits });
  await showCopySafety(ctx);
}

/** Wrap around rather than bottoming out, so no tap is a dead end. */
export function cycleStep(steps: number[], current: number): number {
  const i = steps.indexOf(current);
  return steps[(i + 1) % steps.length] ?? steps[0]!;
}
