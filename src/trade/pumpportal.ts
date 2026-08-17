import { VersionedTransaction, Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { endpoints } from '../config.js';
import { fetchBytes, fetchJson } from '../util.js';
import type { TradeRequest } from '../types.js';

/**
 * pump.fun execution via PumpPortal's *local* trading API.
 *
 * The important property: PumpPortal only builds an unsigned transaction and
 * hands it back. Signing happens here, with keys that never leave this process,
 * so no third party can move funds. It also means the pump.fun program layout —
 * which changes without notice — stays their problem rather than ours.
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
    throw new Error(`PumpPortal returned an unexpectedly small response: ${new TextDecoder().decode(bytes)}`);
  }

  return VersionedTransaction.deserialize(bytes);
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

  return encoded.map((b58) => VersionedTransaction.deserialize(bs58.decode(b58)));
}

export function signTx(tx: VersionedTransaction, signer: Keypair): VersionedTransaction {
  // Re-wrapping the message drops any placeholder signatures PumpPortal left in
  // place, so the only signature on the wire is the one we just produced.
  const signed = new VersionedTransaction(tx.message);
  signed.sign([signer]);
  return signed;
}
