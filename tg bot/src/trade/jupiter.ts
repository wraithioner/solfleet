import { VersionedTransaction, Keypair } from '@solana/web3.js';
import { endpoints } from '../config.js';
import { fetchJson } from '../util.js';
import { LAMPORTS, WSOL_MINT, sendAndConfirm } from '../chains/solana.js';

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

/**
 * Quote, build, sign and send one swap.
 *
 * This is the fallback route for everything pump.fun cannot handle — a token
 * that graduated to Raydium, an airdrop nobody launched on a curve, the USDC a
 * wallet was funded with. Without it, "sell everything" quietly means "sell
 * everything that happens to be a live pump.fun token".
 */
export async function executeSwap(
  signer: Keypair,
  params: {
    inputMint: string;
    outputMint: string;
    /** Raw amount in the input mint's smallest unit. */
    amount: bigint;
    slippageBps: number;
    priorityFeeSol: number;
  },
): Promise<{ signature: string; outAmount: bigint }> {
  if (params.amount <= 0n) throw new Error('Nothing to swap.');

  const quote = await getQuote({
    inputMint: params.inputMint,
    outputMint: params.outputMint,
    amount: params.amount,
    slippageBps: params.slippageBps,
  });

  const tx = await buildSwap(quote, signer.publicKey.toBase58(), params.priorityFeeSol);
  const signature = await sendAndConfirm(signSwap(tx, signer), { skipPreflight: true });

  return { signature, outAmount: BigInt(quote.outAmount) };
}

/** Sell a token position back to SOL. */
export function swapToSol(
  signer: Keypair,
  mint: string,
  rawAmount: bigint,
  slippageBps: number,
  priorityFeeSol: number,
): Promise<{ signature: string; outAmount: bigint }> {
  return executeSwap(signer, {
    inputMint: mint,
    outputMint: WSOL_MINT,
    amount: rawAmount,
    slippageBps,
    priorityFeeSol,
  });
}

/** Buy a token with SOL. */
export function swapFromSol(
  signer: Keypair,
  mint: string,
  sol: number,
  slippageBps: number,
  priorityFeeSol: number,
): Promise<{ signature: string; outAmount: bigint }> {
  return executeSwap(signer, {
    inputMint: WSOL_MINT,
    outputMint: mint,
    amount: BigInt(Math.floor(sol * LAMPORTS)),
    slippageBps,
    priorityFeeSol,
  });
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
