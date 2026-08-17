import bs58 from 'bs58';
import type { VersionedTransaction } from '@solana/web3.js';
import { config, type ExecutionMode } from '../config.js';
import { chunk, pMap, errMessage, retry } from '../util.js';
import { log } from '../logger.js';
import { solanaKeypair, evmAccount } from '../store/wallets.js';
import { db } from '../store/db.js';
import { sendAndConfirm, sweepSol, sendSplToken, getSplBalances, getTokenBalance } from '../chains/solana.js';
import { sweepNative, sendErc20, getErc20Balances } from '../chains/evm.js';
import { buildTrade, buildTradeBundle, signTx, toTradeArgs, type TradeArgs } from './pumpportal.js';
import { sendBundle, waitForBundle } from './jito.js';
import { detectPool } from './curve.js';
import type {
  WalletRecord,
  TradeRequest,
  ExecutionResult,
  BatchSummary,
  EvmChain,
} from '../types.js';

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
  const solWallets = wallets.filter((w) => w.kind === 'solana' && !w.disabled);

  if (solWallets.length === 0) {
    return summarise([], startedAt);
  }

  // route to the curve or the AMM depending on whether the token graduated
  const req: TradeRequest = {
    ...request,
    pool: request.pool === 'auto' ? await detectPool(request.mint) : request.pool,
  };

  if (request.action === 'buy' && req.amount > config.safety.maxBuySolPerWallet) {
    throw new Error(
      `Buy of ${req.amount} SOL per wallet exceeds the MAX_BUY_SOL_PER_WALLET limit of ${config.safety.maxBuySolPerWallet}.`,
    );
  }

  log.info(
    `Batch ${req.action} ${req.mint} across ${solWallets.length} wallets (mode=${mode}, pool=${req.pool})`,
  );

  return mode === 'bundle'
    ? bundleTrades(solWallets, req, startedAt, onProgress)
    : parallelTrades(solWallets, req, startedAt, onProgress);
}

async function parallelTrades(
  wallets: WalletRecord[],
  req: TradeRequest,
  startedAt: number,
  onProgress?: ProgressFn,
): Promise<BatchSummary> {
  let done = 0;

  const results = await pMap(wallets, config.trading.concurrency, async (w) => {
    try {
      const kp = solanaKeypair(w);
      const args = toTradeArgs(req, w.address);

      const signature = await retry(
        async () => {
          const tx = await buildTrade(args);
          return sendAndConfirm(signTx(tx, kp), { skipPreflight: true });
        },
        { attempts: 2, baseDelayMs: 600 },
      );

      return {
        walletId: w.id,
        label: w.label,
        address: w.address,
        ok: true,
        signature,
      } satisfies ExecutionResult;
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

      const unsigned = await buildTradeBundle(argsList);
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
    (w) => w.kind === 'solana' && !w.disabled && w.address !== destination,
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
  const senders = wallets.filter((w) => w.kind === 'solana' && !w.disabled && w.address !== destination);
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
  for (const w of wallets.filter((x) => x.kind === 'solana' && !x.disabled)) {
    try {
      for (const h of await getSplBalances(w.address)) mintSet.add(h.mint);
    } catch (err) {
      log.warn(`Could not read positions for ${w.label}: ${errMessage(err)}`);
    }
  }

  const mints = [...mintSet];
  const summaries: Record<string, BatchSummary> = {};

  for (const [i, mint] of mints.entries()) {
    await onProgress?.(i, mints.length, `selling ${mint.slice(0, 6)}…`);

    const holders = wallets.filter((w) => w.kind === 'solana' && !w.disabled);
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

// ── EVM consolidation ─────────────────────────────────────────────────────────

export async function batchSweepEvmNative(
  chain: EvmChain,
  wallets: WalletRecord[],
  destination: string,
  onProgress?: ProgressFn,
): Promise<BatchSummary> {
  const startedAt = Date.now();
  const senders = wallets.filter(
    (w) => w.kind === 'evm' && !w.disabled && w.address.toLowerCase() !== destination.toLowerCase(),
  );
  let done = 0;

  const results = await pMap(senders, config.trading.concurrency, async (w) => {
    try {
      const swept = await sweepNative(chain, evmAccount(w), destination);

      if (!swept) {
        return {
          walletId: w.id,
          label: w.label,
          address: w.address,
          ok: true,
          detail: 'below gas cost',
        } satisfies ExecutionResult;
      }

      return {
        walletId: w.id,
        label: w.label,
        address: w.address,
        ok: true,
        txHash: swept.hash,
        detail: `${swept.amount.toFixed(6)}`,
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

export async function batchSweepEvmToken(
  chain: EvmChain,
  wallets: WalletRecord[],
  token: string,
  destination: string,
  onProgress?: ProgressFn,
): Promise<BatchSummary> {
  const startedAt = Date.now();
  const senders = wallets.filter(
    (w) => w.kind === 'evm' && !w.disabled && w.address.toLowerCase() !== destination.toLowerCase(),
  );
  let done = 0;

  const results = await pMap(senders, config.trading.concurrency, async (w) => {
    try {
      const [balance] = await getErc20Balances(chain, w.address, [token]);
      if (!balance || balance.rawAmount === 0n) {
        return {
          walletId: w.id,
          label: w.label,
          address: w.address,
          ok: true,
          detail: 'no balance',
        } satisfies ExecutionResult;
      }

      const hash = await sendErc20(chain, evmAccount(w), token, destination, balance.rawAmount);
      return {
        walletId: w.id,
        label: w.label,
        address: w.address,
        ok: true,
        txHash: hash,
        detail: `${balance.amount} ${balance.symbol}`,
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
