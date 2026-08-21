import type { PositionRecord, ValueMark } from '../store/db.js';
import { fmtAmount } from '../util.js';

/**
 * Profit and loss, denominated in SOL.
 *
 * SOL is the unit deliberately: buys are sized in SOL, so "I put in 5 and I'm
 * up 2" is how the position is actually experienced. Pricing the same trade in
 * dollars mixes in SOL's own move against the dollar, which is not the bet the
 * operator made.
 *
 * The three inputs are of different quality and it is worth being honest about
 * which is which:
 *
 *  - `investedSol` is exact. It is what the batch was instructed to spend, and
 *    the transaction either landed or was not counted.
 *  - `realisedSol` is measured from the wallets' SOL balances before and after a
 *    sell, so it is net of transaction fees — slightly conservative, and the
 *    number that actually arrived.
 *  - `currentValueSol` is a mark to market at whatever the token last traded
 *    for. On an illiquid memecoin it is the least reliable of the three, since
 *    selling the position is what moves that price.
 */
export interface PositionPnl {
  investedSol: number;
  realisedSol: number;
  currentValueSol: number;
  /** Realised plus what is still held, less what went in. */
  netSol: number;
  /** Net as a percentage of the amount invested. */
  netPct: number;
  /** True once sells alone have returned more than the position cost. */
  inProfitOnRealised: boolean;
}

/**
 * What one token cost, in SOL, averaged over every buy.
 *
 * Derived rather than stored: the SOL spent and the tokens received are both
 * measured facts, and their ratio is the only entry price that survives buying
 * the same token five times at five different prices.
 *
 * Null when the token count was never recorded — an entry price guessed from a
 * missing measurement would be worse than none, since a stop-loss fires against
 * it.
 */
export function entryPrice(pos: PositionRecord | undefined): number | null {
  if (!pos) return null;
  // the position on the books, not every one this coin has ever been — see the
  // note on basisSol in the store
  const sol = pos.basisSol ?? pos.investedSol;
  const tokens = pos.basisTokens ?? pos.tokensBought;
  if (sol <= 0 || tokens <= 0) return null;
  return sol / tokens;
}

/** Entry, current, and the move between them, ready to render. */
export function formatEntry(pos: PositionRecord | undefined, nowSol: number | null): string | null {
  const entry = entryPrice(pos);
  if (entry === null) return null;

  const line = `entry <b>${fmtAmount(entry, 9)}</b> SOL`;
  if (nowSol === null || nowSol <= 0) return line;

  const movePct = ((nowSol - entry) / entry) * 100;
  const sign = movePct >= 0 ? '+' : '';
  return `${line} · now <b>${fmtAmount(nowSol, 9)}</b> SOL · ${sign}${movePct.toFixed(1)}%`;
}

export function positionPnl(pos: PositionRecord, currentValueSol: number): PositionPnl {
  const investedSol = pos.investedSol;
  const realisedSol = pos.realisedSol;
  const netSol = realisedSol + currentValueSol - investedSol;

  return {
    investedSol,
    realisedSol,
    currentValueSol,
    netSol,
    netPct: investedSol > 0 ? (netSol / investedSol) * 100 : 0,
    inProfitOnRealised: realisedSol >= investedSol && investedSol > 0,
  };
}

/** One line of P&L, sized for a Telegram card. */
export function formatPnl(p: PositionPnl): string {
  const sign = p.netSol >= 0 ? '+' : '';
  const arrow = p.netSol >= 0 ? '🟢' : '🔴';
  return `${arrow} ${sign}${p.netSol.toFixed(4)} SOL (${sign}${p.netPct.toFixed(1)}%)`;
}

/**
 * What one exit made or lost, priced against the position it came out of.
 *
 * The number the exit notifications never carried: a copied sell reported
 * "Mirrored — ✅ 2" and a take-profit reported the price move, and neither said
 * what the trade returned in money. The cost of the part sold is the tokens
 * sold at the open position's basis — selling half a position prices that half
 * at what it cost, not at what the whole position did.
 *
 * Null rather than a guess when the basis was never measured. A profit figure
 * invented from a missing entry would be read as real.
 */
export function exitResult(
  pos: PositionRecord | undefined,
  tokensSold: number,
  solReceived: number,
): { profitSol: number; pct: number } | null {
  if (!pos || tokensSold <= 0 || solReceived <= 0) return null;

  const sol = pos.basisSol ?? pos.investedSol;
  const tokens = pos.basisTokens ?? pos.tokensBought;
  if (sol <= 0 || tokens <= 0) return null;

  const costOfSold = (sol / tokens) * tokensSold;
  if (costOfSold <= 0) return null;

  return {
    profitSol: solReceived - costOfSold,
    pct: ((solReceived - costOfSold) / costOfSold) * 100,
  };
}

/** One line, coloured by sign, for the message a fill sends. */
export function formatExit(r: { profitSol: number; pct: number }): string {
  const sign = r.profitSol >= 0 ? '+' : '−';
  const word = r.profitSol >= 0 ? '💰 Profit' : '📉 Loss';
  return `${word} <b>${sign}${Math.abs(r.profitSol).toFixed(4)} ◎</b> (${sign}${Math.abs(r.pct).toFixed(1)}%)`;
}

// ── account-wide ──────────────────────────────────────────────────────────────

/**
 * Everything the bot has traded, added up.
 *
 * The question this answers — "am I actually up?" — is not the same as the one
 * the portfolio screen answers, which is "what is this worth right now". A
 * balance is not a result: $14.90 is a profit or a disaster depending entirely
 * on what went in, and that is precisely the thing nobody remembers.
 *
 * Cost is measured, not assumed: fees, tips and account rent are real money and
 * they come out of the same wallets. Positions opened before the measurement
 * existed fall back to their notional, which understates their cost — flattering
 * rather than wrong, and it corrects itself as they are traded.
 */
export interface AccountPnl {
  /** SOL the wallets actually parted with, fees and rent included. */
  costSol: number;
  /** SOL that came back from sells, net of fees. */
  realisedSol: number;
  /** What is still held, marked at the last traded price. */
  openValueSol: number;
  /** Fees and rent, separated out — the part a naive P&L never sees. */
  feesSol: number;
  netSol: number;
  netPct: number;
  netUsd: number;
  /** Banked minus spent: true even if every open position went to zero. */
  realisedNetSol: number;
  openCount: number;
  closedCount: number;
  wins: number;
  losses: number;
  best?: PositionResult;
  worst?: PositionResult;
  /** Positions still held that nothing would price, and what they cost. */
  unpricedCount: number;
  unpricedCostSol: number;
  /** True when nothing has ever been bought, so the screen can say so. */
  empty: boolean;
}

export interface PositionResult {
  mint: string;
  symbol: string;
  netSol: number;
  netPct: number;
  open: boolean;
}

/** What the true cost of a position was, falling back where it went unmeasured. */
export function costOf(pos: PositionRecord): number {
  return pos.costSol ?? pos.investedSol;
}

/**
 * @param positions every position ever recorded, open or closed
 * @param openValueSolByMint current mark for the ones still held, in SOL
 */
export function accountPnl(
  positions: PositionRecord[],
  openValueSolByMint: Map<string, number>,
  solPriceUsd: number,
  /**
   * Mints the wallets hold that no venue would price.
   *
   * Counted apart from the rest, because marking them at zero is the same
   * arithmetic as declaring them worthless. They may well be — but a quiet
   * hour and a dead token look identical from here, and the total should not
   * quietly pick one.
   */
  unpricedMints: Set<string> = new Set(),
): AccountPnl {
  let costSol = 0;
  let realisedSol = 0;
  let openValueSol = 0;
  let notionalSol = 0;
  let openCount = 0;
  let closedCount = 0;
  let wins = 0;
  let losses = 0;
  let unpricedCount = 0;
  let unpricedCostSol = 0;

  const results: PositionResult[] = [];

  for (const pos of positions) {
    const cost = costOf(pos);
    const value = openValueSolByMint.get(pos.mint) ?? 0;

    costSol += cost;
    notionalSol += pos.investedSol;
    realisedSol += pos.realisedSol;
    openValueSol += value;

    // a token still sitting in the wallets is an open bet; one that is gone has
    // a final answer, and mixing the two hides how much of a "profit" is
    // unrealised paper on something that cannot be sold. A held-but-unpriced
    // token is open too — it is on the books, whatever it is worth
    const unpriced = unpricedMints.has(pos.mint);
    if (unpriced) {
      unpricedCount++;
      unpricedCostSol += cost;
    }
    const open = value > 0 || unpriced;
    if (cost > 0 || pos.realisedSol > 0) (open ? openCount++ : closedCount++);

    const netSol = pos.realisedSol + value - cost;
    if (cost > 0 && !unpriced) {
      if (netSol >= 0) wins++;
      else losses++;
      results.push({
        mint: pos.mint,
        symbol: pos.symbol ?? pos.mint.slice(0, 4),
        netSol,
        netPct: (netSol / cost) * 100,
        open,
      });
    }
  }

  const netSol = realisedSol + openValueSol - costSol;
  const ranked = [...results].sort((a, b) => b.netSol - a.netSol);

  return {
    costSol,
    realisedSol,
    openValueSol,
    // what the notional never charged you for: fees, tips, and account rent
    feesSol: Math.max(0, costSol - notionalSol),
    netSol,
    netPct: costSol > 0 ? (netSol / costSol) * 100 : 0,
    netUsd: netSol * solPriceUsd,
    realisedNetSol: realisedSol - costSol,
    openCount,
    closedCount,
    wins,
    losses,
    best: ranked[0],
    worst: ranked.length > 1 ? ranked.at(-1) : undefined,
    unpricedCount,
    unpricedCostSol,
    empty: costSol === 0 && realisedSol === 0,
  };
}

/**
 * The headline, in one line.
 *
 * SOL first because that is the unit the position was sized in, dollars second
 * because that is the unit the operator thinks in.
 */
export function formatAccountPnl(a: AccountPnl): string {
  const sign = a.netSol >= 0 ? '+' : '−';
  const light = a.netSol >= 0 ? '🟢' : '🔴';
  const abs = Math.abs(a.netSol);
  const usd = Math.abs(a.netUsd);
  return (
    `${light} <b>${sign}${abs.toFixed(4)} ◎</b>  (${sign}${Math.abs(a.netPct).toFixed(1)}%)` +
    (a.netUsd !== 0 ? `  ·  ${sign}$${usd.toFixed(2)}` : '')
  );
}

// ── account value over time ───────────────────────────────────────────────────

/**
 * The mark nearest to a point in the past, or null if none is near enough.
 *
 * "Near enough" matters more than it looks. The marks are written by a loop
 * that only runs while the bot is up, so a redeploy, a locked vault or a dead
 * RPC leaves gaps — and labelling a reading from four days ago as "24h" is not
 * an approximation, it is a wrong number with a confident caption. A quarter of
 * the interval, and at least two hours, keeps the label true.
 */
export function markAgo(marks: ValueMark[], agoMs: number, now = Date.now()): ValueMark | null {
  if (marks.length === 0) return null;

  const target = now - agoMs;
  const tolerance = Math.max(2 * 3_600_000, agoMs * 0.25);

  let best: ValueMark | null = null;
  let bestGap = Infinity;
  for (const m of marks) {
    const gap = Math.abs(m.at - target);
    if (gap < bestGap) {
      best = m;
      bestGap = gap;
    }
  }

  return best !== null && bestGap <= tolerance ? best : null;
}

/**
 * How the account has moved since then, in dollars.
 *
 * Deliberately called value rather than profit. This series records what the
 * wallets are worth, and depositing SOL raises that without anyone having made
 * a good trade — the trading P&L is the number that cannot be moved by a
 * transfer, and the two are shown apart for that reason.
 */
export function formatValueChange(from: ValueMark, currentUsd: number): string {
  const delta = currentUsd - from.usd;
  const pct = from.usd > 0 ? (delta / from.usd) * 100 : 0;
  const sign = delta >= 0 ? '+' : '−';
  const light = delta >= 0 ? '🟢' : '🔴';
  return `${light} $${from.usd.toFixed(2)} → $${currentUsd.toFixed(2)}   ${sign}$${Math.abs(delta).toFixed(2)} (${sign}${Math.abs(pct).toFixed(1)}%)`;
}
