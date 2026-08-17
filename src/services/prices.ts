import { endpoints } from '../config.js';
import { fetchJson, chunk } from '../util.js';
import { WSOL_MINT } from '../chains/solana.js';
import { log } from '../logger.js';
import type { EvmChain } from '../types.js';

/**
 * USD pricing. Every lookup is cached briefly — a portfolio refresh across
 * dozens of wallets would otherwise hammer these public endpoints and get us
 * rate limited exactly when we most want a number on screen.
 */

const TTL_MS = 60_000;

interface CacheEntry {
  value: number;
  at: number;
}

const cache = new Map<string, CacheEntry>();

function cached(key: string): number | undefined {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  return undefined;
}

function store(key: string, value: number): number {
  cache.set(key, { value, at: Date.now() });
  return value;
}

// ── Solana ────────────────────────────────────────────────────────────────────

/**
 * Price API v3 returns a flat map keyed by mint — no `data` wrapper — and calls
 * the field `usdPrice`. v2 used `data` + `price` and now 404s.
 */
interface JupPriceEntry {
  usdPrice: number;
  decimals?: number;
  priceChange24h?: number;
  liquidity?: number;
}

/** USD price for a set of Solana mints. Missing mints simply stay absent. */
export async function getSolanaPrices(mints: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const missing: string[] = [];

  for (const m of mints) {
    const hit = cached(`sol:${m}`);
    if (hit !== undefined) out.set(m, hit);
    else missing.push(m);
  }

  // the price endpoint accepts a limited id list per request
  for (const group of chunk([...new Set(missing)], 50)) {
    try {
      const res = await fetchJson<Record<string, JupPriceEntry | null>>(
        `${endpoints.jupiterPrice}?ids=${group.join(',')}`,
        { timeoutMs: 12_000 },
      );
      for (const [mint, entry] of Object.entries(res ?? {})) {
        const price = Number(entry?.usdPrice);
        if (Number.isFinite(price) && price > 0) out.set(mint, store(`sol:${mint}`, price));
      }
    } catch (err) {
      log.warn(`Price lookup failed for ${group.length} mints`, err);
    }
  }

  return out;
}

export async function getSolPrice(): Promise<number> {
  const prices = await getSolanaPrices([WSOL_MINT]);
  return prices.get(WSOL_MINT) ?? 0;
}

/**
 * Fallback for tokens Jupiter has no route for — brand new pump.fun launches
 * often are not indexed for the first few minutes.
 */
export async function getDexscreenerPrice(mint: string): Promise<number | undefined> {
  const key = `dex:${mint}`;
  const hit = cached(key);
  if (hit !== undefined) return hit;

  try {
    const res = await fetchJson<{
      pairs: Array<{
        baseToken?: { address?: string };
        priceUsd?: string;
        liquidity?: { usd?: number };
      }> | null;
    }>(`${endpoints.dexscreenerTokens}/${mint}`, { timeoutMs: 12_000 });

    // priceUsd describes the pair's BASE token, so a pair where our mint is the
    // quote side would quote a completely unrelated token
    const pairs = (res.pairs ?? []).filter(
      (p) => p.baseToken?.address?.toLowerCase() === mint.toLowerCase(),
    );
    if (pairs.length === 0) return undefined;

    // pick the deepest pool; thin pools quote nonsense
    const best = pairs.reduce((a, b) => ((b.liquidity?.usd ?? 0) > (a.liquidity?.usd ?? 0) ? b : a));
    const price = Number(best.priceUsd);
    return Number.isFinite(price) ? store(key, price) : undefined;
  } catch {
    return undefined;
  }
}

// ── EVM native coins ──────────────────────────────────────────────────────────

const COINGECKO_IDS: Record<EvmChain, string> = {
  ethereum: 'ethereum',
  base: 'ethereum',
  arbitrum: 'ethereum',
  optimism: 'ethereum',
  bsc: 'binancecoin',
  polygon: 'matic-network',
};

export async function getNativePrices(chains: EvmChain[]): Promise<Map<EvmChain, number>> {
  const out = new Map<EvmChain, number>();
  if (chains.length === 0) return out;

  const wanted = [...new Set(chains.map((c) => COINGECKO_IDS[c]))];
  const missing = wanted.filter((id) => cached(`cg:${id}`) === undefined);

  if (missing.length > 0) {
    try {
      const data = await fetchJson<Record<string, { usd: number }>>(
        `https://api.coingecko.com/api/v3/simple/price?ids=${missing.join(',')}&vs_currencies=usd`,
        { timeoutMs: 12_000 },
      );
      for (const [id, entry] of Object.entries(data)) {
        if (typeof entry?.usd === 'number') store(`cg:${id}`, entry.usd);
      }
    } catch (err) {
      log.warn('Native price lookup failed', err);
    }
  }

  for (const c of chains) {
    const price = cached(`cg:${COINGECKO_IDS[c]}`);
    if (price !== undefined) out.set(c, price);
  }

  return out;
}

export function clearPriceCache(): void {
  cache.clear();
}
