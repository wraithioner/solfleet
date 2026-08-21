import { pMap } from '../util.js';
import { fetchBondingCurve, curvePrice } from '../trade/curve.js';
import { getSolanaPrices, getSolPrice } from './prices.js';

/**
 * What one token is worth in SOL, right now.
 *
 * Order matters here. A pump.fun token that has not graduated is usually
 * unknown to Jupiter — for the first minutes of its life, which is exactly when
 * a stop-loss matters most, the bonding curve is the only price that exists.
 * Reading the curve first means an automated rule works from launch rather than
 * from whenever an aggregator gets around to indexing the token.
 *
 * SOL is the unit throughout so a rule cannot be tripped by SOL's own move
 * against the dollar.
 */
export async function priceInSol(mint: string): Promise<number | null> {
  try {
    const curve = await fetchBondingCurve(mint);
    if (curve && !curve.complete) {
      const price = curvePrice(curve);
      if (price > 0) return price;
    }
  } catch {
    /* fall through to the aggregator */
  }

  try {
    const [prices, solUsd] = await Promise.all([getSolanaPrices([mint]), getSolPrice()]);
    const usd = prices.get(mint);
    if (usd !== undefined && solUsd > 0) return usd / solUsd;
  } catch {
    /* no price available */
  }

  return null;
}

/** Batched form. Curve reads are per-mint; the aggregator leg is one call. */
export async function pricesInSol(mints: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (mints.length === 0) return out;

  /*
   * Every curve at once, rather than one after another.
   *
   * This runs on the loop that fires stop-losses, and it used to await each
   * mint's curve account in turn — so with seven rules armed the seventh price
   * was six round trips stale before anything looked at it, and every tick
   * carried that delay before a single rule could be evaluated. The reads are
   * independent; only the ordering was.
   *
   * Bounded rather than unbounded: a wallet with thirty rules should not open
   * thirty simultaneous requests to an endpoint that counts them.
   */
  const unresolved: string[] = [];

  await pMap(mints, 8, async (mint) => {
    try {
      const curve = await fetchBondingCurve(mint);
      if (curve && !curve.complete) {
        const price = curvePrice(curve);
        if (price > 0) {
          out.set(mint, price);
          return;
        }
      }
    } catch {
      /* try the aggregator instead */
    }
    unresolved.push(mint);
  });

  if (unresolved.length > 0) {
    try {
      const [prices, solUsd] = await Promise.all([getSolanaPrices(unresolved), getSolPrice()]);
      if (solUsd > 0) {
        for (const mint of unresolved) {
          const usd = prices.get(mint);
          if (usd !== undefined) out.set(mint, usd / solUsd);
        }
      }
    } catch {
      /* leave them unpriced — a missing price must never fire a rule */
    }
  }

  return out;
}
