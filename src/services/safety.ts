import type { TokenInfo } from './tokeninfo.js';

/**
 * The check that stands between a followed wallet and your money.
 *
 * Copy trading has no human in the loop. Every other buy in this bot is a
 * deliberate tap on a screen that already lists the warnings; a copied one
 * happens while nobody is looking, sized from somebody else's conviction, into
 * a token nobody here has read. That is the one place a rule has to say no on
 * its own.
 *
 * Kept pure and separate from the RPC so the decision that spends money can be
 * tested exhaustively without a network.
 */

export interface SafetyLimits {
  /** Refuse when the top ten wallets hold more than this share of supply. */
  maxTop10Pct: number;
  /** Refuse when the launch wallet still holds more than this share. */
  maxDevPct: number;
  /** Refuse a mint that can still be frozen or inflated. */
  requireRevokedAuthorities: boolean;
  /** Refuse a pool too thin to sell back into. Zero disables the check. */
  minLiquidityUsd: number;
  /**
   * Refuse a token whose market is older than this. Zero disables the check.
   *
   * Measured from the first market the token ever had, not the pool it trades
   * in now — see the note on `pairCreatedAt` in tokeninfo.
   */
  maxAgeHours: number;
  /**
   * Refuse a token nobody has traded in the last hour. Zero disables the check.
   *
   * An hour rather than a day, and this is the whole point of the check. Live
   * pump.fun launches observed on chain did $9k–$416k of volume in their first
   * hour, so a floor here costs nothing on a fresh coin. Dead ones are only
   * visible at this resolution: one sampled token showed $67,602 of 24-hour
   * volume and exactly zero in the last hour, having already been through its
   * entire life. On the daily figure it looks like one of the most active
   * tokens on the list.
   */
  minVolume1hUsd: number;
}

export const DEFAULT_SAFETY: SafetyLimits = {
  maxTop10Pct: 20,
  maxDevPct: 1,
  requireRevokedAuthorities: true,
  minLiquidityUsd: 3_000,
  maxAgeHours: 72,
  minVolume1hUsd: 1_000,
};

/**
 * Bumped when the shipped defaults get stricter.
 *
 * Settings are stored, so a stored copy keeps whatever was current when it was
 * written — including limits that were only ever the defaults nobody chose. A
 * version marker lets a genuinely stricter set replace those without
 * overwriting a limit the operator picked deliberately afterwards.
 */
export const SAFETY_VERSION = 3;

export interface SafetyVerdict {
  safe: boolean;
  /** Why it was refused, in the order they matter. Empty when safe. */
  reasons: string[];
  /** Things worth saying that are not grounds to refuse. */
  notes: string[];
}

/**
 * Judge a token against the limits.
 *
 * Unknown is treated as unsafe throughout. A holder query that got rate limited
 * returns no concentration figure, and reading that as "concentration is fine"
 * is how an automated buyer walks into precisely the token this exists to
 * avoid — the absence of evidence is not evidence of absence when the evidence
 * is what decides whether you can sell.
 */
export function assessToken(info: TokenInfo, limits: SafetyLimits = DEFAULT_SAFETY): SafetyVerdict {
  const reasons: string[] = [];
  const notes: string[] = [];

  /*
   * Freeze authority is the Solana honeypot.
   *
   * There is no "sell tax" or blacklist function here as there is on an EVM
   * chain — a Solana deployer who wants to trap holders freezes their token
   * accounts, and a frozen account cannot transfer, which means it cannot sell,
   * and no chart shows it coming. A live freeze authority is the single most
   * reliable signal that a position may be one-way.
   */
  /*
   * Token-2022 lets a deployer attach behaviour to the mint itself, so both
   * authorities can read "revoked" on a token that still cannot be sold. These
   * are checked regardless of the authority setting — a transfer hook that
   * refuses your sale is not a matter of policy preference.
   */
  for (const trap of info.traps ?? []) {
    reasons.push(`Token-2022: ${trap}.`);
  }

  if (limits.requireRevokedAuthorities) {
    if (info.freezeAuthority) {
      reasons.push('Freeze authority is live — the deployer can freeze your account and stop you selling.');
    } else if (info.freezeAuthority === undefined) {
      reasons.push('Could not read the freeze authority — honeypot risk is unknown, not absent.');
    }

    if (info.mintAuthority) {
      reasons.push('Mint authority is live — supply can be created and sold into the pool at any time.');
    }
  }

  if (info.top10Pct === undefined) {
    if (info.holdersUnavailable) {
      reasons.push('Holder distribution could not be read — concentration is unknown, not zero.');
    }
  } else if (info.top10Pct > limits.maxTop10Pct) {
    reasons.push(`Top 10 hold ${info.top10Pct.toFixed(1)}% of supply, over the ${limits.maxTop10Pct}% limit.`);
  }

  if (info.creatorHoldsPct !== undefined && info.creatorHoldsPct > limits.maxDevPct) {
    reasons.push(
      `The launch wallet holds ${info.creatorHoldsPct.toFixed(1)}% of supply, over the ${limits.maxDevPct}% limit.`,
    );
  }

  /*
   * Liquidity is only meaningful once there is a pool. A token still on its
   * bonding curve has no pool by definition and is not thin for that reason —
   * the curve will always fill, at a price.
   */
  if (limits.minLiquidityUsd > 0 && !isOnCurve(info)) {
    if (info.liquidityUsd === undefined) {
      reasons.push('No indexed market found — there may be nothing to sell back into.');
    } else if (info.liquidityUsd < limits.minLiquidityUsd) {
      reasons.push(
        `Only $${Math.round(info.liquidityUsd).toLocaleString('en-US')} of liquidity, under the ` +
          `$${limits.minLiquidityUsd.toLocaleString('en-US')} floor.`,
      );
    }
  }

  /*
   * How old the token is, and whether anyone is still trading it.
   *
   * These are one idea in two checks. Age alone is blunt — a two-day-old coin
   * doing real volume is a perfectly good trade — and volume alone lets a coin
   * that pumps once a week through on the hour it happens to be moving.
   * Together they describe the only thing that matters: is there a live market
   * here, or am I buying somebody's exit.
   */
  if (limits.maxAgeHours > 0 && info.pairCreatedAt !== undefined) {
    const ageHours = (Date.now() - info.pairCreatedAt) / 3_600_000;
    if (ageHours > limits.maxAgeHours) {
      reasons.push(
        `First traded ${formatAge(ageHours)} ago, past the ${formatAge(limits.maxAgeHours)} limit.`,
      );
    }
  }

  /*
   * An unknown age passes, which is the one place this file does not treat
   * unknown as unsafe, and it is deliberate rather than an oversight.
   *
   * Everywhere else the missing fact could be hiding something bad. Here it
   * cannot: a token with no indexed market has not been trading for days, it
   * has not been trading at all. The absence points the opposite way — towards
   * a launch so recent nothing has listed it yet — and refusing on it would
   * block every genuinely fresh coin, which is the entire reason to copy
   * somebody. The volume floor below is what covers this case.
   */

  if (limits.minVolume1hUsd > 0) {
    if (info.volume1h !== undefined) {
      if (info.volume1h < limits.minVolume1hUsd) {
        reasons.push(
          `Only $${Math.round(info.volume1h).toLocaleString('en-US')} traded in the last hour, under the ` +
            `$${limits.minVolume1hUsd.toLocaleString('en-US')} floor — no volume, no exit.`,
        );
      }
    } else if (!isOnCurve(info)) {
      // no market data and no curve to sell back into: nothing says this can be
      // sold at all, which is exactly the shape of a token that cannot be
      reasons.push('No trading volume could be read — there may be no live market at all.');
    }
  }

  // worth knowing, not worth refusing over
  if (info.creatorHoldsPct !== undefined && info.creatorHoldsPct > 5 && info.creatorHoldsPct <= limits.maxDevPct) {
    notes.push(`Launch wallet holds ${info.creatorHoldsPct.toFixed(1)}%.`);
  }
  if (info.pairCreatedAt && Date.now() - info.pairCreatedAt < 3_600_000) {
    notes.push(`Pair is ${Math.round((Date.now() - info.pairCreatedAt) / 60_000)} minutes old.`);
  }

  return { safe: reasons.length === 0, reasons, notes };
}

/** A pump.fun token that has not graduated has a curve, not a pool. */
function isOnCurve(info: TokenInfo): boolean {
  return info.isPumpFun === true && info.curveComplete !== true;
}

/** One line per limit, for the screen that configures them. */
export function describeLimits(limits: SafetyLimits): string[] {
  return [
    `Top 10 holders: refuse above <b>${limits.maxTop10Pct}%</b>`,
    `Launch wallet: refuse above <b>${limits.maxDevPct}%</b>`,
    `Mint and freeze authority: <b>${limits.requireRevokedAuthorities ? 'must be revoked' : 'not checked'}</b>`,
    limits.minLiquidityUsd > 0
      ? `Liquidity: refuse under <b>$${limits.minLiquidityUsd.toLocaleString('en-US')}</b>`
      : 'Liquidity: <b>not checked</b>',
    limits.maxAgeHours > 0
      ? `Age: refuse older than <b>${formatAge(limits.maxAgeHours)}</b>`
      : 'Age: <b>not checked</b>',
    limits.minVolume1hUsd > 0
      ? `1h volume: refuse under <b>$${limits.minVolume1hUsd.toLocaleString('en-US')}</b>`
      : '1h volume: <b>not checked</b>',
  ];
}

/** Hours as something readable — "36h" is worse than "1.5 days" at a glance. */
export function formatAge(hours: number): string {
  if (hours < 1) return `${Math.round(hours * 60)}m`;
  if (hours < 48) return `${Math.round(hours)}h`;
  const days = hours / 24;
  return `${days % 1 === 0 ? days : days.toFixed(1)} days`;
}
