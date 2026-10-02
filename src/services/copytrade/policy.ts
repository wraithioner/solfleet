import { db, type CopyTarget, type CopyExitMode } from '../../store/db.js';
import type { TokenMove } from './events.js';

/**
 * SOL to commit to one copied buy, across the whole batch.
 *
 * Percent mode is deliberately a share of the batch rather than a share per
 * wallet: "copy him at 5%" should mean a position 5% the size of his, not 5%
 * multiplied by however many wallets happen to be running.
 */
export function copyBuySol(
  target: Pick<CopyTarget, 'sizeMode' | 'buySol' | 'sizePercent'>,
  theirSol: number,
  walletCount: number,
  maxPerWallet: number,
): number {
  if (walletCount <= 0) return 0;

  const perWallet =
    target.sizeMode === 'percent'
      ? (theirSol * (target.sizePercent / 100)) / walletCount
      : target.buySol;

  if (!Number.isFinite(perWallet) || perWallet <= 0) return 0;

  // the per-wallet safety cap still applies however the number was arrived at
  return Math.min(perWallet, maxPerWallet);
}

/**
 * What share of our position to sell when they sell some of theirs.
 *
 * `proportional` copies the trim as a trim. `all` reads any sell as the exit
 * signal and closes the whole position — a trader who takes 10% off the top is
 * often on the way out, and being seconds behind them makes a partial follow
 * the worst of both. Returns 0 when nothing should be sold.
 */
export function copySellPercent(mode: CopyExitMode, move: TokenMove): number {
  if (mode === 'off') return 0;
  if (mode === 'all') return 100;

  // they may have sold from a balance we never saw grow; treat that as a full exit
  if (move.before <= 0) return 100;

  const share = (Math.abs(move.delta) / move.before) * 100;
  // never round a real sell down to nothing, and never past a full exit
  return Math.min(100, Math.max(1, Math.round(share)));
}
/**
 * SOL already committed to a mint, from every source.
 *
 * Measured cost where it exists, which includes the fees and rent a copy pays.
 * Hand-bought size counts too: the cap is a statement about how much of one
 * coin the operator is willing to hold, and money spent by tapping a button is
 * no less spent than money spent automatically.
 */
export function lifetimeCostSol(mint: string): number {
  const pos = db.position(mint);
  if (!pos) return 0;
  return pos.costSol ?? pos.investedSol;
}

/**
 * Money still riding on a coin, as opposed to money once spent on it.
 *
 * The distinction decides whether a coin can ever be traded again, and getting
 * it wrong locks the bot out permanently: what a position cost is cumulative
 * and never comes back down, so a coin bought and sold last week still reads as
 * a live position forever. Every token an operator has already been through
 * would be refused for the life of the install.
 *
 * Holdings decide it, not the ledger. `cost - realised` cannot: a position
 * closed at a loss leaves a positive remainder and would look open, and one
 * closed at a profit leaves a negative one. Whether the wallets are holding any
 * of the token is the only fact that answers the question, and the buy path
 * reads it anyway.
 */
export function openExposureSol(mint: string, holding: boolean): number {
  if (!holding) return 0;
  const pos = db.position(mint);
  if (!pos) return 0;
  return Math.max(0, (pos.costSol ?? pos.investedSol) - pos.realisedSol);
}

/** Room left under the per-mint cap. Infinity when the cap is off. */
export function roomUnderCap(mint: string, maxSolPerMint: number, holding: boolean): number {
  if (maxSolPerMint <= 0) return Infinity;
  return Math.max(0, maxSolPerMint - openExposureSol(mint, holding));
}
export function entriesSoFar(target: CopyTarget, mint: string): number {
  const counted = target.entryCounts?.[mint];
  if (counted !== undefined) return counted;
  // records written before entryCounts existed only ever made one entry
  return target.copiedMints.includes(mint) ? 1 : 0;
}
