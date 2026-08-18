import bs58 from 'bs58';
import type { VersionedTransaction, Keypair } from '@solana/web3.js';
import { config, type ExecutionMode } from '../config.js';
import { chunk, pMap, errMessage, retry } from '../util.js';
import { log } from '../logger.js';
import { solanaKeypair } from '../store/wallets.js';
import { db } from '../store/db.js';
import {
  sendAndConfirm,
  sweepSol,
  sendSplToken,
  getSplBalances,
  getTokenBalance,
  getMintBalances,
  signatureLanded,
  recentPriorityFeeMicroLamports,
  priorityFeeSolFromMicroLamports,
  WSOL_MINT,
} from '../chains/solana.js';
import { buildTrade, buildTradeBundle, signTx, toTradeArgs, type TradeArgs } from './pumpportal.js';
import { sendBundle, waitForBundle } from './jito.js';
import { detectPool, PUMP_PROGRAM_ID } from './curve.js';
import { swapToSol, swapFromSol } from './jupiter.js';
import { fundingBalances, partitionByBalance, requiredForBuy } from './fund.js';
import type { WalletRecord, TradeRequest, ExecutionResult, BatchSummary } from '../types.js';

export type ProgressFn = (done: number, total: number, note?: string) => void | Promise<void>;

function summarise(results: ExecutionResult[], startedAt: number): BatchSummary {
  return {
    results,
    succeeded: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    startedAt,
    finishedAt: Date.now(),
  };
}

function fail(w: WalletRecord, err: unknown): ExecutionResult {
  return { walletId: w.id, label: w.label, address: w.address, ok: false, error: errMessage(err) };
}

// ── pump.fun batch trading ────────────────────────────────────────────────────

/**
 * Run one pump.fun trade across many wallets.
 *
 * `parallel` fires each wallet independently — slower to land together, but one
 * wallet failing costs you nothing on the others. `bundle` groups wallets five
 * at a time into Jito bundles so each group executes atomically in a single
 * block, which is what you want for an entry where fill price matters.
 */
export async function batchPumpTrade(
  wallets: WalletRecord[],
  request: TradeRequest,
  mode: ExecutionMode = db.settings().executionMode,
  onProgress?: ProgressFn,
): Promise<BatchSummary> {
  const startedAt = Date.now();
  const solWallets = wallets.filter((w) => !w.disabled);

  if (solWallets.length === 0) {
    return summarise([], startedAt);
  }

  // route to the curve or the AMM depending on whether the token graduated
  const settings = db.settings();
  const req: TradeRequest = {
    ...request,
    pool: request.pool === 'auto' ? await detectPool(request.mint) : request.pool,
    priorityFeeSol: await resolvePriorityFee(request.mint, request.priorityFeeSol),
  };

  if (req.priorityFeeSol !== request.priorityFeeSol) {
    log.info(
      `Priority fee raised to ${req.priorityFeeSol.toFixed(6)} SOL from ${request.priorityFeeSol} ` +
        `(auto, ceiling ${settings.priorityFeeCeilingSol})`,
    );
  }

  if (request.action === 'buy' && req.amount > config.safety.maxBuySolPerWallet) {
    throw new Error(
      `Buy of ${req.amount} SOL per wallet exceeds the MAX_BUY_SOL_PER_WALLET limit of ${config.safety.maxBuySolPerWallet}.`,
    );
  }

  const ctx: TradeContext = {
    // A token still on its curve exists nowhere else, so there is no aggregator
    // to fall back to. Anything else might be routable by Jupiter even when
    // PumpPortal refuses it.
    allowJupiter: req.pool !== 'pump',
    holdings: req.action === 'sell' ? await readHoldings(solWallets, req.mint) : undefined,
  };

  // A wallet with nothing to sell — or nothing to spend — has nothing to do. It
  // is not a failure, and it must not be packed into a bundle either, where one
  // such wallet fails the build for the other four.
  const idle: ExecutionResult[] = [];
  let active = solWallets;

  if (ctx.holdings) {
    const holdings = ctx.holdings;
    active = solWallets.filter((w) => (holdings.get(w.address) ?? 0n) > 0n);
    for (const w of solWallets) {
      if ((holdings.get(w.address) ?? 0n) === 0n) {
        idle.push({ walletId: w.id, label: w.label, address: w.address, ok: true, detail: 'no balance' });
      }
    }
  }

  if (req.action === 'buy') {
    try {
      const balances = await fundingBalances(active.map((w) => w.address));
      const { funded, unfunded } = partitionByBalance(
        active,
        balances,
        requiredForBuy(req.amount, req.priorityFeeSol),
      );

      active = funded;
      for (const w of unfunded) {
        idle.push({
          walletId: w.id,
          label: w.label,
          address: w.address,
          ok: true,
          detail: 'unfunded — send it SOL first',
        });
      }
    } catch (err) {
      log.warn(`Could not pre-read wallet balances: ${errMessage(err)}`);
    }
  }

  log.info(
    `Batch ${req.action} ${req.mint} across ${active.length} wallets ` +
      `(mode=${mode}, pool=${req.pool}, jupiterFallback=${ctx.allowJupiter}` +
      `${idle.length > 0 ? `, ${idle.length} skipped as ${req.action === 'buy' ? 'unfunded' : 'holding none'}` : ''})`,
  );

  if (active.length === 0) return summarise(idle, startedAt);

  const summary =
    mode === 'bundle'
      ? await bundleTrades(active, req, startedAt, ctx, onProgress)
      : await parallelTrades(active, req, startedAt, ctx, onProgress);

  return summarise([...summary.results, ...idle], startedAt);
}

/**
 * Follow the going rate for inclusion, when configured to.
 *
 * The configured fee is the floor rather than the answer: auto mode can only
 * raise the bid, never drop it below what the operator chose, and never above
 * the ceiling. If the network cannot be sampled the configured value stands —
 * an unreadable fee market is not a reason to start guessing with real money.
 */
async function resolvePriorityFee(mint: string, configuredSol: number): Promise<number> {
  const settings = db.settings();
  if (settings.priorityFeeMode !== 'auto') return configuredSol;

  const micro = await recentPriorityFeeMicroLamports([PUMP_PROGRAM_ID.toBase58(), mint]);
  if (micro === null) return configuredSol;

  return priorityFeeSolFromMicroLamports(micro, {
    floorSol: configuredSol,
    ceilingSol: settings.priorityFeeCeilingSol,
  });
}

interface TradeContext {
  /** Whether a failed PumpPortal build may be retried through the aggregator. */
  allowJupiter: boolean;
  /** Raw balances for a sell, so wallets holding nothing are skipped, not failed. */
  holdings?: Map<string, bigint>;
}

/**
 * Read what each wallet actually holds before a sell.
 *
 * Selling 100% across fifty wallets when three of them hold the token used to
 * mean forty-seven failed transactions and forty-seven red rows to read past.
 * The map is only trusted when at least one wallet came back holding something
 * — an entirely empty result is far more likely to be a bad read than fifty
 * genuinely empty wallets the operator just asked to sell.
 */
async function readHoldings(
  wallets: WalletRecord[],
  mint: string,
): Promise<Map<string, bigint> | undefined> {
  try {
    const held = await getMintBalances(wallets.map((w) => w.address), mint);
    return held.size > 0 ? held : undefined;
  } catch (err) {
    log.warn(`Could not pre-read holdings for ${mint}: ${errMessage(err)}`);
    return undefined;
  }
}

/**
 * One wallet's trade, with the aggregator as a second chance.
 *
 * PumpPortal answers HTTP 400 for any mint it cannot route, which is the normal
 * response for a plain SPL token. Treating that as the end of the story is what
 * made "sell everything" silently skip everything that never launched on
 * pump.fun.
 *
 * The venue only switches when the *build* failed, never when a send did. A
 * failed send may still be in flight, and re-buying the same token through a
 * second venue because the first one timed out spends the operator's money
 * twice.
 */
async function tradeOneWallet(
  w: WalletRecord,
  req: TradeRequest,
  ctx: TradeContext,
): Promise<ExecutionResult> {
  const kp = solanaKeypair(w);
  const args = toTradeArgs(req, w.address);

  // probe the route before committing to it — this request signs nothing
  let built;
  try {
    built = await buildTrade(args);
  } catch (buildErr) {
    if (!ctx.allowJupiter) return fail(w, buildErr);
    return tradeViaJupiter(w, req, ctx, kp, buildErr);
  }

  try {
    let lastSignature: string | undefined;

    const signature = await retry(
      async () => {
        if (lastSignature) {
          // a retry after a timeout must not spend again if the first attempt
          // landed — nor if we simply cannot tell whether it did
          const state = await signatureLanded(lastSignature);
          if (state === 'landed') return lastSignature;
          if (state === 'unknown') {
            throw new Error(
              `Sent ${lastSignature.slice(0, 12)}… but could not confirm it. Not retried, ` +
                'to avoid trading twice — check the wallet before trying again.',
            );
          }
        }

        // rebuilt each attempt so the blockhash is fresh
        const tx = lastSignature === undefined ? built : await buildTrade(args);
        const signed = signTx(tx, kp);
        lastSignature = bs58Signature(signed);

        return sendAndConfirm(signed, { skipPreflight: true });
      },
      { attempts: 2, baseDelayMs: 600 },
    );

    return { walletId: w.id, label: w.label, address: w.address, ok: true, signature };
  } catch (sendErr) {
    return fail(w, sendErr);
  }
}

/** The fallback venue, for mints pump.fun will not route at all. */
async function tradeViaJupiter(
  w: WalletRecord,
  req: TradeRequest,
  ctx: TradeContext,
  kp: Keypair,
  pumpErr: unknown,
): Promise<ExecutionResult> {
  const slippageBps = Math.round(req.slippagePercent * 100);

  try {
    if (req.action === 'buy') {
      const { signature } = await swapFromSol(kp, req.mint, req.amount, slippageBps, req.priorityFeeSol);
      return { walletId: w.id, label: w.label, address: w.address, ok: true, signature, detail: 'via Jupiter' };
    }

    // a percentage of whatever the wallet actually holds right now
    const held = ctx.holdings?.get(w.address) ?? (await getTokenBalance(w.address, req.mint))?.rawAmount ?? 0n;
    const rawAmount = (held * BigInt(Math.round(req.amount))) / 100n;
    if (rawAmount <= 0n) {
      return { walletId: w.id, label: w.label, address: w.address, ok: true, detail: 'no balance' };
    }

    const { signature } = await swapToSol(kp, req.mint, rawAmount, slippageBps, req.priorityFeeSol);
    return { walletId: w.id, label: w.label, address: w.address, ok: true, signature, detail: 'via Jupiter' };
  } catch (jupErr) {
    // the pump.fun error is usually the more informative one; keep both
    return {
      ...fail(w, pumpErr),
      detail: `Jupiter also failed: ${errMessage(jupErr).slice(0, 80)}`,
    };
  }
}

async function parallelTrades(
  wallets: WalletRecord[],
  req: TradeRequest,
  startedAt: number,
  ctx: TradeContext,
  onProgress?: ProgressFn,
): Promise<BatchSummary> {
  let done = 0;

  const results = await pMap(wallets, config.trading.concurrency, async (w) => {
    try {
      return await tradeOneWallet(w, req, ctx);
    } catch (err) {
      return fail(w, err);
    } finally {
      done++;
      await onProgress?.(done, wallets.length);
    }
  });

  return summarise(results, startedAt);
}

async function bundleTrades(
  wallets: WalletRecord[],
  req: TradeRequest,
  startedAt: number,
  ctx: TradeContext,
  onProgress?: ProgressFn,
): Promise<BatchSummary> {
  const results: ExecutionResult[] = [];
  const groups = chunk(wallets, 5);
  const tip = db.settings().jitoTipSol;
  let done = 0;

  for (const [gi, group] of groups.entries()) {
    try {
      // PumpPortal takes the first transaction's priority fee as the Jito tip
      // for the whole bundle and ignores the rest, so pay it once up front.
      const argsList: TradeArgs[] = group.map((w, i) => ({
        ...toTradeArgs(req, w.address),
        priorityFee: i === 0 ? tip : 0,
      }));

      let unsigned;
      try {
        unsigned = await buildTradeBundle(argsList);
      } catch (buildErr) {
        // Nothing was submitted, so re-running this group unbundled cannot
        // double-spend. Atomicity is lost, which the result rows say plainly.
        if (!ctx.allowJupiter) throw buildErr;

        log.warn(`Bundle ${gi + 1} could not be built, falling back to individual sends.`);
        const fallback = await parallelTrades(group, req, startedAt, ctx);
        for (const r of fallback.results) {
          results.push({ ...r, detail: [r.detail, 'unbundled fallback'].filter(Boolean).join(' · ') });
        }
        continue;
      }

      if (unsigned.length !== group.length) {
        throw new Error(`PumpPortal returned ${unsigned.length} transactions for ${group.length} wallets.`);
      }

      const signed = unsigned.map((tx, i) => signTx(tx, solanaKeypair(group[i]!)));

      const bundleId = await sendBundle(signed);
      await onProgress?.(done, wallets.length, `bundle ${gi + 1}/${groups.length} sent`);

      const state = await waitForBundle(bundleId);
      const ok = state === 'Landed';

      for (const [i, w] of group.entries()) {
        results.push({
          walletId: w.id,
          label: w.label,
          address: w.address,
          ok,
          signature: ok ? bs58Signature(signed[i]) : undefined,
          error: ok ? undefined : `Bundle ${state.toLowerCase()}`,
          detail: `bundle ${bundleId.slice(0, 8)}…`,
        });
      }
    } catch (err) {
      for (const w of group) results.push(fail(w, err));
    } finally {
      done += group.length;
      await onProgress?.(done, wallets.length);
    }
  }

  return summarise(results, startedAt);
}

function bs58Signature(tx: VersionedTransaction | undefined): string | undefined {
  const sig = tx?.signatures?.[0];
  return sig ? bs58.encode(sig) : undefined;
}

// ── SOL consolidation ─────────────────────────────────────────────────────────

/** Sweep native SOL from every wallet into `destination`. */
export async function batchSweepSol(
  wallets: WalletRecord[],
  destination: string,
  onProgress?: ProgressFn,
): Promise<BatchSummary> {
  const startedAt = Date.now();
  const settings = db.settings();

  const senders = wallets.filter(
    (w) => !w.disabled && w.address !== destination,
  );

  let done = 0;

  const results = await pMap(senders, config.trading.concurrency, async (w) => {
    try {
      const kp = solanaKeypair(w);
      const swept = await sweepSol(kp, destination, settings.sweepReserveSol, settings.priorityFeeSol);

      if (!swept) {
        return {
          walletId: w.id,
          label: w.label,
          address: w.address,
          ok: true,
          detail: 'nothing to sweep',
        } satisfies ExecutionResult;
      }

      return {
        walletId: w.id,
        label: w.label,
        address: w.address,
        ok: true,
        signature: swept.signature,
        detail: `${swept.sol.toFixed(6)} SOL`,
      } satisfies ExecutionResult;
    } catch (err) {
      return fail(w, err);
    } finally {
      done++;
      await onProgress?.(done, senders.length);
    }
  });

  return summarise(results, startedAt);
}

/** Move one SPL token from every wallet into `destination`, closing empty ATAs. */
export async function batchSweepToken(
  wallets: WalletRecord[],
  mint: string,
  destination: string,
  onProgress?: ProgressFn,
): Promise<BatchSummary> {
  const startedAt = Date.now();
  const settings = db.settings();
  const senders = wallets.filter((w) => !w.disabled && w.address !== destination);
  let done = 0;

  const results = await pMap(senders, config.trading.concurrency, async (w) => {
    try {
      const holding = await getTokenBalance(w.address, mint);
      if (!holding || holding.rawAmount === 0n) {
        return {
          walletId: w.id,
          label: w.label,
          address: w.address,
          ok: true,
          detail: 'no balance',
        } satisfies ExecutionResult;
      }

      const signature = await sendSplToken(
        solanaKeypair(w),
        destination,
        mint,
        holding.rawAmount,
        holding.decimals,
        settings.priorityFeeSol,
        holding.programId,
        true, // close the emptied account and reclaim its rent
      );

      return {
        walletId: w.id,
        label: w.label,
        address: w.address,
        ok: true,
        signature,
        detail: `${holding.amount} tokens`,
      } satisfies ExecutionResult;
    } catch (err) {
      return fail(w, err);
    } finally {
      done++;
      await onProgress?.(done, senders.length);
    }
  });

  return summarise(results, startedAt);
}

/**
 * Sell every SPL position a wallet holds, then sweep the resulting SOL. This is
 * the "get me flat and consolidated" button.
 */
export async function batchSellAllPositions(
  wallets: WalletRecord[],
  onProgress?: ProgressFn,
): Promise<{ mints: string[]; summaries: Record<string, BatchSummary> }> {
  const settings = db.settings();

  // discover every distinct mint held across the selected wallets
  const mintSet = new Set<string>();
  for (const w of wallets.filter((x) => !x.disabled)) {
    try {
      for (const h of await getSplBalances(w.address)) mintSet.add(h.mint);
    } catch (err) {
      log.warn(`Could not read positions for ${w.label}: ${errMessage(err)}`);
    }
  }

  // wrapped SOL is already SOL — there is nothing to sell it for
  mintSet.delete(WSOL_MINT);

  const mints = [...mintSet];
  const summaries: Record<string, BatchSummary> = {};

  for (const [i, mint] of mints.entries()) {
    await onProgress?.(i, mints.length, `selling ${mint.slice(0, 6)}…`);

    const holders = wallets.filter((w) => !w.disabled);
    summaries[mint] = await batchPumpTrade(holders, {
      action: 'sell',
      mint,
      amount: 100,
      denominatedInSol: false,
      slippagePercent: settings.slippagePercent,
      priorityFeeSol: settings.priorityFeeSol,
      pool: 'auto',
    });
  }

  await onProgress?.(mints.length, mints.length);
  return { mints, summaries };
}
