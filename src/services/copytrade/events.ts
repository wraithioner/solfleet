import { WSOL_MINT, LAMPORTS } from '../../chains/solana.js';

export interface TokenMove {
  mint: string;
  /** Change in whole tokens: positive is a buy, negative a sell. */
  delta: number;
  /** What they held before, used to size a proportional exit. */
  before: number;
}

interface ParsedAccount {
  pubkey: { toBase58(): string } | string;
}

interface ParsedBalance {
  mint: string;
  owner?: string;
  uiTokenAmount: { amount?: string; decimals?: number; uiAmount: number | null };
}

function balanceAmount(balance: ParsedBalance): number | undefined {
  const { amount, decimals, uiAmount } = balance.uiTokenAmount;
  // Scaled UI display amounts can change without a token transfer. Raw units
  // and the mint's decimals are the same units used by the position ledger.
  if (amount !== undefined || decimals !== undefined) {
    if (
      typeof amount !== 'string' ||
      !/^\d+$/.test(amount) ||
      typeof decimals !== 'number' ||
      !Number.isInteger(decimals) ||
      decimals < 0 ||
      decimals > 255
    )
      return undefined;
    const value = Number(amount) / 10 ** decimals;
    return Number.isFinite(value) && value >= 0 ? value : undefined;
  }
  return typeof uiAmount === 'number' && Number.isFinite(uiAmount) && uiAmount >= 0
    ? uiAmount
    : undefined;
}

/**
 * What one wallet's token holdings did in a single transaction.
 *
 * Kept pure and separate from the RPC so the interpretation — which is what
 * decides whether real money is spent — can be tested without a network.
 */
export function detectTokenMoves(
  pre: ParsedBalance[],
  post: ParsedBalance[],
  owner: string,
): TokenMove[] {
  const before = new Map<string, number>();
  const after = new Map<string, number>();
  const unreadable = new Set<string>();

  for (const b of pre) {
    if (b.owner !== owner) continue;
    const amount = balanceAmount(b);
    if (amount === undefined) unreadable.add(b.mint);
    else before.set(b.mint, (before.get(b.mint) ?? 0) + amount);
  }
  for (const b of post) {
    if (b.owner !== owner) continue;
    const amount = balanceAmount(b);
    if (amount === undefined) unreadable.add(b.mint);
    else after.set(b.mint, (after.get(b.mint) ?? 0) + amount);
  }

  const moves: TokenMove[] = [];
  for (const mint of new Set([...before.keys(), ...after.keys()])) {
    // wrapped SOL moves on nearly every swap and means nothing on its own
    if (mint === WSOL_MINT || unreadable.has(mint)) continue;

    const start = before.get(mint) ?? 0;
    const end = after.get(mint) ?? 0;
    const delta = end - start;

    // ignore dust: rounding and rent-exempt remnants are not trades
    if (Math.abs(delta) < 1e-9) continue;
    moves.push({ mint, delta, before: start });
  }

  return moves;
}

/**
 * How much SOL an address parted with in one transaction.
 *
 * This is what makes proportional sizing possible: the token balance change
 * says *what* they bought, and only the native balance change says how much
 * conviction was behind it. Positive is spent, negative is received.
 *
 * The number includes the transaction fee and any rent for accounts opened
 * along the way when the address is the fee payer. On a memecoin buy those are
 * a rounding error next to the trade, and erring slightly high is the safe
 * direction for a cap to be wrong in.
 */
export function solSpent(
  accountKeys: ParsedAccount[],
  preBalances: number[],
  postBalances: number[],
  owner: string,
): number {
  const index = accountKeys.findIndex(a => {
    const key = typeof a.pubkey === 'string' ? a.pubkey : a.pubkey.toBase58();
    return key === owner;
  });
  if (index < 0) return 0;

  const before = preBalances[index];
  const after = postBalances[index];
  if (before === undefined || after === undefined) return 0;

  return (before - after) / LAMPORTS;
}

/**
 * The least SOL a wallet must part with for an arriving token to count as a buy.
 *
 * A token balance going up does not mean they bought anything. Anyone can send
 * tokens to anyone, and dusting a wallet that other people copy is a way of
 * getting those people to buy something worthless — the recipient pays nothing,
 * is not even the fee payer, and their balance rises exactly as it would after
 * a purchase. Their SOL is the only thing that tells the two apart.
 *
 * Where the floor sits, and why not lower. Receiving a token is not free for
 * the recipient when they pay their own fees: opening the token account it
 * lands in costs 0.00204 SOL of rent, a wrapped-SOL account alongside it
 * another 0.00204, and a fat priority fee can add a further 0.002. So a pure
 * receipt can cost its holder the better part of half a hundredth of a SOL
 * while buying nothing — measured on chain, wallets gaining nine million
 * tokens for 0.004 SOL. A floor under that reads those as purchases.
 *
 * 0.01 SOL clears it with room, and is also the smallest quick-buy this bot
 * offers: if they spent less than the least you would ever choose to spend, it
 * is not a signal worth paying for.
 *
 * It also excludes a token-for-token swap, where they genuinely acquired
 * something without SOL leaving. Pricing the input side would be the fix;
 * declining to copy a trade is cheaper than copying a poisoned one.
 */
export const MIN_SPEND_FOR_BUY_SOL = 0.01;

/**
 * Did they pay for this, or did it simply arrive?
 *
 * Pure and exported because it decides whether money moves, and the cost of
 * getting it wrong is a real buy of a token somebody chose for you.
 */
export function isPurchase(theirSol: number): boolean {
  return Number.isFinite(theirSol) && theirSol >= MIN_SPEND_FOR_BUY_SOL;
}
