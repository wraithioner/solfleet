import { VersionedTransaction, Keypair } from '@solana/web3.js';
import { endpoints } from '../config.js';
import { fetchJson } from '../util.js';
import { LAMPORTS, WSOL_MINT } from '../chains/solana.js';

/**
 * Jupiter aggregator. Used for anything that is not a live pump.fun curve —
 * graduated tokens, plain SPL positions, and dumping arbitrary dust back to SOL.
 */

export interface JupQuote {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  priceImpactPct: string;
  routePlan: unknown[];
  slippageBps: number;
}

export async function getQuote(params: {
  inputMint: string;
  outputMint: string;
  /** Raw amount in the input mint's smallest unit. */
  amount: bigint;
  slippageBps: number;
  onlyDirectRoutes?: boolean;
}): Promise<JupQuote> {
  const qs = new URLSearchParams({
    inputMint: params.inputMint,
    outputMint: params.outputMint,
    amount: params.amount.toString(),
    slippageBps: String(params.slippageBps),
    restrictIntermediateTokens: 'true',
  });
  if (params.onlyDirectRoutes) qs.set('onlyDirectRoutes', 'true');

  return fetchJson<JupQuote>(`${endpoints.jupiterQuote}?${qs}`, { timeoutMs: 20_000 });
}

export async function buildSwap(
  quote: JupQuote,
  userPublicKey: string,
  priorityFeeSol: number,
): Promise<VersionedTransaction> {
  const res = await fetchJson<{ swapTransaction: string }>(endpoints.jupiterSwap, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey,
      // pump tokens are traded against SOL, so let Jupiter handle the wrapping
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: Math.floor(priorityFeeSol * LAMPORTS),
    }),
    timeoutMs: 25_000,
  });

  return VersionedTransaction.deserialize(Buffer.from(res.swapTransaction, 'base64'));
}

export function signSwap(tx: VersionedTransaction, signer: Keypair): VersionedTransaction {
  tx.sign([signer]);
  return tx;
}

/** Convenience: quote how much SOL a token position is worth right now. */
export async function quoteTokenToSol(
  mint: string,
  rawAmount: bigint,
  slippageBps: number,
): Promise<{ sol: number; priceImpact: number } | null> {
  if (rawAmount <= 0n) return null;
  try {
    const q = await getQuote({
      inputMint: mint,
      outputMint: WSOL_MINT,
      amount: rawAmount,
      slippageBps,
    });
    return {
      sol: Number(q.outAmount) / LAMPORTS,
      priceImpact: Number(q.priceImpactPct) || 0,
    };
  } catch {
    // no route — usually an illiquid or freshly launched token
    return null;
  }
}
