import {
  Connection,
  Keypair,
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
} from '@solana/spl-token';
import { config } from '../config.js';
import { retry } from '../util.js';
import type { TokenBalance } from '../types.js';

export const LAMPORTS = LAMPORTS_PER_SOL;
export const WSOL_MINT = 'So11111111111111111111111111111111111111112';

/** Base signature fee. Real cost is this times the number of signatures. */
const BASE_FEE_LAMPORTS = 5000;

let connection: Connection | null = null;
let sendConnection: Connection | null = null;

export function rpc(): Connection {
  if (!connection) connection = new Connection(config.solana.rpcUrl, { commitment: 'confirmed' });
  return connection;
}

export function sendRpc(): Connection {
  if (!sendConnection) {
    sendConnection =
      config.solana.sendRpcUrl === config.solana.rpcUrl
        ? rpc()
        : new Connection(config.solana.sendRpcUrl, { commitment: 'confirmed' });
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
  const keys = addresses.map((a) => new PublicKey(a));

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
    retry(() => rpc().getParsedTokenAccountsByOwner(owner, { programId: TOKEN_2022_PROGRAM_ID })).catch(
      () => ({ value: [] as never[] }),
    ),
  ]);

  const holdings: SplHolding[] = [];

  for (const { value, programId } of [
    { value: classic.value, programId: TOKEN_PROGRAM_ID.toBase58() },
    { value: token22.value, programId: TOKEN_2022_PROGRAM_ID.toBase58() },
  ]) {
    for (const acc of value) {
      const info = (acc.account.data as never as { parsed: { info: ParsedTokenInfo } }).parsed.info;
      const raw = BigInt(info.tokenAmount.amount);
      if (raw === 0n) continue;
      holdings.push({
        mint: info.mint,
        symbol: info.mint.slice(0, 4),
        amount: info.tokenAmount.uiAmount ?? 0,
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
}

/** Balance of one specific mint. Returns zeros when the wallet holds none. */
export async function getTokenBalance(address: string, mint: string): Promise<SplHolding | null> {
  const all = await getSplBalances(address);
  return all.find((h) => h.mint === mint) ?? null;
}

// ── transaction plumbing ──────────────────────────────────────────────────────

export function priorityFeeInstructions(priorityFeeSol: number, computeUnits = 200_000): TransactionInstruction[] {
  const lamports = Math.floor(priorityFeeSol * LAMPORTS);
  // microLamports per compute unit, derived from the total SOL the user is willing to tip
  const microLamportsPerCu = Math.max(1, Math.floor((lamports * 1_000_000) / computeUnits));
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

export async function sendAndConfirm(
  tx: VersionedTransaction,
  opts: { skipPreflight?: boolean; timeoutMs?: number } = {},
): Promise<string> {
  const signature = await sendRpc().sendRawTransaction(tx.serialize(), {
    skipPreflight: opts.skipPreflight ?? true,
    maxRetries: 3,
  });
  await confirmSignature(signature, opts.timeoutMs ?? 60_000);
  return signature;
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

    if (status) {
      if (status.err) throw new Error(`Transaction failed on-chain: ${JSON.stringify(status.err)}`);
      if (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized') return;
    }

    await new Promise((r) => setTimeout(r, 1500));
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
  const lamports = BigInt(await rpc().getBalance(from.publicKey));

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
): Promise<string> {
  const mintKey = new PublicKey(mint);
  const destOwner = new PublicKey(to);
  const program = new PublicKey(programId);

  const source = getAssociatedTokenAddressSync(mintKey, from.publicKey, true, program);
  const dest = getAssociatedTokenAddressSync(mintKey, destOwner, true, program);

  const ixs: TransactionInstruction[] = [
    ...priorityFeeInstructions(priorityFeeSol, 80_000),
    // idempotent: costs nothing extra if the destination ATA already exists,
    // and avoids a separate round trip to check
    createAssociatedTokenAccountIdempotentInstruction(from.publicKey, dest, destOwner, mintKey, program),
    createTransferCheckedInstruction(source, mintKey, dest, from.publicKey, rawAmount, decimals, [], program),
  ];

  // reclaim the ~0.002 SOL rent sitting in the now-empty token account
  if (closeAccountAfter) {
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

export function estimateSweepableSol(lamports: bigint, reserveSol: number, priorityFeeSol: number): number {
  const cost = BigInt(BASE_FEE_LAMPORTS) + BigInt(Math.floor((reserveSol + priorityFeeSol) * LAMPORTS));
  const net = lamports - cost;
  return net > 0n ? Number(net) / LAMPORTS : 0;
}
