import { VersionedTransaction, type Keypair } from '@solana/web3.js';
import { endpoints } from '../config.js';
import { fetchJupiterJson } from '../services/jupiter-client.js';
import { LAMPORTS, WSOL_MINT, sendAndConfirm } from '../chains/solana.js';
import {
  assertExternalTrade,
  ExternalTransactionValidationError,
  jupiterSwapVariants,
  priorityFeeLamports,
  signExternalTransaction,
} from './validation.js';

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
  swapMode: 'ExactIn';
  platformFee?: { amount: string; feeBps: number } | null;
}

interface QuoteParams {
  inputMint: string;
  outputMint: string;
  /** Raw amount in the input mint's smallest unit. */
  amount: bigint;
  slippageBps: number;
  onlyDirectRoutes?: boolean;
}

const U64_MAX = (1n << 64n) - 1n;

function quoteFailure(reason: string): never {
  throw new ExternalTransactionValidationError(`Jupiter quote ${reason}`);
}

function positiveQuoteAmount(value: unknown, field: string): bigint {
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value))
    quoteFailure(`has an invalid ${field}.`);
  const amount = BigInt(value);
  if (amount > U64_MAX) quoteFailure(`has an out-of-range ${field}.`);
  return amount;
}

/** Bind a provider response to the exact input trade before requesting a swap. */
export function validateQuote(value: unknown, params: QuoteParams): JupQuote {
  if (params.amount <= 0n || params.amount > U64_MAX)
    quoteFailure('input must be a positive u64 amount.');
  if (
    !Number.isInteger(params.slippageBps) ||
    params.slippageBps < 0 ||
    params.slippageBps >= 10_000
  ) {
    quoteFailure('slippage must be an integer from 0 to 9999 basis points.');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    quoteFailure('is not an object.');
  const q = value as JupQuote;
  if (q.inputMint !== params.inputMint || q.outputMint !== params.outputMint)
    quoteFailure('mints do not match the request.');
  if (q.swapMode !== 'ExactIn') quoteFailure('must use ExactIn.');
  if (positiveQuoteAmount(q.inAmount, 'inAmount') !== params.amount)
    quoteFailure('input amount does not match the request.');
  if (q.slippageBps !== params.slippageBps) quoteFailure('slippage does not match the request.');
  const output = positiveQuoteAmount(q.outAmount, 'outAmount');
  const threshold = positiveQuoteAmount(q.otherAmountThreshold, 'otherAmountThreshold');
  const minimum = (output * BigInt(10_000 - params.slippageBps)) / 10_000n;
  if (threshold > output || threshold < minimum)
    quoteFailure('output threshold does not honor the requested slippage.');
  if (!Array.isArray(q.routePlan) || q.routePlan.length === 0) quoteFailure('has no route.');
  if (
    typeof q.priceImpactPct !== 'string' ||
    !Number.isFinite(Number(q.priceImpactPct)) ||
    Number(q.priceImpactPct) < 0
  ) {
    quoteFailure('has an invalid price impact.');
  }
  // This bot never requests an integrator fee. Preserve the rest of Jupiter's
  // response for the builder, but reject an unexpected platform fee.
  if (q.platformFee != null && (q.platformFee.amount !== '0' || q.platformFee.feeBps !== 0)) {
    quoteFailure('contains an unexpected platform fee.');
  }
  return q;
}

export async function getQuote(params: QuoteParams): Promise<JupQuote> {
  if (params.amount <= 0n || params.amount > U64_MAX)
    quoteFailure('input must be a positive u64 amount.');
  if (
    !Number.isInteger(params.slippageBps) ||
    params.slippageBps < 0 ||
    params.slippageBps >= 10_000
  ) {
    quoteFailure('slippage must be an integer from 0 to 9999 basis points.');
  }
  const qs = new URLSearchParams({
    inputMint: params.inputMint,
    outputMint: params.outputMint,
    amount: params.amount.toString(),
    slippageBps: String(params.slippageBps),
    swapMode: 'ExactIn',
    restrictIntermediateTokens: 'true',
  });
  if (params.onlyDirectRoutes) qs.set('onlyDirectRoutes', 'true');

  const quote = await fetchJupiterJson<unknown>(`${endpoints.jupiterQuote}?${qs}`, {
    timeoutMs: 20_000,
  });
  return validateQuote(quote, params);
}

export async function buildSwap(
  quote: JupQuote,
  userPublicKey: string,
  priorityFeeSol: number,
): Promise<VersionedTransaction> {
  // Validate again for direct callers; getQuote additionally binds these fields
  // to the original user request rather than to the quote itself.
  validateQuote(quote, {
    inputMint: quote.inputMint,
    outputMint: quote.outputMint,
    amount: positiveQuoteAmount(quote.inAmount, 'inAmount'),
    slippageBps: quote.slippageBps,
  });
  const feeLamports = priorityFeeLamports(priorityFeeSol);
  const res = await fetchJupiterJson<{ swapTransaction: string }>(endpoints.jupiterSwap, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey,
      // pump tokens are traded against SOL, so let Jupiter handle the wrapping
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: Number(feeLamports),
    }),
    timeoutMs: 25_000,
  });

  if (
    typeof res?.swapTransaction !== 'string' ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(res.swapTransaction)
  ) {
    throw new ExternalTransactionValidationError(
      'Jupiter returned an invalid serialized transaction.',
    );
  }
  const tx = VersionedTransaction.deserialize(Buffer.from(res.swapTransaction, 'base64'));
  assertExternalTrade(tx, {
    wallet: userPublicKey,
    priorityFeeSol,
    swaps: jupiterSwapVariants,
    mints: [quote.inputMint, quote.outputMint],
    wrappedSolLamports: quote.inputMint === WSOL_MINT ? BigInt(quote.inAmount) : 0n,
  });
  return tx;
}

export function signSwap(tx: VersionedTransaction, signer: Keypair): VersionedTransaction {
  return signExternalTransaction(tx, signer);
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
