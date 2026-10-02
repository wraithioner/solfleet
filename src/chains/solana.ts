import {
  Connection,
  type Keypair,
  PublicKey,
  SystemProgram,
  ComputeBudgetProgram,
  TransactionMessage,
  VersionedTransaction,
  LAMPORTS_PER_SOL,
  type TransactionInstruction,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  createCloseAccountInstruction,
  unpackMint,
  getTransferFeeAmount,
  unpackAccount,
  createHarvestWithheldTokensToMintInstruction,
} from '@solana/spl-token';
import { config } from '../config.js';
import bs58 from 'bs58';
import { retry } from '../util.js';
import type { TokenBalance } from '../types.js';
import { TransactionRejectedError, TransactionSubmissionUnknownError } from '../trade/errors.js';
import { assertExecutionCurrent } from '../services/execution.js';

export const LAMPORTS = LAMPORTS_PER_SOL;
export const WSOL_MINT = 'So11111111111111111111111111111111111111112';

/** Base signature fee. Real cost is this times the number of signatures. */
export const BASE_FEE_LAMPORTS = 5000;

let connection: Connection | null = null;
let sendConnection: Connection | null = null;

/**
 * Ceiling on a single RPC round trip.
 *
 * web3.js sets no timeout of its own, so an endpoint that accepts the
 * connection and then never replies hangs the caller forever — and because
 * every balance screen awaits one of these, the bot simply stops answering.
 * Rate-limited public endpoints do exactly that under load. Failing at twelve
 * seconds turns a dead screen into a retry and then an error the operator can
 * actually read.
 */
const RPC_TIMEOUT_MS = 12_000;

async function timeoutFetch(
  input: Parameters<typeof fetch>[0],
  init?: RequestInit,
): Promise<Response> {
  const deadline = AbortSignal.timeout(RPC_TIMEOUT_MS);
  // web3.js cancels some requests itself; honour both reasons to give up
  const signal = init?.signal ? AbortSignal.any([init.signal, deadline]) : deadline;

  try {
    return await fetch(input, { ...init, signal });
  } catch (err) {
    if (!deadline.aborted) throw err;

    // "The operation was aborted due to timeout" says nothing about what to do
    const timeout = new Error(
      `Solana RPC did not answer within ${RPC_TIMEOUT_MS / 1000}s.` +
        (config.solana.isPublicRpc
          ? ' The public endpoint stalls on account reads — set SOLANA_RPC_URL to a private one.'
          : ''),
    );
    timeout.name = 'TimeoutError';
    throw timeout;
  }
}

function connect(url: string): Connection {
  return new Connection(url, { commitment: 'confirmed', fetch: timeoutFetch });
}

export function rpc(): Connection {
  if (!connection) connection = connect(config.solana.rpcUrl);
  return connection;
}

export function sendRpc(): Connection {
  if (!sendConnection) {
    sendConnection =
      config.solana.sendRpcUrl === config.solana.rpcUrl ? rpc() : connect(config.solana.sendRpcUrl);
  }
  return sendConnection;
}

// ── balances ──────────────────────────────────────────────────────────────────

export async function getSolBalance(address: string): Promise<{ sol: number; lamports: bigint }> {
  const lamports = await retry(() => rpc().getBalance(new PublicKey(address)), { attempts: 3 });
  return { sol: lamports / LAMPORTS, lamports: BigInt(lamports) };
}

/** Batched SOL balances. getMultipleAccounts caps at 100 keys per call. */
export async function getSolBalances(addresses: string[]): Promise<Map<string, bigint>> {
  const out = new Map<string, bigint>();
  const keys = addresses.map(a => new PublicKey(a));

  for (let i = 0; i < keys.length; i += 100) {
    const slice = keys.slice(i, i + 100);
    const infos = await retry(() => rpc().getMultipleAccountsInfo(slice), { attempts: 3 });
    slice.forEach((key, j) => {
      out.set(key.toBase58(), BigInt(infos[j]?.lamports ?? 0));
    });
  }

  return out;
}

export interface SplHolding extends TokenBalance {
  tokenAccount: string;
  programId: string;
}

/** Every non-zero SPL / Token-2022 position held by an address. */
export async function getSplBalances(address: string): Promise<SplHolding[]> {
  const owner = new PublicKey(address);

  const [classic, token22] = await Promise.all([
    retry(() => rpc().getParsedTokenAccountsByOwner(owner, { programId: TOKEN_PROGRAM_ID })),
    retry(() => rpc().getParsedTokenAccountsByOwner(owner, { programId: TOKEN_2022_PROGRAM_ID })),
  ]);

  const holdings: SplHolding[] = [];

  for (const { value, programId } of [
    { value: classic.value, programId: TOKEN_PROGRAM_ID.toBase58() },
    { value: token22.value, programId: TOKEN_2022_PROGRAM_ID.toBase58() },
  ]) {
    for (const acc of value) {
      const info = (acc.account.data as never as { parsed: { info: ParsedTokenInfo } }).parsed.info;
      assertPublicTokenBalance(info);
      const raw = BigInt(info.tokenAmount.amount);
      if (raw === 0n) continue;
      holdings.push({
        mint: info.mint,
        symbol: info.mint.slice(0, 4),
        // UI floats may be null even though the raw balance is non-zero.
        // Keep accounting in unscaled token units, as used by trade quantities.
        amount: Number(raw) / 10 ** info.tokenAmount.decimals,
        decimals: info.tokenAmount.decimals,
        rawAmount: raw,
        tokenAccount: acc.pubkey.toBase58(),
        programId,
      });
    }
  }

  return holdings;
}

interface ParsedTokenInfo {
  mint: string;
  tokenAmount: { amount: string; decimals: number; uiAmount: number | null };
  extensions?: Array<{ extension: string }>;
}

function assertPublicTokenBalance(info: ParsedTokenInfo): void {
  const amount = info.tokenAmount?.amount;
  const decimals = info.tokenAmount?.decimals;
  if (
    typeof amount !== 'string' ||
    !/^\d{1,20}$/.test(amount) ||
    BigInt(amount) > (1n << 64n) - 1n ||
    !Number.isInteger(decimals) ||
    decimals < 0 ||
    decimals > 255
  ) {
    throw new Error('Token balance response contains an invalid raw amount or decimals.');
  }
  if (info.extensions?.some(ext => ext.extension === 'confidentialTransferAccount')) {
    throw new Error('Confidential token balances cannot be valued by public RPC reads.');
  }
}

/** First account of one mint, retained for callers needing an account address. */
export async function getTokenBalance(address: string, mint: string): Promise<SplHolding | null> {
  const all = await getSplBalances(address);
  return all.find(h => h.mint === mint) ?? null;
}

/** Every account for a mint; a wallet can own several, including non-ATAs. */
export async function getTokenAccounts(address: string, mint: string): Promise<SplHolding[]> {
  return (await getSplBalances(address)).filter(h => h.mint === mint);
}

/** Decimals are immutable mint metadata, never a six-decimal assumption. */
export async function getMintDecimals(mint: string): Promise<number> {
  const key = new PublicKey(mint);
  const info = await retry(() => rpc().getAccountInfo(key), { attempts: 2 });
  if (!info) throw new Error('Mint account is unavailable.');
  if (!info.owner.equals(TOKEN_PROGRAM_ID) && !info.owner.equals(TOKEN_2022_PROGRAM_ID)) {
    throw new Error('Account is not an SPL token mint.');
  }
  const decoded = unpackMint(key, info, info.owner);
  if (!decoded.isInitialized) throw new Error('Mint account is not initialized.');
  return decoded.decimals;
}

/**
 * Raw amount held in an SPL token account, read straight from its data buffer.
 * Layout: mint(32) || owner(32) || amount(u64 LE). Token-2022 keeps the same
 * first 72 bytes and appends its extensions afterwards.
 */
export function parseTokenAccountAmount(data: Uint8Array): bigint {
  if (data.length < 72) return 0n;
  return Buffer.from(data.subarray(64, 72)).readBigUInt64LE(0);
}

/**
 * How much of one mint each of many wallets holds.
 *
 * This deliberately reads all token accounts, rather than only each ATA.
 * Basis resets and full exits cannot treat a non-ATA holding as an empty
 * position. The mint filter covers either token program in one read per owner;
 * bounded concurrency prevents a large wallet set from flooding the RPC.
 */
export async function getMintBalances(
  addresses: string[],
  mint: string,
): Promise<Map<string, bigint>> {
  const out = new Map<string, bigint>();
  if (addresses.length === 0) return out;

  const mintKey = new PublicKey(mint);
  const owners = [...new Set(addresses)];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(5, owners.length) }, async () => {
      while (next < owners.length) {
        const address = owners[next++]!;
        const result = await retry(
          () => rpc().getParsedTokenAccountsByOwner(new PublicKey(address), { mint: mintKey }),
          { attempts: 2 },
        );
        let total = 0n;
        for (const account of result.value) {
          const info = (account.account.data as never as { parsed: { info: ParsedTokenInfo } })
            .parsed.info;
          assertPublicTokenBalance(info);
          if (info.mint !== mint)
            throw new Error('Token balance response contains a different mint.');
          total += BigInt(info.tokenAmount.amount);
        }
        if (total > 0n) out.set(address, total);
      }
    }),
  );

  return out;
}

// ── transaction plumbing ──────────────────────────────────────────────────────

export function priorityFeeInstructions(
  priorityFeeSol: number,
  computeUnits = 200_000,
): TransactionInstruction[] {
  if (!Number.isFinite(priorityFeeSol) || priorityFeeSol < 0)
    throw new Error('Priority fee must be a non-negative finite amount.');
  const lamports = Math.floor(priorityFeeSol * LAMPORTS);
  // microLamports per compute unit, derived from the total SOL the user is willing to tip
  const microLamportsPerCu = Math.max(0, Math.floor((lamports * 1_000_000) / computeUnits));
  return [
    ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnits }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: microLamportsPerCu }),
  ];
}

export async function buildAndSign(
  payer: Keypair,
  instructions: TransactionInstruction[],
  extraSigners: Keypair[] = [],
): Promise<VersionedTransaction> {
  const { blockhash } = await retry(() => rpc().getLatestBlockhash('confirmed'));
  const msg = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message();

  const tx = new VersionedTransaction(msg);
  tx.sign([payer, ...extraSigners]);
  return tx;
}

/**
 * Say what the chain actually objected to.
 *
 * A rejection arrives as `{"InstructionError":[4,{"Custom":6004}]}`, which is
 * true and useless — the operator's first question on seeing one was what it
 * meant, and there is no way to answer that from the message. The codes below
 * were read off failed transactions on chain rather than from documentation:
 * the program names itself in its logs, and 6004 on the AMM turned out to be
 * the slippage limit doing its job.
 *
 * An unrecognised code keeps its raw form. A confident-sounding guess about
 * why money did not move would be worse than the JSON.
 */
const CHAIN_ERRORS: Record<number, string> = {
  // pump-amm/src/instructions/swap/buy.rs — verified on chain
  6004:
    'the price moved past your slippage limit between building the trade and it landing. ' +
    'Nothing was bought and nothing was spent beyond the fee.',
  6040:
    'the price moved past your slippage limit before the trade landed — it would have ' +
    'returned fewer tokens than the limit allows. Nothing was bought.',
};

export function explainChainError(err: unknown): string {
  const raw = JSON.stringify(err);

  const custom = /\{"Custom":(\d+)\}/.exec(raw);
  const code = custom ? Number(custom[1]) : undefined;
  const known = code !== undefined ? CHAIN_ERRORS[code] : undefined;
  if (known) return `The chain rejected it: ${known}`;

  // the two that come from Solana itself rather than from a program
  if (/InsufficientFundsForRent/i.test(raw)) {
    return 'The chain rejected it: the wallet cannot cover the rent this trade needs. Send it a little more SOL.';
  }
  if (/"Custom":1\}/.test(raw) && /InstructionError":\[0/.test(raw)) {
    return 'The chain rejected it: not enough SOL in the wallet for this trade.';
  }

  return `Transaction failed on-chain: ${raw}`;
}

export async function sendAndConfirm(
  tx: VersionedTransaction,
  opts: { skipPreflight?: boolean; timeoutMs?: number } = {},
): Promise<string> {
  // Serialize before dispatch, where a malformed transaction is still a definite
  // local failure. The signed transaction gives us its identity even if the
  // provider accepts it and then loses the response.
  const bytes = tx.serialize();
  const signature = bs58.encode(tx.signatures[0]!);
  assertExecutionCurrent();
  try {
    await sendRpc().sendRawTransaction(bytes, {
      skipPreflight: opts.skipPreflight ?? true,
      maxRetries: 3,
    });
    await confirmSignature(signature, opts.timeoutMs ?? 60_000);
    return signature;
  } catch (err) {
    if (err instanceof TransactionRejectedError) throw err;
    throw new TransactionSubmissionUnknownError(signature, err);
  }
}

/**
 * Did this signature already land?
 *
 * A confirmation timeout is not proof that a transaction failed — it may simply
 * be slow. Re-sending on that assumption is how one intended buy becomes two, so
 * anything that retries a spend checks here first.
 *
 * `unknown` is deliberately distinct from `missing`. If the status cannot be
 * read, the transaction may well be in flight, and a caller that treats "could
 * not check" as "did not land" reintroduces exactly the double-spend this guards
 * against. Not trading is recoverable; trading twice is not.
 */
export type SignatureState = 'landed' | 'missing' | 'unknown';

export async function signatureLanded(signature: string): Promise<SignatureState> {
  try {
    const { value } = await retry(() => rpc().getSignatureStatuses([signature]), { attempts: 3 });
    const status = value[0];
    // Not visible to this RPC is not proof of failure: the transaction can still
    // be queued at another provider while its blockhash remains valid.
    if (!status) return 'unknown';
    if (status.confirmationStatus !== 'confirmed' && status.confirmationStatus !== 'finalized')
      return 'unknown';
    return status.err ? 'missing' : 'landed';
  } catch {
    return 'unknown';
  }
}

/**
 * Poll for confirmation rather than using `confirmTransaction`, which subscribes
 * over websocket and tends to hang on providers that throttle subscriptions.
 */
export async function confirmSignature(signature: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const { value } = await rpc().getSignatureStatuses([signature]);
    const status = value[0];

    if (
      status &&
      (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized')
    ) {
      if (status.err) throw new TransactionRejectedError(explainChainError(status.err), signature);
      return;
    }

    await new Promise(r => setTimeout(r, 1500));
  }

  throw new Error(`Timed out waiting for confirmation of ${signature}`);
}

// ── transfers ─────────────────────────────────────────────────────────────────

export async function sendSol(
  from: Keypair,
  to: string,
  sol: number,
  priorityFeeSol: number,
): Promise<string> {
  const lamports = BigInt(Math.floor(sol * LAMPORTS));
  if (lamports <= 0n) throw new Error('Amount must be greater than zero.');

  const ixs = [
    ...priorityFeeInstructions(priorityFeeSol, 20_000),
    SystemProgram.transfer({
      fromPubkey: from.publicKey,
      toPubkey: new PublicKey(to),
      lamports,
    }),
  ];

  return sendAndConfirm(await buildAndSign(from, ixs));
}

/**
 * Pay many recipients in a single transaction.
 *
 * Funding 50 wallets one transaction at a time costs 50 signature fees and 50
 * confirmations; packing the transfers into one message costs one of each. The
 * cap exists because a Solana transaction is limited to 1232 bytes and every
 * recipient adds a 32-byte account key plus its instruction — 16 recipients
 * serialises to 1004 bytes, which leaves real headroom rather than scraping the
 * limit.
 */
export const MAX_TRANSFERS_PER_TX = 16;

export async function sendSolBatch(
  from: Keypair,
  transfers: Array<{ to: string; lamports: bigint }>,
  priorityFeeSol: number,
): Promise<string> {
  if (transfers.length === 0) throw new Error('Nothing to send.');
  if (transfers.length > MAX_TRANSFERS_PER_TX) {
    throw new Error(`At most ${MAX_TRANSFERS_PER_TX} transfers fit in one transaction.`);
  }

  const ixs = [
    ...priorityFeeInstructions(priorityFeeSol, 10_000 + 5_000 * transfers.length),
    ...transfers.map(t =>
      SystemProgram.transfer({
        fromPubkey: from.publicKey,
        toPubkey: new PublicKey(t.to),
        lamports: t.lamports,
      }),
    ),
  ];

  return sendAndConfirm(await buildAndSign(from, ixs));
}

/**
 * Drain a wallet to `to`, leaving `reserveSol` behind. Returns null when the
 * balance is too small to cover fees — that is a normal outcome in a sweep, not
 * an error worth failing the whole batch over.
 */
export async function sweepSol(
  from: Keypair,
  to: string,
  reserveSol: number,
  priorityFeeSol: number,
): Promise<{ signature: string; sol: number } | null> {
  const lamports = BigInt(await retry(() => rpc().getBalance(from.publicKey), { attempts: 3 }));

  const priorityLamports = BigInt(Math.floor(priorityFeeSol * LAMPORTS));
  const reserveLamports = BigInt(Math.floor(reserveSol * LAMPORTS));
  const cost = BigInt(BASE_FEE_LAMPORTS) + priorityLamports + reserveLamports;

  if (lamports <= cost) return null;

  const amount = lamports - cost;
  const ixs = [
    ...priorityFeeInstructions(priorityFeeSol, 20_000),
    SystemProgram.transfer({
      fromPubkey: from.publicKey,
      toPubkey: new PublicKey(to),
      lamports: amount,
    }),
  ];

  const signature = await sendAndConfirm(await buildAndSign(from, ixs));
  return { signature, sol: Number(amount) / LAMPORTS };
}

export async function sendSplToken(
  from: Keypair,
  to: string,
  mint: string,
  rawAmount: bigint,
  decimals: number,
  priorityFeeSol: number,
  programId = TOKEN_PROGRAM_ID.toBase58(),
  closeAccountAfter = false,
  sourceTokenAccount?: string,
): Promise<string> {
  const mintKey = new PublicKey(mint);
  const destOwner = new PublicKey(to);
  const program = new PublicKey(programId);

  const source = sourceTokenAccount
    ? new PublicKey(sourceTokenAccount)
    : getAssociatedTokenAddressSync(mintKey, from.publicKey, true, program);
  const dest = getAssociatedTokenAddressSync(mintKey, destOwner, true, program);

  const ixs: TransactionInstruction[] = [
    ...priorityFeeInstructions(priorityFeeSol, 80_000),
    // idempotent: costs nothing extra if the destination ATA already exists,
    // and avoids a separate round trip to check
    createAssociatedTokenAccountIdempotentInstruction(
      from.publicKey,
      dest,
      destOwner,
      mintKey,
      program,
    ),
    createTransferCheckedInstruction(
      source,
      mintKey,
      dest,
      from.publicKey,
      rawAmount,
      decimals,
      [],
      program,
    ),
  ];

  // reclaim the ~0.002 SOL rent sitting in the now-empty token account
  if (closeAccountAfter) {
    if (program.equals(TOKEN_2022_PROGRAM_ID)) {
      const info = await retry(() => rpc().getAccountInfo(source), { attempts: 2 });
      if (!info) throw new Error('Source token account is unavailable.');
      const account = unpackAccount(source, info, program);
      if ((getTransferFeeAmount(account)?.withheldAmount ?? 0n) > 0n) {
        ixs.push(createHarvestWithheldTokensToMintInstruction(mintKey, [source], program));
      }
    }
    ixs.push(createCloseAccountInstruction(source, from.publicKey, from.publicKey, [], program));
  }

  return sendAndConfirm(await buildAndSign(from, ixs));
}

export function isValidSolanaAddress(address: string): boolean {
  try {
    const key = new PublicKey(address);
    return PublicKey.isOnCurve(key.toBytes()) || key.toBase58() === address;
  } catch {
    return false;
  }
}

export function estimateSweepableSol(
  lamports: bigint,
  reserveSol: number,
  priorityFeeSol: number,
): number {
  const cost =
    BigInt(BASE_FEE_LAMPORTS) + BigInt(Math.floor((reserveSol + priorityFeeSol) * LAMPORTS));
  const net = lamports - cost;
  return net > 0n ? Number(net) / LAMPORTS : 0;
}

/**
 * What the network is currently charging to get included.
 *
 * A fixed priority fee is wrong twice: too low when the chain is busy, which is
 * exactly when a pump.fun entry is worth landing, and wasteful when it is quiet.
 * Solana exposes what recent blocks actually paid for the accounts a transaction
 * will touch, so the fee can follow the market instead of a guess made days ago.
 *
 * The 75th percentile is deliberate — the median gets outbid during the moments
 * that matter, and the maximum is one desperate bidder rather than the going
 * rate. Returns null when the sample is empty or the call fails, so the caller
 * keeps its configured fee rather than defaulting to something reckless.
 */
export async function recentPriorityFeeMicroLamports(
  accounts: string[] = [],
): Promise<number | null> {
  try {
    const keys = accounts.slice(0, 128).map(a => new PublicKey(a));
    const samples = await retry(
      () => rpc().getRecentPrioritizationFees({ lockedWritableAccounts: keys }),
      {
        attempts: 2,
      },
    );

    const fees = samples
      .map(s => s.prioritizationFee)
      .filter(f => f > 0)
      .sort((a, b) => a - b);
    if (fees.length === 0) return null;

    return fees[Math.min(fees.length - 1, Math.floor(fees.length * 0.75))] ?? null;
  } catch {
    return null;
  }
}

/** Compute units a pump.fun buy or sell realistically consumes. */
export const PUMP_TRADE_COMPUTE_UNITS = 250_000;

/**
 * Turn an observed per-compute-unit price into the whole-SOL figure PumpPortal
 * expects, clamped so a congestion spike cannot quietly spend a fortune on fees
 * and a quiet chain cannot drop the bid to nothing.
 */
export function priorityFeeSolFromMicroLamports(
  microLamportsPerCu: number,
  opts: { floorSol: number; ceilingSol: number; multiplier?: number },
): number {
  const scaled = microLamportsPerCu * (opts.multiplier ?? 1.25);
  const lamports = (scaled * PUMP_TRADE_COMPUTE_UNITS) / 1_000_000;
  const sol = lamports / LAMPORTS;
  return Math.min(opts.ceilingSol, Math.max(opts.floorSol, sol));
}
