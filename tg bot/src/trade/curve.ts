import { PublicKey } from '@solana/web3.js';
import { rpc, LAMPORTS } from '../chains/solana.js';

/**
 * Direct reads of the pump.fun bonding curve.
 *
 * Execution goes through PumpPortal, but quoting does not: reading the curve
 * ourselves means the price shown before a batch buy is the real on-chain price
 * at that moment, and it tells us whether a token has graduated to a real AMM
 * (at which point trades must route to pump-amm/Raydium instead of the curve).
 */

export const PUMP_PROGRAM_ID = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');

/** pump.fun charges 1% on both sides of a bonding-curve trade. */
const FEE_BPS = 100n;
const BPS = 10_000n;

const TOKEN_DECIMALS = 6;

export interface BondingCurve {
  virtualTokenReserves: bigint;
  virtualSolReserves: bigint;
  realTokenReserves: bigint;
  realSolReserves: bigint;
  tokenTotalSupply: bigint;
  /** True once the curve has filled and liquidity migrated to an AMM. */
  complete: boolean;
  creator?: string;
}

export function bondingCurvePda(mint: string): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('bonding-curve'), new PublicKey(mint).toBuffer()],
    PUMP_PROGRAM_ID,
  );
  return pda;
}

/** Returns null when the mint was never a pump.fun token. */
export async function fetchBondingCurve(mint: string): Promise<BondingCurve | null> {
  const info = await rpc().getAccountInfo(bondingCurvePda(mint));
  if (!info || info.data.length < 49) return null;

  const buf = Buffer.from(info.data);
  const curve: BondingCurve = {
    // byte 0-7 is the Anchor discriminator
    virtualTokenReserves: buf.readBigUInt64LE(8),
    virtualSolReserves: buf.readBigUInt64LE(16),
    realTokenReserves: buf.readBigUInt64LE(24),
    realSolReserves: buf.readBigUInt64LE(32),
    tokenTotalSupply: buf.readBigUInt64LE(40),
    complete: buf.readUInt8(48) === 1,
  };

  // `creator` was appended when creator fees shipped; older accounts stop at 49
  if (buf.length >= 81) {
    curve.creator = new PublicKey(buf.subarray(49, 81)).toBase58();
  }

  return curve;
}

/** SOL per token. */
export function curvePrice(curve: BondingCurve): number {
  if (curve.virtualTokenReserves === 0n) return 0;
  const sol = Number(curve.virtualSolReserves) / LAMPORTS;
  const tokens = Number(curve.virtualTokenReserves) / 10 ** TOKEN_DECIMALS;
  return sol / tokens;
}

export function curveMarketCapSol(curve: BondingCurve): number {
  const supply = Number(curve.tokenTotalSupply) / 10 ** TOKEN_DECIMALS;
  return curvePrice(curve) * supply;
}

/** How far along the curve is, 0-1. Useful as a "about to graduate" signal. */
export function curveProgress(curve: BondingCurve): number {
  if (curve.complete) return 1;
  const total = Number(curve.tokenTotalSupply);
  const remaining = Number(curve.realTokenReserves);
  if (total === 0) return 0;
  // ~20% of supply is held back for the AMM migration, so the tradable portion
  // is what actually determines progress
  const tradable = total * 0.8;
  return Math.min(1, Math.max(0, (tradable - remaining) / tradable));
}

/**
 * Constant-product quote for a buy. `solIn` is in whole SOL, result is in whole
 * tokens, fee already deducted.
 */
export function quoteBuy(curve: BondingCurve, solIn: number): number {
  const lamportsIn = BigInt(Math.floor(solIn * LAMPORTS));
  if (lamportsIn <= 0n) return 0;

  const afterFee = lamportsIn - (lamportsIn * FEE_BPS) / BPS;
  const tokensOut =
    (afterFee * curve.virtualTokenReserves) / (curve.virtualSolReserves + afterFee);

  return Number(tokensOut) / 10 ** TOKEN_DECIMALS;
}

/** Constant-product quote for a sell. `tokensIn` is in whole tokens. */
export function quoteSell(curve: BondingCurve, tokensIn: number): number {
  const rawIn = BigInt(Math.floor(tokensIn * 10 ** TOKEN_DECIMALS));
  if (rawIn <= 0n) return 0;

  const solOut = (rawIn * curve.virtualSolReserves) / (curve.virtualTokenReserves + rawIn);
  const afterFee = solOut - (solOut * FEE_BPS) / BPS;

  return Number(afterFee) / LAMPORTS;
}

/**
 * Price impact of a buy, as a fraction. A batch of wallets buying in sequence
 * walks the curve, so this is what tells you the last wallet's fill.
 */
export function buyPriceImpact(curve: BondingCurve, solIn: number): number {
  const spot = curvePrice(curve);
  if (spot === 0) return 0;
  const tokensOut = quoteBuy(curve, solIn);
  if (tokensOut === 0) return 0;
  const effective = solIn / tokensOut;
  return (effective - spot) / spot;
}

/**
 * Simulate N wallets buying `solEach` one after another, so the UI can show the
 * true aggregate cost rather than N times the first wallet's quote.
 */
export function simulateSequentialBuys(
  curve: BondingCurve,
  solEach: number,
  wallets: number,
): { totalTokens: number; totalSol: number; finalPrice: number; avgPrice: number } {
  let vSol = curve.virtualSolReserves;
  let vTok = curve.virtualTokenReserves;
  let totalTokens = 0;

  const lamportsIn = BigInt(Math.floor(solEach * LAMPORTS));
  const afterFee = lamportsIn - (lamportsIn * FEE_BPS) / BPS;

  for (let i = 0; i < wallets; i++) {
    const out = (afterFee * vTok) / (vSol + afterFee);
    totalTokens += Number(out) / 10 ** TOKEN_DECIMALS;
    vSol += afterFee;
    vTok -= out;
  }

  const totalSol = solEach * wallets;
  const finalPrice = Number(vSol) / LAMPORTS / (Number(vTok) / 10 ** TOKEN_DECIMALS);

  return {
    totalTokens,
    totalSol,
    finalPrice,
    avgPrice: totalTokens > 0 ? totalSol / totalTokens : 0,
  };
}

/**
 * Pick the right venue automatically: the curve while it is live, pump-amm once
 * it has graduated. Sending a curve trade to a graduated token just fails.
 */
export async function detectPool(mint: string): Promise<'pump' | 'pump-amm' | 'auto'> {
  try {
    const curve = await fetchBondingCurve(mint);
    if (!curve) return 'auto';
    return curve.complete ? 'pump-amm' : 'pump';
  } catch {
    return 'auto';
  }
}
