import type { PositionRecord } from '../store/db.js';

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
