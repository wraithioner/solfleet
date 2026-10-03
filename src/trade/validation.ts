import { createHash } from 'node:crypto';
import {
  ComputeBudgetProgram,
  type Keypair,
  PublicKey,
  SystemProgram,
  VersionedTransaction,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddressSync,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import type { TradeRequest } from '../types.js';

const MAX_COMPUTE_UNITS = 1_400_000;
const MICRO_LAMPORTS = 1_000_000n;
const LAMPORTS_PER_SOL = 1_000_000_000;

/** A local refusal, before signing or broadcasting an external message. */
export class ExternalTransactionValidationError extends Error {
  constructor(reason: string) {
    super(`External transaction refused: ${reason}`);
    this.name = 'ExternalTransactionValidationError';
  }
}

function refuse(reason: string): never {
  throw new ExternalTransactionValidationError(reason);
}

/** This bot does not request sponsored transactions or additional signers. */
export function assertWalletSigner(tx: VersionedTransaction, wallet: PublicKey): void {
  const { header, staticAccountKeys } = tx.message;
  if (header.numRequiredSignatures !== 1 || tx.signatures.length !== 1) {
    refuse('the wallet must be the only required signer.');
  }
  if (!staticAccountKeys[0]?.equals(wallet) || header.numReadonlySignedAccounts !== 0) {
    refuse('the requested wallet must be the writable fee payer.');
  }
  if (header.numReadonlyUnsignedAccounts > staticAccountKeys.length - 1) {
    refuse('invalid account permissions.');
  }
}

/** Never preserve signatures supplied by a transaction builder. */
export function signExternalTransaction(
  tx: VersionedTransaction,
  signer: Keypair,
): VersionedTransaction {
  assertWalletSigner(tx, signer.publicKey);
  const policy = validatedTrades.get(tx);
  if (!policy) refuse('the message has not passed the external builder checks.');
  // Recheck immediately before signing in case a caller changed the message.
  assertExternalTrade(tx, policy);
  const signed = new VersionedTransaction(tx.message);
  signed.sign([signer]);
  return signed;
}

export function priorityFeeLamports(priorityFeeSol: number): bigint {
  const lamports = Math.floor(priorityFeeSol * LAMPORTS_PER_SOL);
  if (!Number.isFinite(priorityFeeSol) || priorityFeeSol < 0 || !Number.isSafeInteger(lamports)) {
    refuse('priority fee must be a non-negative finite amount in the supported range.');
  }
  return BigInt(lamports);
}

function anchor(name: string): string {
  return createHash('sha256').update(`global:${name}`).digest().subarray(0, 8).toString('hex');
}

interface SwapVariant {
  program: string;
  prefixes: string[];
  minBytes: number;
}

// Presence checks only. They do not decode route accounts, amounts or recipients.
// Primary sources: pump-fun/pump-public-docs/idl/{pump,pump_amm}.json;
// docs.raydium.io/reference/program-addresses and products/amm-v4/instructions;
// raydium-io/{raydium-cp-swap,raydium-clmm}/programs/*/src/lib.rs;
// raydium-io/raydium-sdk-V2/src/raydium/launchpad/instrument.ts.
const PUMP = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const PUMP_AMM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
const RAYDIUM_AMM = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';
const RAYDIUM_CPMM = 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C';
const RAYDIUM_CLMM = 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK';
const LAUNCHLAB = 'LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj';
export const JUPITER_PROGRAM = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
// Observed in the unsigned response of PumpPortal's documented trade-local API
// on 2026-10-02 (buy/sell, documentation example mint). No published IDL/source
// was found. Retain builder trust for this opaque wrapper for compatibility;
// its presence identifies a current builder envelope, not action/spend intent.
const PUMPPORTAL_WRAPPER = 'FAdo9NCw1ssek6Z6yeWzWjhLVsr8uiCwcWNUnKgzTnHe';

// Published constant accounts: docs.jito.wtf/lowlatencytxnsend/#gettipaccounts
export const JITO_TIP_ACCOUNTS = new Set([
  '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
  'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
  'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
  'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49',
  'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh',
  'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt',
  'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL',
  '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT',
]);

function anchorVariant(program: string, names: string[], minBytes = 24): SwapVariant {
  return { program, prefixes: names.map(anchor), minBytes };
}

export function pumpSwapVariants(
  pool: TradeRequest['pool'],
  action: 'buy' | 'sell',
): SwapVariant[] {
  const pump = anchorVariant(
    PUMP,
    action === 'buy'
      ? ['buy', 'buy_exact_sol_in', 'buy_v2', 'buy_exact_quote_in_v2']
      : ['sell', 'sell_v2'],
  );
  const amm = anchorVariant(
    PUMP_AMM,
    action === 'buy'
      ? ['buy', 'buy_exact_quote_in', 'buy_v2', 'buy_exact_quote_in_v2']
      : ['sell', 'sell_v2'],
  );
  // AMM v4 uses a one-byte tag followed by two u64 amounts (9 / 11).
  const raydium = { program: RAYDIUM_AMM, prefixes: ['09', '0b', '10', '11'], minBytes: 17 };
  const cpmm = anchorVariant(RAYDIUM_CPMM, ['swap_base_input', 'swap_base_output']);
  const clmm = anchorVariant(RAYDIUM_CLMM, ['swap', 'swap_v2', 'swap_router_base_in']);
  const launch = anchorVariant(
    LAUNCHLAB,
    action === 'buy' ? ['buy_exact_in', 'buy_exact_out'] : ['sell_exact_in', 'sell_exact_out'],
  );
  const wrapper = { program: PUMPPORTAL_WRAPPER, prefixes: [''], minBytes: 8 };
  switch (pool) {
    case 'pump':
      return [pump, wrapper];
    case 'pump-amm':
      return [amm, wrapper];
    case 'raydium':
      return [raydium, cpmm, clmm, wrapper];
    case 'raydium-cpmm':
      return [cpmm, wrapper];
    case 'launchlab':
    case 'bonk':
      return [launch, wrapper];
    case 'auto':
      return [pump, amm, raydium, cpmm, clmm, launch, wrapper];
  }
}

// Swap V1 requests use the V1 route instruction by default. The V2 variants
// are also published by Jupiter. No token-ledger mode is requested by this bot.
// Source: jup-ag/instruction-parser/src/idl/jupiter.ts and Jupiter's changelog.
export const jupiterSwapVariants: SwapVariant[] = [
  anchorVariant(
    JUPITER_PROGRAM,
    ['route', 'shared_accounts_route', 'route_v2', 'shared_accounts_route_v2'],
    12,
  ),
];

interface TradePolicy {
  wallet: string;
  priorityFeeSol: number;
  swaps: SwapVariant[];
  /** Only these wallet ATAs may be created or closed by top-level instructions. */
  mints: string[];
  /** Maximum direct funding of the wallet's native SOL token account. */
  wrappedSolLamports?: bigint;
  /** Allowed only for the first transaction of a requested Jito bundle. */
  jitoTipLamports?: bigint;
}

const validatedTrades = new WeakMap<VersionedTransaction, TradePolicy>();

/**
 * Check identity, message structure, compute fees and a recognizable swap.
 * This is deliberately a bounded guard: full intent validation still requires
 * decoding every supported venue's accounts/instruction data and resolving ALTs.
 * Top-level wallet transfers/authority changes are checked separately below;
 * this still does not establish the swap's CPI behavior or full spend intent.
 */
export function assertExternalTrade(tx: VersionedTransaction, params: TradePolicy): void {
  assertWalletSigner(tx, new PublicKey(params.wallet));
  const maxFee = priorityFeeLamports(params.priorityFeeSol);
  const keys = tx.message.staticAccountKeys;
  const totalAccounts =
    keys.length + (tx.message.version === 0 ? tx.message.numAccountKeysFromLookups : 0);
  let computeUnits = MAX_COMPUTE_UNITS;
  let microLamports = 0n;
  const seenBudgetTags = new Set<number>();
  let swapFound = false;
  const wallet = new PublicKey(params.wallet);
  const wrappedSol = getAssociatedTokenAddressSync(NATIVE_MINT, wallet);
  const allowedAtas = new Set(
    params.mints.flatMap(mint =>
      [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID].map(program =>
        getAssociatedTokenAddressSync(new PublicKey(mint), wallet, false, program).toBase58(),
      ),
    ),
  );
  let wrappedSolFunded = 0n;
  let tips = 0n;

  for (const ix of tx.message.compiledInstructions) {
    const program = keys[ix.programIdIndex];
    // A loaded program could hide a compute-price instruction. Do not silently
    // skip it. Ordinary loaded trade accounts remain supported without RPC reads.
    if (!program) refuse('a program ID is unresolved in an address lookup table.');
    if (
      ix.accountKeyIndexes.some(
        index => !Number.isInteger(index) || index < 0 || index >= totalAccounts,
      )
    ) {
      refuse('an instruction refers to an invalid account index.');
    }
    const data = Buffer.from(ix.data);
    const account = (position: number): PublicKey => {
      const index = ix.accountKeyIndexes[position];
      const key = index === undefined ? undefined : keys[index];
      if (!key) refuse('a debit account is unresolved in an address lookup table.');
      return key;
    };
    if (program.equals(SystemProgram.programId)) {
      // Wrapping native SOL and a requested Jito tip are the only top-level
      // System transfers this bot asks external builders to include. Refuse
      // nonce, assignment and account-creation variants rather than guess.
      if (
        data.length !== 12 ||
        data.readUInt32LE(0) !== 2 ||
        ix.accountKeyIndexes.length !== 2 ||
        !account(0).equals(wallet)
      ) {
        refuse('unsupported top-level System instruction.');
      }
      const destination = account(1);
      const lamports = data.readBigUInt64LE(4);
      if (destination.equals(wrappedSol)) {
        wrappedSolFunded += lamports;
        if (wrappedSolFunded > (params.wrappedSolLamports ?? 0n))
          refuse('native SOL funding exceeds the requested input.');
      } else if (JITO_TIP_ACCOUNTS.has(destination.toBase58())) {
        tips += lamports;
        if (tips > (params.jitoTipLamports ?? 0n))
          refuse('Jito tip exceeds the requested bundle tip.');
      } else {
        refuse('unexpected direct SOL transfer destination.');
      }
    }
    if (program.equals(ASSOCIATED_TOKEN_PROGRAM_ID)) {
      if (
        !(data.length === 0 || (data.length === 1 && data[0] === 1)) ||
        !account(0).equals(wallet) ||
        !account(2).equals(wallet) ||
        !allowedAtas.has(account(1).toBase58())
      ) {
        refuse('unexpected associated-token-account operation.');
      }
    }
    if (program.equals(TOKEN_PROGRAM_ID) || program.equals(TOKEN_2022_PROGRAM_ID)) {
      // Actual trade transfers are invoked by the swap program. Top-level
      // setup/cleanup only needs SyncNative and CloseAccount for wallet ATAs.
      // This rejects direct token transfers, approvals and authority changes.
      const sync =
        data.length === 1 &&
        data[0] === 17 &&
        ix.accountKeyIndexes.length === 1 &&
        account(0).equals(wrappedSol);
      const close =
        data.length === 1 &&
        data[0] === 9 &&
        ix.accountKeyIndexes.length === 3 &&
        allowedAtas.has(account(0).toBase58()) &&
        account(1).equals(wallet) &&
        account(2).equals(wallet);
      if (!sync && !close)
        refuse('unexpected direct token transfer, authority change or setup instruction.');
    }
    if (program.equals(ComputeBudgetProgram.programId)) {
      const tag = data[0];
      if (
        tag === undefined ||
        ![1, 2, 3, 4].includes(tag) ||
        data.length !== (tag === 3 ? 9 : 5) ||
        ix.accountKeyIndexes.length !== 0
      ) {
        refuse('unsupported or malformed compute-budget instruction.');
      }
      if (seenBudgetTags.has(tag)) refuse('duplicate compute-budget instruction.');
      seenBudgetTags.add(tag);
      if (tag === 2) {
        computeUnits = data.readUInt32LE(1);
        if (computeUnits === 0 || computeUnits > MAX_COMPUTE_UNITS)
          refuse('invalid compute-unit limit.');
      }
      if (tag === 3) microLamports = data.readBigUInt64LE(1);
    }
    const programId = program.toBase58();
    const isSwap = params.swaps.some(
      variant =>
        variant.program === programId &&
        data.length >= variant.minBytes &&
        variant.prefixes.some(
          prefix => data.subarray(0, prefix.length / 2).toString('hex') === prefix,
        ),
    );
    if (isSwap) {
      swapFound = true;
    }
    const isSetup =
      program.equals(ComputeBudgetProgram.programId) ||
      program.equals(SystemProgram.programId) ||
      program.equals(ASSOCIATED_TOKEN_PROGRAM_ID) ||
      program.equals(TOKEN_PROGRAM_ID) ||
      program.equals(TOKEN_2022_PROGRAM_ID);
    if (!isSwap && !isSetup)
      refuse('unexpected top-level program or unsupported swap instruction.');
  }

  const fee = (BigInt(computeUnits) * microLamports + MICRO_LAMPORTS - 1n) / MICRO_LAMPORTS;
  if (fee > maxFee)
    refuse(`compute priority fee ${fee} lamports exceeds the requested ${maxFee} lamports.`);
  if (params.jitoTipLamports !== undefined && fee + tips > maxFee) {
    refuse('combined compute fee and explicit Jito tip exceed the requested bundle budget.');
  }
  if (!swapFound) refuse('no recognized swap instruction for the requested venue and action.');
  if (tx.serialize().length > 1232) refuse("transaction exceeds Solana's packet size.");
  validatedTrades.set(tx, params);
}
