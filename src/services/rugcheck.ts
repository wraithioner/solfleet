import { endpoints } from '../config.js';
import { fetchJson, errMessage } from '../util.js';
import { log } from '../logger.js';

/**
 * A second opinion on a token, from an index that has seen every launch.
 *
 * Three things it knows that this bot cannot work out on its own, and each is
 * a way of losing money that no on-chain read of a single mint reveals:
 *
 *  - **Which holders are the market.** A graduated pump.fun coin keeps most of
 *    its supply in the pool it trades in, and counting that as concentration
 *    puts every graduated token over any sane limit. Measured live, a token
 *    whose real top ten held 19% scored 91% once its pool was counted.
 *  - **Which holders are one person.** Supply spread across twenty fresh
 *    wallets funded from the same place reads as twenty holders and behaves as
 *    one. A launch wallet holding nothing means nothing if the allocation was
 *    bundled out at creation.
 *  - **Who the developer is.** A wallet that has launched fifty coins and
 *    rugged them is the strongest signal there is, and it is invisible from
 *    the token in front of you. Sampled live: two of sixteen fresh launches
 *    were by developers with 50 and 46 prior tokens.
 */

export interface RugcheckRisk {
  name: string;
  level: 'danger' | 'warn' | 'info' | string;
  description?: string;
  score?: number;
}

export interface RugcheckReport {
  /** 1 is clean. Anything into the tens is the index objecting to something. */
  score: number;
  risks: RugcheckRisk[];
  /** Concentration with pools and the launch wallet taken out. */
  top10Pct?: number;
  /**
   * How much of that concentration is a vesting vault rather than a holder.
   *
   * Reported alongside rather than removed, because the index knows an account
   * is a locker but not for how long. The unlock date is read on chain, and
   * only what is genuinely locked past the horizon gets discounted — this is
   * the ceiling on that discount, so a lock outside the counted ten can never
   * subtract from a number it was not part of.
   */
  lockerPct?: number;
  /** Share held by wallets the index believes are one person. */
  insiderPct?: number;
  insiderWallets?: number;
  /** Distinct clusters of related wallets. */
  insiderNetworks?: number;
  /** Every wallet, not just the twenty largest. */
  totalHolders?: number;
  creatorPct?: number;
  /** How many tokens this developer has launched before this one. */
  creatorPriorTokens?: number;
  /** The index's own verdict, when it has one. */
  rugged?: boolean;
  lpLockedPct?: number;
  liquidityUsd?: number;
  /** True when the developer has a recorded history of rugging. */
  creatorRugHistory: boolean;
  /** Symbol claimed by a token that already exists. */
  copycat: boolean;
}

interface RawHolder {
  owner?: string;
  pct?: number;
  insider?: boolean;
}

interface RawReport {
  score_normalised?: number;
  score?: number;
  risks?: RugcheckRisk[];
  topHolders?: RawHolder[];
  knownAccounts?: Record<string, { name?: string; type?: string }>;
  insiderNetworks?: Array<{ size?: number }> | null;
  graphInsidersDetected?: number;
  totalHolders?: number;
  creator?: string;
  creatorBalance?: number;
  creatorTokens?: unknown[] | null;
  token?: { supply?: number; decimals?: number };
  rugged?: boolean;
  totalMarketLiquidity?: number;
  markets?: Array<{ lp?: { lpLockedPct?: number } }>;
}

/**
 * Holders that are somebody's position, rather than the market itself.
 *
 * A pool holding supply is liquidity, not concentration — it is what you sell
 * into. The launch wallet is counted separately because a limit on the
 * developer is a different question from a limit on the top ten.
 */
function counted(raw: RawReport): RawHolder[] | undefined {
  const holders = raw.topHolders;
  if (!holders || holders.length === 0) return undefined;

  const known = raw.knownAccounts ?? {};
  const real = holders.filter((h) => {
    const type = h.owner ? known[h.owner]?.type : undefined;
    return type !== 'AMM' && type !== 'CREATOR';
  });

  return real.slice(0, 10);
}

function concentration(raw: RawReport): number | undefined {
  return counted(raw)?.reduce((sum, h) => sum + (h.pct ?? 0), 0);
}

/**
 * The share of the counted ten that is a locker.
 *
 * Lockers stay in the concentration figure here. Whether they should count is
 * a question about the unlock date, which this index does not report and the
 * chain does — so the decision is made where that is known, and this only says
 * how much is eligible.
 */
function lockedShare(raw: RawReport): number | undefined {
  const holders = counted(raw);
  if (!holders) return undefined;

  const known = raw.knownAccounts ?? {};
  return holders
    .filter((h) => (h.owner ? known[h.owner]?.type : undefined) === 'LOCKER')
    .reduce((sum, h) => sum + (h.pct ?? 0), 0);
}

function insiderShare(raw: RawReport): number | undefined {
  const holders = raw.topHolders;
  if (!holders) return undefined;
  const known = raw.knownAccounts ?? {};
  const flagged = holders.filter(
    (h) => h.insider && (h.owner ? known[h.owner]?.type : undefined) !== 'AMM',
  );
  if (flagged.length === 0) return 0;
  return flagged.reduce((sum, h) => sum + (h.pct ?? 0), 0);
}

function named(risks: RugcheckRisk[] | undefined, pattern: RegExp): boolean {
  return (risks ?? []).some((r) => pattern.test(r.name ?? ''));
}

/**
 * Ask the index about one mint.
 *
 * Null on any failure, and the caller treats that as "no second opinion"
 * rather than as a clean bill of health — a check that fails open is worse
 * than no check, because it reads like one that passed.
 */
export async function getRugcheck(mint: string, timeoutMs = 4000): Promise<RugcheckReport | null> {
  try {
    const raw = await fetchJson<RawReport>(`${endpoints.rugcheck}/${mint}/report`, { timeoutMs });

    const supply = raw.token?.supply ?? 0;
    const creatorPct =
      supply > 0 && raw.creatorBalance !== undefined
        ? (raw.creatorBalance / supply) * 100
        : undefined;

    return {
      score: raw.score_normalised ?? raw.score ?? 0,
      risks: raw.risks ?? [],
      top10Pct: concentration(raw),
      lockerPct: lockedShare(raw),
      insiderPct: insiderShare(raw),
      insiderWallets: raw.graphInsidersDetected,
      insiderNetworks: (raw.insiderNetworks ?? []).length,
      totalHolders: raw.totalHolders,
      creatorPct,
      creatorPriorTokens: (raw.creatorTokens ?? []).length,
      rugged: raw.rugged,
      lpLockedPct: raw.markets?.[0]?.lp?.lpLockedPct,
      liquidityUsd: raw.totalMarketLiquidity,
      creatorRugHistory: named(raw.risks, /rugged|rug pull|history of rug/i),
      copycat: named(raw.risks, /copycat/i),
    };
  } catch (err) {
    log.warn(`Rugcheck lookup failed for ${mint}: ${errMessage(err)}`);
    return null;
  }
}
