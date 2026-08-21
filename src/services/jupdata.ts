import { fetchJson, errMessage } from '../util.js';
import { log } from '../logger.js';

/**
 * Jupiter's free token index, for the numbers nobody else hands out.
 *
 * One call, measured at 44ms, no key. Three of its fields matter here and two
 * of them exist nowhere else in this bot's sources:
 *
 *  - **devMints** — how many tokens this developer has minted, ever. Sampled
 *    live across eighteen launches: six had developers past a hundred, the
 *    worst at 11,284. These are factories, and the launch index this bot also
 *    consults topped out around fifty on the same class of wallet.
 *  - **numTraders in the last five minutes** — distinct wallets, not dollars.
 *    A dollar floor is blind to one bot painting volume; a token that three
 *    wallets touched in five minutes has no market whatever its volume reads.
 *  - **organic volume** — Jupiter's own wash-trade split. Measured across
 *    live fresh launches the median organic share was 0.9%, meaning the
 *    classifier does not credit fresh-launch flow at all — so it is shown,
 *    never gated on. A gate here would refuse every young token.
 */

export interface JupTokenData {
  holderCount?: number;
  /** Tokens this developer has minted, including this one. */
  devMints?: number;
  /** Distinct wallets that traded it in the last five minutes. */
  traders5m?: number;
  netBuyers5m?: number;
  /** Share of 5m volume Jupiter believes is organic, 0-100. Display only. */
  organicPct5m?: number;
  organicScore?: number;
  organicScoreLabel?: string;
  topHoldersPct?: number;
  mintAuthorityDisabled?: boolean;
  freezeAuthorityDisabled?: boolean;
  firstPoolAt?: number;
}

interface RawJupToken {
  id: string;
  holderCount?: number;
  audit?: {
    mintAuthorityDisabled?: boolean;
    freezeAuthorityDisabled?: boolean;
    topHoldersPercentage?: number;
    devMints?: number;
  };
  stats5m?: {
    buyVolume?: number;
    sellVolume?: number;
    buyOrganicVolume?: number;
    sellOrganicVolume?: number;
    numTraders?: number;
    numNetBuyers?: number;
  };
  organicScore?: number;
  organicScoreLabel?: string;
  firstPool?: { createdAt?: string };
}

/**
 * Null on any failure, and null is "no answer", never "all clear". A token in
 * its first seconds is often not indexed yet; the checks built on these fields
 * treat absence as too-new rather than as suspicious, because for this source
 * absence usually means exactly that.
 */
export async function getJupTokenData(mint: string, timeoutMs = 2500): Promise<JupTokenData | null> {
  try {
    const res = await fetchJson<RawJupToken[]>(
      `https://lite-api.jup.ag/tokens/v2/search?query=${mint}`,
      { timeoutMs },
    );
    const t = res.find((x) => x.id === mint);
    if (!t) return null;

    const s = t.stats5m ?? {};
    const total = (s.buyVolume ?? 0) + (s.sellVolume ?? 0);
    const organic = (s.buyOrganicVolume ?? 0) + (s.sellOrganicVolume ?? 0);

    return {
      holderCount: t.holderCount,
      devMints: t.audit?.devMints,
      traders5m: s.numTraders,
      netBuyers5m: s.numNetBuyers,
      organicPct5m: total > 0 ? (organic / total) * 100 : undefined,
      organicScore: t.organicScore,
      organicScoreLabel: t.organicScoreLabel,
      topHoldersPct: t.audit?.topHoldersPercentage,
      mintAuthorityDisabled: t.audit?.mintAuthorityDisabled,
      freezeAuthorityDisabled: t.audit?.freezeAuthorityDisabled,
      firstPoolAt: t.firstPool?.createdAt ? Date.parse(t.firstPool.createdAt) : undefined,
    };
  } catch (err) {
    log.warn(`Jupiter token lookup failed for ${mint}: ${errMessage(err)}`);
    return null;
  }
}
