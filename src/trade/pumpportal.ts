import { VersionedTransaction, type Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { endpoints } from '../config.js';
import { fetchBytes, fetchJson } from '../util.js';
import type { TradeRequest } from '../types.js';
import {
  assertExternalTrade,
  priorityFeeLamports,
  pumpSwapVariants,
  signExternalTransaction,
} from './validation.js';
import { WSOL_MINT } from '../chains/solana.js';

/**
 * pump.fun execution via PumpPortal's *local* trading API.
 *
 * PumpPortal builds a message and local signing authorizes that whole message.
 * Keeping keys local does not make an external builder trustworthy. The bounded
 * checks below reject unexpected signers, fees and missing swaps; full validation
 * of spend amounts, token accounts and recipients still needs venue decoders.
 */

export interface TradeArgs {
  publicKey: string;
  action: 'buy' | 'sell';
  mint: string;
  /** SOL amount for buys; token amount or "100%" for sells. */
  amount: number | string;
  denominatedInSol: 'true' | 'false';
  slippage: number;
  priorityFee: number;
  pool: TradeRequest['pool'];
}

function wrappedSolBudget(args: TradeArgs): bigint {
  if (args.action !== 'buy' || args.denominatedInSol !== 'true' || typeof args.amount !== 'number')
    return 0n;
  if (!Number.isFinite(args.slippage) || args.slippage < 0 || args.slippage >= 100)
    throw new Error('Invalid PumpPortal slippage.');
  // Exact-token buys may wrap the maximum permitted SOL input. Keep this bound
  // on top-level wrapping separate from the unresolved swap's actual CPI debit.
  const basisPoints = BigInt(Math.ceil(args.slippage * 100));
  const input = priorityFeeLamports(args.amount);
  return (input * (10_000n + basisPoints) + 9_999n) / 10_000n;
}

export function toTradeArgs(req: TradeRequest, publicKey: string): TradeArgs {
  return {
    publicKey,
    action: req.action,
    mint: req.mint,
    // a sell expressed as a percentage is passed through verbatim — PumpPortal
    // resolves "100%" against the wallet's actual holding at build time, which
    // avoids a stale-balance race between our read and the transaction landing
    amount: req.denominatedInSol ? req.amount : `${req.amount}%`,
    denominatedInSol: req.denominatedInSol ? 'true' : 'false',
    slippage: req.slippagePercent,
    priorityFee: req.priorityFeeSol,
    pool: req.pool,
  };
}

/** Build one unsigned transaction. */
export async function buildTrade(args: TradeArgs): Promise<VersionedTransaction> {
  const bytes = await fetchBytes(endpoints.pumpPortalTradeLocal, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
    timeoutMs: 25_000,
  });

  if (bytes.length < 64) {
    throw new Error(
      `PumpPortal returned an unexpectedly small response: ${new TextDecoder().decode(bytes)}`,
    );
  }

  const tx = VersionedTransaction.deserialize(bytes);
  assertExternalTrade(tx, {
    wallet: args.publicKey,
    priorityFeeSol: args.priorityFee,
    swaps: pumpSwapVariants(args.pool, args.action),
    mints: [WSOL_MINT, args.mint],
    wrappedSolLamports: wrappedSolBudget(args),
  });
  return tx;
}

/**
 * Build up to 5 transactions in one request. This is the form Jito bundles need
 * — the transactions share a blockhash and are ordered, so they land together
 * or not at all.
 */
export async function buildTradeBundle(argsList: TradeArgs[]): Promise<VersionedTransaction[]> {
  if (argsList.length === 0) return [];
  if (argsList.length > 5) throw new Error('A Jito bundle holds at most 5 transactions.');

  const encoded = await fetchJson<string[]>(endpoints.pumpPortalTradeLocal, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(argsList),
    timeoutMs: 30_000,
  });

  if (!Array.isArray(encoded)) {
    throw new Error('PumpPortal did not return a transaction array. Check the trade parameters.');
  }
  if (encoded.length !== argsList.length) {
    throw new Error(
      `PumpPortal returned ${encoded.length} transactions for ${argsList.length} wallets.`,
    );
  }
  return encoded.map((b58, index) => {
    if (typeof b58 !== 'string')
      throw new Error('PumpPortal returned an invalid encoded transaction.');
    const tx = VersionedTransaction.deserialize(bs58.decode(b58));
    const args = argsList[index]!;
    // Bundle priorityFee on the first request is used as its Jito tip. A
    // zero compute price is valid; the tip remains part of the signed message.
    assertExternalTrade(tx, {
      wallet: args.publicKey,
      priorityFeeSol: args.priorityFee,
      swaps: pumpSwapVariants(args.pool, args.action),
      mints: [WSOL_MINT, args.mint],
      wrappedSolLamports: wrappedSolBudget(args),
      jitoTipLamports: index === 0 ? priorityFeeLamports(args.priorityFee) : 0n,
    });
    return tx;
  });
}

export function signTx(tx: VersionedTransaction, signer: Keypair): VersionedTransaction {
  return signExternalTransaction(tx, signer);
}
