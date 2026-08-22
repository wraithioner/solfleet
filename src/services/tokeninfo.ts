import { PublicKey } from '@solana/web3.js';
import { rpc, getMintBalances } from '../chains/solana.js';
import { endpoints, EVM_LOOKUP_CHAINS } from '../config.js';
import { fetchJson, errMessage } from '../util.js';
import { log } from '../logger.js';
import { fetchBondingCurve, curveMarketCapSol, curveProgress, bondingCurvePda } from '../trade/curve.js';
import { getSolPrice } from './prices.js';
import { getTokenMetadata } from './metadata.js';
import { getMintAuthorities } from './mintauth.js';
import { getRugcheck } from './rugcheck.js';
import { getJupTokenData } from './jupdata.js';
import { readTokenLocks, lockedBeyond, furthestUnlock, DEFAULT_LOCK_HORIZON_DAYS, DAY_MS, type LockedSupply } from './locks.js';
import { allWallets } from '../store/wallets.js';
import type { Chain } from '../types.js';

/**
 * Everything worth knowing about a token, assembled from three sources:
 * DexScreener for market data, the chain itself for holder distribution, and
 * the pump.fun curve for pre-graduation tokens that no DEX has indexed yet.
 */

export interface HolderInfo {
  owner: string;
  amount: number;
  pctOfSupply: number;
  /** Set when we can name the holder: our own wallet, the curve, a pool, ... */
  tag?: string;
}

export interface TokenInfo {
  address: string;
  chain: Chain;
  /** The chain as the indexer names it — may be one this bot has no RPC for. */
  chainLabel?: string;
  name?: string;
  symbol?: string;
  /** Token logo, used as the photo on the info card. */
  imageUrl?: string;
  description?: string;
  priceUsd?: number;
  priceChange24h?: number;
  priceChange1h?: number;
  marketCap?: number;
  fdv?: number;
  liquidityUsd?: number;
  volume24h?: number;
  volume1h?: number;
  buys24h?: number;
  sells24h?: number;
  pairCreatedAt?: number;
  dex?: string;
  websites?: string[];
  socials?: string[];

  /** pump.fun specific. */
  isPumpFun?: boolean;
  curveComplete?: boolean;
  curveProgressPct?: number;
  curveMcapSol?: number;
  /** The wallet that launched the coin, from the bonding curve account. */
  creator?: string;
  /** How much of the supply the launcher still holds, as a percentage. */
  creatorHoldsPct?: number;

  totalSupply?: number;
  /** Needed to turn a raw balance into a human amount. */
  decimals?: number;
  /** Set = someone can mint more supply. null = revoked. undefined = unread. */
  mintAuthority?: string | null;
  /** Set = someone can freeze your account so you cannot sell. */
  freezeAuthority?: string | null;
  /** Mint belongs to Token-2022, which can attach behaviour to transfers. */
  token2022?: boolean;
  /** Token-2022 extensions that can stop or tax a sale. Empty = none found. */
  traps?: string[];
  holders?: HolderInfo[];
  /** True when the holder query failed — distinct from "no holders". */
  holdersUnavailable?: boolean;
  top10Pct?: number;
  /** Share of supply in a vesting vault, of the concentration figure above. */
  lockerPct?: number;
  /**
   * Every vesting stream still holding supply, and when each one releases.
   *
   * Kept as the list rather than a single locked figure, because how far away
   * an unlock has to be before it stops counting is the operator's setting —
   * the gate applies it, this only reports what is there.
   */
  lockedSupply?: LockedSupply[];
  /** Share handed out through streams that locked nothing, and to how many. */
  launchDistPct?: number;
  launchDistWallets?: number;
  /** How much of the supply the operator's own wallets control. */
  ownedPct?: number;
  ownedAmount?: number;

  /* ── from the launch index ───────────────────────────────────────────── */
  /** 1 is clean; tens and above mean the index objected to something. */
  rugcheckScore?: number;
  rugcheckRisks?: Array<{ name: string; level: string }>;
  /**
   * Supply held by wallets the index believes are one person.
   *
   * The number a launch-wallet check cannot produce. Spreading an allocation
   * across twenty fresh wallets at creation shows a developer holding nothing
   * while one person still decides when the supply hits the market.
   */
  insiderPct?: number;
  insiderWallets?: number;
  /** Every holder, not only the twenty largest accounts. */
  holderCount?: number;
  /** Tokens this developer launched before this one. */
  creatorPriorTokens?: number;
  /** The developer has a recorded history of rugging what they launch. */
  creatorRugHistory?: boolean;
  /** Claims a symbol that already belongs to something else. */
  copycat?: boolean;
  /** The index's own verdict that this one is already over. */
  rugged?: boolean;
  lpLockedPct?: number;

  /* ── from Jupiter's token index ──────────────────────────────────────── */
  /** Tokens this developer has minted, ever. Hundreds means a factory. */
  devMints?: number;
  /** Distinct wallets that traded it in the last five minutes. */
  traders5m?: number;
  netBuyers5m?: number;
  /** Share of 5m volume Jupiter reads as organic. Display only — see jupdata. */
  organicPct5m?: number;
  organicScoreLabel?: string;

  warnings: string[];
}

// ── address detection ─────────────────────────────────────────────────────────

const SOLANA_MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const EVM_ADDR_RE = /^0x[a-fA-F0-9]{40}$/;

/** Pull a token address out of arbitrary pasted text, if there is one. */
export function extractTokenAddress(text: string): { address: string; kind: 'solana' | 'evm' } | null {
  const cleaned = text.trim();

  // handle pasted links: pump.fun/coin/<mint>, dexscreener.com/solana/<pair>, ...
  const fromUrl = cleaned.match(/(?:coin|token|solana|ethereum|base|bsc|arbitrum|polygon)\/([1-9A-HJ-NP-Za-km-z]{32,44}|0x[a-fA-F0-9]{40})/);
  const candidate = fromUrl?.[1] ?? cleaned.split(/\s+/).find((w) => SOLANA_MINT_RE.test(w) || EVM_ADDR_RE.test(w));

  if (!candidate) return null;
  if (EVM_ADDR_RE.test(candidate)) return { address: candidate, kind: 'evm' };

  // a base58 string of the right length is not necessarily a valid pubkey
  try {
    new PublicKey(candidate);
    return { address: candidate, kind: 'solana' };
  } catch {
    return null;
  }
}

// ── DexScreener ───────────────────────────────────────────────────────────────

interface DexPair {
  chainId: string;
  dexId: string;
  baseToken: { address: string; name: string; symbol: string };
  priceUsd?: string;
  txns?: { h24?: { buys: number; sells: number } };
  volume?: { h24?: number; h1?: number };
  priceChange?: { h24?: number; h1?: number };
  liquidity?: { usd?: number };
  fdv?: number;
  marketCap?: number;
  pairCreatedAt?: number;
  info?: {
    imageUrl?: string;
    header?: string;
    websites?: Array<{ url: string }>;
    socials?: Array<{ type: string; url: string }>;
  };
}

const DEX_CHAIN_MAP: Record<string, Chain> = {
  solana: 'solana',
  ethereum: 'ethereum',
  base: 'base',
  bsc: 'bsc',
  arbitrum: 'arbitrum',
  polygon: 'polygon',
  optimism: 'optimism',
};

function dexChainToChain(chainId: string): Chain | undefined {
  return DEX_CHAIN_MAP[chainId];
}

/**
 * Pairs for one token on one specific chain.
 *
 * Every field DexScreener reports — price, mcap, volume — describes the pair's
 * BASE token, so pairs where our address is the quote side are dropped.
 */
async function fetchPairsOnChain(chainId: string, address: string): Promise<DexPair[]> {
  try {
    const res = await fetchJson<DexPair[] | { pairs?: DexPair[] }>(
      `${endpoints.dexscreenerPairs}/${chainId}/${address}`,
      { timeoutMs: 12_000 },
    );
    const pairs = Array.isArray(res) ? res : (res.pairs ?? []);
    return pairs.filter((p) => p.baseToken?.address?.toLowerCase() === address.toLowerCase());
  } catch {
    return [];
  }
}

/**
 * Last resort: ask DexScreener where this token trades, on any chain at all.
 *
 * The scoped lookup exists because an address is not unique across chains and
 * this endpoint will happily answer with a fork's pair — querying USDT here
 * once returned only pulsechain and reported $0.0009 instead of $0.9993. It is
 * safe as a *fallback* though: it only runs when none of the known chains had a
 * market, so there is no correct answer being overridden, and the chain it
 * found is displayed on the card so the operator can see what they are looking
 * at. This is what lets a token on a brand new L2 resolve at all.
 */
async function fetchPairsAnywhere(address: string): Promise<DexPair[]> {
  try {
    const res = await fetchJson<{ pairs?: DexPair[] | null }>(
      `${endpoints.dexscreenerTokens}/${address}`,
      { timeoutMs: 12_000 },
    );
    return (res.pairs ?? []).filter(
      (p) => p.baseToken?.address?.toLowerCase() === address.toLowerCase(),
    );
  } catch {
    return [];
  }
}

async function loadMarketData(address: string, kind: 'solana' | 'evm'): Promise<Partial<TokenInfo>> {
  try {
    // An EVM address is not unique across chains — forks reuse the exact same
    // contract address — so search each chain explicitly instead of trusting an
    // unscoped lookup to guess right.
    let pairs =
      kind === 'solana'
        ? await fetchPairsOnChain('solana', address)
        : (await Promise.all(EVM_LOOKUP_CHAINS.map((c) => fetchPairsOnChain(c, address)))).flat();

    // nothing on any chain we know by name — widen the search rather than
    // reporting a token that plainly exists as "unknown"
    if (pairs.length === 0 && kind === 'evm') {
      pairs = await fetchPairsAnywhere(address);
    }

    if (pairs.length === 0) return {};

    // the deepest pool is the one whose price and market cap mean anything
    const best = pairs.reduce((a, b) => ((b.liquidity?.usd ?? 0) > (a.liquidity?.usd ?? 0) ? b : a));

    /*
     * Age comes from the FIRST market, not the deepest one.
     *
     * These are usually the same pair and occasionally are not, and the
     * exception is the case that matters. A pump.fun token graduates into a new
     * PumpSwap pool, and that pool is minutes old on a coin that launched days
     * ago — it is also always the deepest, because the curve it replaced is
     * drained on migration. Read from `best`, a token seen on chain launching
     * 5.8 days ago reported an age of one hour, and every one of these observed
     * live was in that direction: 1.2d read as 0.2d, 2.1d as 0.05d.
     *
     * A copy-trade age limit built on that number would wave through precisely
     * the coins it exists to refuse, so it is built on the oldest pair instead.
     */
    const firstMarket = pairs.reduce(
      (a, b) => ((b.pairCreatedAt ?? Infinity) < (a.pairCreatedAt ?? Infinity) ? b : a),
    );

    /*
     * Volume is summed across every venue; price and liquidity are not.
     *
     * "Is anybody trading this" is a question about the token, and a coin whose
     * flow moved to a second pool is being traded just as much as before —
     * reading one pool would call it dead. Checked against BONK, whose deepest
     * indexed pool showed nothing in the last hour while the token was plainly
     * still trading elsewhere.
     *
     * Price and market cap stay with the deepest pool because they are not
     * additive, and liquidity stays there too: it stands for what one sale can
     * actually get out, and adding up five thin pools describes an exit nobody
     * can take in a single swap.
     */
    const sum = (pick: (p: DexPair) => number | undefined): number | undefined => {
      const seen = pairs.map(pick).filter((n): n is number => typeof n === 'number');
      return seen.length > 0 ? seen.reduce((a, b) => a + b, 0) : undefined;
    };

    return {
      chain: dexChainToChain(best.chainId),
      // the chain exactly as DexScreener names it, including chains this bot has
      // no `Chain` value for — without it a Robinhood Chain token would silently
      // render as Ethereum
      chainLabel: best.chainId,
      name: best.baseToken?.name,
      symbol: best.baseToken?.symbol,
      priceUsd: best.priceUsd ? Number(best.priceUsd) : undefined,
      priceChange24h: best.priceChange?.h24,
      priceChange1h: best.priceChange?.h1,
      marketCap: best.marketCap,
      fdv: best.fdv,
      liquidityUsd: best.liquidity?.usd,
      volume24h: sum((p) => p.volume?.h24),
      volume1h: sum((p) => p.volume?.h1),
      buys24h: sum((p) => p.txns?.h24?.buys),
      sells24h: sum((p) => p.txns?.h24?.sells),
      pairCreatedAt: firstMarket.pairCreatedAt,
      dex: best.dexId,
      imageUrl: best.info?.imageUrl,
      websites: best.info?.websites?.map((w) => w.url),
      socials: best.info?.socials?.map((s) => s.url),
    };
  } catch (err) {
    log.warn(`DexScreener lookup failed for ${address}: ${errMessage(err)}`);
    return {};
  }
}

// ── Solana holder distribution ────────────────────────────────────────────────

/**
 * How long the card will wait for holder concentration before giving up on it.
 *
 * `getTokenLargestAccounts` is an index query, and providers throttle it harder
 * than anything else the card needs — Helius returns "account index service
 * overloaded" under load, which the retry then sits through three times. The
 * card renders perfectly well without this section and says so when it is
 * missing, so it is not worth making the price, market cap and safety checks
 * wait ten seconds behind it.
 */
const HOLDER_DEADLINE_MS = 4000;

/**
 * How long a copied buy will wait for the same query.
 *
 * A card is read by somebody who can wait four seconds. A copied entry is a
 * race, and four seconds is a materially worse fill on a token doing its first
 * minutes. Measured against a live endpoint the whole lookup took 4001ms and
 * the holder query contributed nothing to any of it — it timed out every time,
 * while the launch index answered in 116ms with a concentration figure that is
 * better anyway, because it can tell a pool from a whale.
 *
 * Kept as a short wait rather than removed, so the on-chain read still covers
 * the case where the index is unreachable and the RPC is quick.
 */
const FAST_HOLDER_DEADLINE_MS = 1200;

/**
 * How long the lock lookup gets.
 *
 * Same reasoning as the holder deadline above and a different number, because
 * this query is worth more. It answered in 530ms on measurement and it is what
 * stops a coin being refused over supply locked until 2095 — so a copied entry
 * waits for it rather than skipping it, just not indefinitely.
 */
const LOCK_DEADLINE_MS = 4000;
const FAST_LOCK_DEADLINE_MS = 1500;

/**
 * Programs whose token accounts are a market rather than somebody's position.
 *
 * Excluding the bonding curve was not enough. A pump.fun coin that graduates
 * moves its supply into an AMM pool, and that pool is then the largest holder
 * by a distance — measured live on a graduated token, the pool alone held
 * 72.2% and the top ten came to 91.3% with it counted against 19.1% without.
 * Against a 20% limit that is the difference between refusing every graduated
 * token and judging it on its actual distribution.
 */
const POOL_PROGRAMS = new Set([
  'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA', // PumpSwap
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', // Raydium AMM v4
  'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C', // Raydium CPMM
  'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK', // Raydium CLMM
  'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc', // Orca Whirlpool
  'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo', // Meteora DLMM
  'Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB', // Meteora pools
  'srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX', // OpenBook
]);

/**
 * Which of these owners are pools, decided by the program that owns them.
 *
 * One batched read. A pool's authority is a program-derived address, so the
 * account behind it belongs to the AMM rather than to the system program —
 * which is the difference between liquidity and a whale.
 */
async function poolOwners(owners: string[]): Promise<Set<string>> {
  const pools = new Set<string>();
  if (owners.length === 0) return pools;

  try {
    const infos = await rpc().getMultipleAccountsInfo(owners.map((o) => new PublicKey(o)));
    owners.forEach((owner, i) => {
      const program = infos[i]?.owner?.toBase58();
      if (program && POOL_PROGRAMS.has(program)) pools.add(owner);
    });
  } catch {
    // an unreadable owner is left as a holder: over-counting concentration
    // refuses a trade, under-counting takes one, and the first is cheaper
  }
  return pools;
}

async function loadSolanaHolders(mint: string, deadlineMs = HOLDER_DEADLINE_MS): Promise<Partial<TokenInfo>> {
  const timeout = new Promise<Partial<TokenInfo>>((resolve) =>
    setTimeout(() => resolve({ holdersUnavailable: true }), deadlineMs).unref?.(),
  );
  return Promise.race([readSolanaHolders(mint), timeout]);
}

async function readSolanaHolders(mint: string): Promise<Partial<TokenInfo>> {
  try {
    const mintKey = new PublicKey(mint);

    const [supplyRes, largest] = await Promise.all([
      rpc().getTokenSupply(mintKey),
      rpc().getTokenLargestAccounts(mintKey),
    ]);

    const decimals = supplyRes.value.decimals;
    const totalSupply = Number(supplyRes.value.amount) / 10 ** decimals;
    if (totalSupply === 0) return { totalSupply: 0, decimals, holders: [] };

    const accounts = largest.value.slice(0, 20);
    if (accounts.length === 0) return { totalSupply, decimals, holders: [] };

    // getTokenLargestAccounts returns token accounts, not owners — resolve them
    const parsed = await rpc().getMultipleParsedAccounts(accounts.map((a) => a.address));

    const curvePda = bondingCurvePda(mint).toBase58();
    const ourAddresses = new Set(allWallets().filter((w) => w.kind === 'solana').map((w) => w.address));

    const holders: HolderInfo[] = [];

    accounts.forEach((acc, i) => {
      const data = parsed.value[i]?.data;
      const owner =
        data && typeof data === 'object' && 'parsed' in data
          ? ((data as { parsed: { info?: { owner?: string } } }).parsed?.info?.owner ?? acc.address.toBase58())
          : acc.address.toBase58();

      const amount = Number(acc.uiAmountString ?? 0);
      if (amount === 0) return;

      let tag: string | undefined;
      if (owner === curvePda) tag = 'bonding curve';
      else if (ourAddresses.has(owner)) tag = 'you';

      holders.push({
        owner,
        amount,
        pctOfSupply: (amount / totalSupply) * 100,
        tag,
      });
    });

    holders.sort((a, b) => b.amount - a.amount);

    // the curve is one kind of market; a graduated coin's pool is the other,
    // and it is far larger — see POOL_PROGRAMS
    const pools = await poolOwners(holders.filter((h) => !h.tag).map((h) => h.owner));
    for (const h of holders) if (pools.has(h.owner)) h.tag = 'pool';

    // liquidity sitting in the curve or a pool is not concentration risk, so
    // exclude it from the "top holders" number that actually matters
    const realHolders = holders.filter((h) => h.tag !== 'bonding curve' && h.tag !== 'pool');
    const top10Pct = realHolders.slice(0, 10).reduce((sum, h) => sum + h.pctOfSupply, 0);

    const owned = holders.filter((h) => h.tag === 'you');
    const ownedAmount = owned.reduce((s, h) => s + h.amount, 0);

    return {
      totalSupply,
      decimals,
      holders,
      top10Pct,
      ownedPct: (ownedAmount / totalSupply) * 100,
      ownedAmount,
    };
  } catch (err) {
    // Almost always the public RPC rate limiting getTokenLargestAccounts. Flag
    // it so the card says "unknown" instead of implying a clean distribution.
    log.warn(`Holder lookup failed for ${mint}: ${errMessage(err)}`);
    return { holdersUnavailable: true };
  }
}

// ── pump.fun curve ────────────────────────────────────────────────────────────

async function loadCurveData(mint: string): Promise<Partial<TokenInfo>> {
  try {
    const curve = await fetchBondingCurve(mint);
    if (!curve) return { isPumpFun: false };

    const mcapSol = curveMarketCapSol(curve);
    const solPrice = await getSolPrice().catch(() => 0);

    const out: Partial<TokenInfo> = {
      isPumpFun: true,
      curveComplete: curve.complete,
      curveProgressPct: curveProgress(curve) * 100,
      curveMcapSol: mcapSol,
      creator: curve.creator,
      // a fresh launch has no DEX pair yet, so the curve is the only mcap there is
      marketCap: solPrice > 0 ? mcapSol * solPrice : undefined,
    };

    // How much of the coin the launcher kept is the most direct rug signal
    // pump.fun offers, and the curve account names them. A dev sitting on a
    // large share can end the chart in one transaction.
    if (curve.creator && curve.tokenTotalSupply > 0n) {
      try {
        const held = await getMintBalances([curve.creator], mint);
        const raw = held.get(curve.creator) ?? 0n;
        if (raw > 0n) {
          out.creatorHoldsPct = (Number(raw) / Number(curve.tokenTotalSupply)) * 100;
        } else {
          out.creatorHoldsPct = 0;
        }
      } catch {
        /* leave undefined — unknown, which the card states rather than implying zero */
      }
    }

    return out;
  } catch {
    return { isPumpFun: false };
  }
}

// ── assembly ──────────────────────────────────────────────────────────────────

export interface TokenInfoOptions {
  /**
   * Trade off completeness for speed, for the paths where a human is not
   * waiting and a fill is. Everything still runs; the slowest query is simply
   * not allowed to hold up a decision.
   */
  fast?: boolean;
}

export async function getTokenInfo(
  address: string,
  kind: 'solana' | 'evm',
  opts: TokenInfoOptions = {},
): Promise<TokenInfo> {
  const base: TokenInfo = {
    address,
    chain: kind === 'solana' ? 'solana' : 'ethereum',
    warnings: [],
  };

  if (kind === 'solana') {
    const [market, holders, curve, meta, authorities, rug, jup, locks] = await Promise.all([
      loadMarketData(address, 'solana'),
      loadSolanaHolders(address, opts.fast ? FAST_HOLDER_DEADLINE_MS : HOLDER_DEADLINE_MS),
      loadCurveData(address),
      getTokenMetadata(address).catch(() => null),
      getMintAuthorities(address),
      getRugcheck(address),
      getJupTokenData(address),
      /*
       * Alongside the rest rather than after the verdict.
       *
       * It would be cheaper to look up locks only once concentration was about
       * to refuse — that is the case they exist for. But the same read is what
       * catches an allocation bundled out through one-second streams, and that
       * one has to run on the coins that pass, which is all of them. Started
       * here it costs the difference between this call and the slowest of the
       * others, which on measurement is nothing.
       */
      readTokenLocks(address, { timeoutMs: opts.fast ? FAST_LOCK_DEADLINE_MS : LOCK_DEADLINE_MS }),
    ]);

    // DexScreener wins on market cap once a pool exists; before that the curve
    // is the only source, so only let it fill an empty field
    const merged: TokenInfo = { ...base, ...curve, ...holders, ...market, chain: 'solana' };
    if (market.marketCap === undefined && curve.marketCap !== undefined) merged.marketCap = curve.marketCap;

    if (authorities) {
      merged.mintAuthority = authorities.mintAuthority;
      merged.freezeAuthority = authorities.freezeAuthority;
      merged.decimals ??= authorities.decimals;
      merged.token2022 = authorities.token2022;
      merged.traps = authorities.traps;
    }

    // on-chain metadata is the fallback, never the override — an indexed name
    // and logo are more reliable than whatever IPFS returns
    if (meta) {
      merged.name ??= meta.name;
      merged.symbol ??= meta.symbol;
      merged.imageUrl ??= meta.imageUrl;
      merged.description ??= meta.description;
    }

    /*
     * The index's numbers where it has them, ours where it does not.
     *
     * It is preferred for concentration rather than merely consulted, because
     * it can name a pool and a cluster of one person's wallets and we cannot.
     * Our own read stays as the fallback for the moments it is unreachable —
     * and `holdersUnavailable` is cleared when it answers, since the figure is
     * then known even though our RPC query was throttled out of returning it.
     */
    if (rug) {
      merged.rugcheckScore = rug.score;
      merged.rugcheckRisks = rug.risks.map((r) => ({ name: r.name, level: r.level }));
      merged.insiderPct = rug.insiderPct;
      merged.insiderWallets = rug.insiderWallets;
      merged.holderCount = rug.totalHolders;
      merged.creatorPriorTokens = rug.creatorPriorTokens;
      merged.creatorRugHistory = rug.creatorRugHistory;
      merged.copycat = rug.copycat;
      merged.rugged = rug.rugged;
      merged.lpLockedPct = rug.lpLockedPct;

      /*
       * The index's concentration figure, without pretending our own read
       * worked. `holdersUnavailable` means one thing — the RPC refused us —
       * and clearing it here to signal "but we know anyway" made the card
       * claim a holder list it did not have. The gate only ever complains
       * when the figure is missing entirely, so supplying it is enough.
       */
      if (rug.top10Pct !== undefined) merged.top10Pct = rug.top10Pct;
      if (rug.lockerPct !== undefined) merged.lockerPct = rug.lockerPct;
      if (rug.creatorPct !== undefined) merged.creatorHoldsPct ??= rug.creatorPct;
      if (merged.liquidityUsd === undefined && rug.liquidityUsd !== undefined) {
        merged.liquidityUsd = rug.liquidityUsd;
      }
    }

    /*
     * Jupiter's numbers fill what is still empty and add what nobody else has.
     *
     * devMints and the five-minute trader count exist in no other source this
     * bot reads. The concentration and holder figures are third opinions — the
     * launch index outranks them because it can name a pool, so they only fill
     * gaps.
     */
    if (jup) {
      merged.devMints = jup.devMints;
      merged.traders5m = jup.traders5m;
      merged.netBuyers5m = jup.netBuyers5m;
      merged.organicPct5m = jup.organicPct5m;
      merged.organicScoreLabel = jup.organicScoreLabel;
      merged.holderCount ??= jup.holderCount;
      merged.top10Pct ??= jup.topHoldersPct;
      if (merged.creatorPriorTokens === undefined && jup.devMints !== undefined) {
        // devMints counts this token too; prior launches are one fewer
        merged.creatorPriorTokens = Math.max(0, jup.devMints - 1);
      }
    }

    if (locks) {
      merged.lockedSupply = locks.locked;
      merged.launchDistPct = locks.launchDistPct;
      merged.launchDistWallets = locks.launchDistWallets;
    }

    addWarnings(merged);
    return merged;
  }

  const market = await loadMarketData(address, 'evm');
  const merged: TokenInfo = { ...base, ...market, chain: market.chain ?? 'ethereum' };
  addWarnings(merged);
  return merged;
}

/** Heuristics worth seeing before committing several wallets to a position. */
function addWarnings(info: TokenInfo): void {
  // A freeze authority is the one that traps you in the position: the account
  // can be frozen mid-trade and no chart shows it coming.
  if (info.freezeAuthority) {
    info.warnings.push(
      'FREEZE AUTHORITY IS ACTIVE — the deployer can freeze your token account and stop you selling.',
    );
  }

  if (info.mintAuthority) {
    info.warnings.push(
      'Mint authority is active — more supply can be created and sold into the pool at any time.',
    );
  }

  for (const trap of info.traps ?? []) {
    info.warnings.push(`TOKEN-2022 TRAP — ${trap}.`);
  }

  if (info.chain === 'solana' && info.freezeAuthority === undefined) {
    info.warnings.push('Could not read the mint authorities — freeze and mint risk are unknown, not absent.');
  }

  if (info.holdersUnavailable) {
    info.warnings.push('Holder distribution unavailable — the RPC rejected the query (rate limit?). Concentration is unknown, not zero.');
  }

  /*
   * Concentration net of supply that is locked away for good.
   *
   * The raw figure counts a vesting vault as a holder, which on a live launch
   * read 63.5% concentrated when 50.2% of it was locked until 2095. Saying
   * that out loud on the card is the point — the number and the reason for it,
   * rather than a quietly softened number nobody can check.
   */
  const locked = Math.min(
    info.lockerPct ?? 0,
    info.lockedSupply === undefined
      ? 0
      : lockedBeyond(info.lockedSupply, DEFAULT_LOCK_HORIZON_DAYS * DAY_MS),
  );
  const free = info.top10Pct === undefined ? undefined : Math.max(0, info.top10Pct - locked);

  if (free !== undefined && free > 50) {
    info.warnings.push(`Top 10 wallets hold ${free.toFixed(1)}% of supply — heavy concentration.`);
  }
  if (locked > 0) {
    const furthest = furthestUnlock(info.lockedSupply ?? []);
    const until = furthest ? new Date(furthest).getUTCFullYear() : undefined;
    info.warnings.push(
      `${locked.toFixed(1)}% of supply is locked${until ? ` until ${until}` : ''} — not counted as concentration.`,
    );
  }

  /*
   * A "vesting stream" that started and finished in the same second is an
   * allocation, not a schedule. Worth its own line because the launch index
   * scores these wallets as unrelated: it reads the funding graph, and a
   * transfer routed through a vesting program does not look like funding.
   */
  if (info.launchDistPct !== undefined && info.launchDistPct > 1) {
    info.warnings.push(
      `${info.launchDistPct.toFixed(1)}% of supply went to ${info.launchDistWallets ?? 0} wallets at launch ` +
        'through vesting streams that locked nothing — they can sell now.',
    );
  }

  if (info.liquidityUsd !== undefined && info.liquidityUsd < 5_000 && !info.isPumpFun) {
    info.warnings.push(`Only ${Math.round(info.liquidityUsd).toLocaleString()} USD of liquidity — expect severe slippage.`);
  }

  if (info.pairCreatedAt) {
    const ageHours = (Date.now() - info.pairCreatedAt) / 3_600_000;
    if (ageHours < 1) info.warnings.push(`Pair is ${Math.round(ageHours * 60)} minutes old.`);
  }

  if (info.volume24h !== undefined && info.liquidityUsd && info.volume24h > info.liquidityUsd * 50) {
    info.warnings.push('Volume is very large relative to liquidity — possible wash trading.');
  }

  if (info.creatorHoldsPct !== undefined && info.creatorHoldsPct >= 5) {
    info.warnings.push(
      `The launch wallet still holds ${info.creatorHoldsPct.toFixed(1)}% of supply — it can sell into you at any time.`,
    );
  }

  if (info.isPumpFun && info.curveComplete) {
    info.warnings.push('Bonding curve has completed — trades route through the AMM.');
  }

  if (!info.priceUsd && !info.isPumpFun) {
    info.warnings.push('No indexed market found. Double-check the address before trading.');
  }
}
