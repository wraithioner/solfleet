/** Offline regressions for transaction status handling. Never contacts an RPC. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import bs58 from 'bs58';
import { createHash } from 'node:crypto';
import {
  ComputeBudgetInstruction,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction,
  createCloseAccountInstruction,
} from '@solana/spl-token';

const temporaryData = fs.mkdtempSync(path.join(os.tmpdir(), 'solfleet-transactions-'));

process.env.BOT_TOKEN = '123:TEST';
process.env.OWNER_IDS = '1';
process.env.DATA_DIR = temporaryData;
process.env.VAULT_AUTOLOCK_MINUTES = '0';
process.env.JUPITER_REQUEST_INTERVAL_MS = '0';
process.env.SOLANA_RPC_URL = 'http://127.0.0.1:8899';
process.env.SOLANA_SEND_RPC_URL = process.env.SOLANA_RPC_URL;

const { getBundleStatus, sendBundle, waitForBundle } = await import('../src/trade/jito.js');
const { endpoints } = await import('../src/config.js');
const { TransactionRejectedError, TransactionSubmissionUnknownError } = await import(
  '../src/trade/errors.js'
);
const { rpc, sendAndConfirm, signatureLanded, priorityFeeInstructions } = await import(
  '../src/chains/solana.js'
);
const originalFetch = globalThis.fetch;
const client = rpc();
const originalRpc = {
  sendRawTransaction: client.sendRawTransaction,
  getSignatureStatuses: client.getSignatureStatuses,
  getMultipleAccountsInfo: client.getMultipleAccountsInfo,
  getLatestBlockhash: client.getLatestBlockhash,
  getParsedTokenAccountsByOwner: client.getParsedTokenAccountsByOwner,
};
let closeVault = () => {};
let passed = 0;

function ok(name: string): void {
  passed++;
  console.log(`  ✓ ${name}`);
}

function transaction(
  signer: Keypair,
  blockhash = Keypair.generate().publicKey.toBase58(),
): VersionedTransaction {
  const tx = new VersionedTransaction(
    new TransactionMessage({
      payerKey: signer.publicKey,
      recentBlockhash: blockhash,
      instructions: [
        SystemProgram.transfer({
          fromPubkey: signer.publicKey,
          toPubkey: Keypair.generate().publicKey,
          lamports: 1,
        }),
      ],
    }).compileToV0Message(),
  );
  tx.sign([signer]);
  return tx;
}

/** Venue envelopes for status tests; trade correctness is not simulated here. */
function tradeTransaction(
  signer: Keypair,
  mint: string,
  venue: 'pump' | 'jupiter' = 'pump',
): VersionedTransaction {
  const mintKey = new PublicKey(mint);
  const instructions: TransactionInstruction[] = [];
  const nativeAta = getAssociatedTokenAddressSync(NATIVE_MINT, signer.publicKey);
  if (venue === 'jupiter') {
    instructions.push(
      createAssociatedTokenAccountIdempotentInstruction(
        signer.publicKey,
        nativeAta,
        signer.publicKey,
        NATIVE_MINT,
      ),
      SystemProgram.transfer({
        fromPubkey: signer.publicKey,
        toPubkey: nativeAta,
        lamports: 10_000_000,
      }),
      createSyncNativeInstruction(nativeAta),
    );
  }
  instructions.push(
    new TransactionInstruction({
      programId: new PublicKey(
        venue === 'pump'
          ? '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'
          : 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
      ),
      keys: [
        { pubkey: signer.publicKey, isSigner: true, isWritable: true },
        { pubkey: mintKey, isSigner: false, isWritable: false },
      ],
      data: Buffer.concat([
        createHash('sha256')
          .update(`global:${venue === 'pump' ? 'buy' : 'route'}`)
          .digest()
          .subarray(0, 8),
        Buffer.alloc(16, 1),
      ]),
    }),
  );
  if (venue === 'jupiter')
    instructions.push(createCloseAccountInstruction(nativeAta, signer.publicKey, signer.publicKey));
  const tx = new VersionedTransaction(
    new TransactionMessage({
      payerKey: signer.publicKey,
      recentBlockhash: Keypair.generate().publicKey.toBase58(),
      instructions,
    }).compileToV0Message(),
  );
  // Deterministic signature of this message gives the status assertions their
  // expected identity. External signing discards this supplied signature.
  tx.sign([signer]);
  return tx;
}

function confirmed(): ReturnType<typeof client.getSignatureStatuses> {
  return Promise.resolve({
    context: { slot: 1 },
    value: [{ slot: 1, confirmations: 1, err: null, confirmationStatus: 'confirmed' }],
  });
}

async function statusResponse(response: unknown, expected: string, name: string): Promise<void> {
  let requests = 0;
  globalThis.fetch = async (_input, init) => {
    requests++;
    const request = JSON.parse(String(init?.body));
    assert.equal(request.method, 'getBundleStatuses');
    assert.deepEqual(request.params, [['offline-bundle']]);
    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  assert.equal(await getBundleStatus('offline-bundle'), expected, name);
  assert.equal(requests, 1, 'the status check uses only the mocked request');
  ok(name);
}

function bundleEntry(confirmation_status: string, err: unknown): unknown {
  return {
    jsonrpc: '2.0',
    id: 1,
    result: {
      context: { slot: 242806119 },
      value: [
        {
          bundle_id: 'offline-bundle',
          transactions: ['offline-signature'],
          slot: 242804011,
          confirmation_status,
          err,
        },
      ],
    },
  };
}

try {
  // Actual Jito wire format from its getBundleStatuses response example.
  await statusResponse(
    bundleEntry('finalized', { Ok: null }),
    'Landed',
    'Jito { Ok: null } finalized bundle landed',
  );
  await statusResponse(
    bundleEntry('confirmed', { Ok: null }),
    'Landed',
    'Jito { Ok: null } confirmed bundle landed',
  );
  await statusResponse(
    bundleEntry('processed', { Ok: null }),
    'Pending',
    'processed bundle still awaits confirmation',
  );
  await statusResponse(bundleEntry('confirmed', null), 'Landed', 'null error remains compatible');
  await statusResponse(
    bundleEntry('confirmed', { Err: { InstructionError: [1, { Custom: 6004 }] } }),
    'Failed',
    'explicit Jito Err is a failed bundle',
  );
  await statusResponse(
    bundleEntry('finalized', { Ok: null, Err: 'failure' }),
    'Failed',
    'Err cannot be masked by an Ok field',
  );
  await statusResponse(
    { jsonrpc: '2.0', id: 1, result: { value: [null] } },
    'Pending',
    'missing bundle remains pending',
  );
  await statusResponse(
    { jsonrpc: '2.0', id: 1, error: { code: -32005, message: 'unavailable' } },
    'Unknown',
    'RPC error is unknown rather than a transaction failure',
  );

  globalThis.fetch = async () => {
    throw new Error('offline transport failure');
  };
  assert.equal(await getBundleStatus('offline-bundle'), 'Unknown');
  ok('transport failure leaves the outcome unknown');

  const tx = transaction(Keypair.generate());
  const expectedSignature = bs58.encode(tx.signatures[0]!);
  let sends = 0;
  client.sendRawTransaction = async () => {
    sends++;
    throw new Error('provider lost the send response');
  };
  await assert.rejects(sendAndConfirm(tx), (err: unknown) => {
    assert.ok(err instanceof TransactionSubmissionUnknownError);
    assert.equal(err.signature, expectedSignature);
    return true;
  });
  assert.equal(sends, 1);
  ok('lost send response preserves the original signature and remains ambiguous');

  client.sendRawTransaction = async () => expectedSignature;
  client.getSignatureStatuses = async () => {
    throw new Error('status provider unavailable');
  };
  await assert.rejects(sendAndConfirm(tx), TransactionSubmissionUnknownError);
  ok('confirmation RPC failure remains ambiguous');

  await assert.rejects(sendAndConfirm(tx, { timeoutMs: 0 }), TransactionSubmissionUnknownError);
  ok('confirmation timeout remains ambiguous');

  client.getSignatureStatuses = async () => ({
    context: { slot: 1 },
    value: [
      {
        slot: 1,
        confirmations: 1,
        err: { InstructionError: [0, { Custom: 6004 }] },
        confirmationStatus: 'confirmed',
      },
    ],
  });
  await assert.rejects(sendAndConfirm(tx), (err: unknown) => {
    assert.ok(err instanceof TransactionRejectedError);
    assert.equal(err.signature, expectedSignature);
    return true;
  });
  ok('explicit chain rejection is a definite failure');

  client.getSignatureStatuses = confirmed;
  assert.equal(await sendAndConfirm(tx), expectedSignature);
  ok('confirmed transaction returns its signed identity');

  client.getSignatureStatuses = async () => ({ context: { slot: 1 }, value: [null] });
  assert.equal(await signatureLanded(expectedSignature), 'unknown');
  ok('an absent RPC status does not prove the transaction cannot land');

  client.getSignatureStatuses = async () => ({
    context: { slot: 1 },
    value: [
      {
        slot: 1,
        confirmations: 0,
        err: { InstructionError: [0, { Custom: 6004 }] },
        confirmationStatus: 'processed',
      },
    ],
  });
  assert.equal(await signatureLanded(expectedSignature), 'unknown');
  await assert.rejects(sendAndConfirm(tx, { timeoutMs: 1 }), TransactionSubmissionUnknownError);
  ok('processed error awaiting confirmation cannot authorize a second spend');

  for (const units of [20_000, 200_000]) {
    const fee = ComputeBudgetInstruction.decodeSetComputeUnitPrice(
      priorityFeeInstructions(0, units)[1]!,
    );
    assert.equal(fee.microLamports, 0n);
  }
  assert.throws(() => priorityFeeInstructions(-1), /non-negative/);
  assert.throws(() => priorityFeeInstructions(Number.NaN), /finite/);
  ok('zero priority fee charges exactly zero, including SOL sweep compute budgets');

  globalThis.fetch = async () => {
    throw new Error('bundle response lost after dispatch');
  };
  await assert.rejects(sendBundle([tx]), TransactionSubmissionUnknownError);
  ok('lost bundle send response remains ambiguous');
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: { code: -32602, message: 'bundle rejected' } }));
  await assert.rejects(sendBundle([tx]), TransactionRejectedError);
  ok('explicit bundle rejection is a definite failure');
  globalThis.fetch = async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1 }));
  await assert.rejects(sendBundle([tx]), TransactionSubmissionUnknownError);
  ok('missing bundle id leaves submission ambiguous');
  assert.equal(await waitForBundle('offline-bundle', 0), 'Pending');
  ok('bundle deadline preserves pending state');

  const vault = await import('../src/store/vault.js');
  const wallets = await import('../src/store/wallets.js');
  const { db } = await import('../src/store/db.js');
  const { batchPumpTrade, batchSweepToken } = await import('../src/trade/engine.js');
  vault.initVaultWithKeyfile();
  closeVault = vault.lockVault;
  const wallet = wallets.generateSolanaWallet('offline-transaction-wallet');
  const signer = wallets.solanaKeypair(wallet);
  const request = {
    action: 'buy' as const,
    mint: Keypair.generate().publicKey.toBase58(),
    amount: 0.01,
    denominatedInSol: true,
    slippagePercent: 5,
    priorityFeeSol: 0.00005,
    pool: 'pump' as const,
  };
  db.updateSettings({ priorityFeeMode: 'fixed', executionMode: 'parallel' });
  client.getMultipleAccountsInfo = async keys =>
    keys.map(() => ({
      data: Buffer.alloc(0),
      executable: false,
      lamports: 1e9,
      owner: SystemProgram.programId,
      rentEpoch: 0,
    }));
  let builds = 0;
  let builtSignature = '';
  globalThis.fetch = async input => {
    assert.equal(String(input), 'https://pumpportal.fun/api/trade-local');
    builds++;
    const built = tradeTransaction(signer, request.mint);
    builtSignature = bs58.encode(built.signatures[0]!);
    return new Response(built.serialize());
  };
  sends = 0;
  client.sendRawTransaction = async () => {
    sends++;
    throw new Error('send response lost');
  };
  const ambiguous = await batchPumpTrade([wallet], request, 'parallel');
  assert.equal(builds, 1);
  assert.equal(sends, 1);
  assert.equal(ambiguous.results[0]?.confirmationUnknown, true);
  assert.equal(ambiguous.results[0]?.signature, builtSignature);
  ok('PumpPortal ambiguous submission is not rebuilt and retains its signature');

  builds = 0;
  sends = 0;
  client.sendRawTransaction = async bytes => {
    sends++;
    return bs58.encode(VersionedTransaction.deserialize(new Uint8Array(bytes)).signatures[0]!);
  };
  let checks = 0;
  client.getSignatureStatuses = async () => {
    checks++;
    if (checks === 1) {
      return {
        context: { slot: 1 },
        value: [
          {
            slot: 1,
            confirmations: 1,
            err: { InstructionError: [0, { Custom: 6004 }] },
            confirmationStatus: 'confirmed',
          },
        ],
      };
    }
    return confirmed();
  };
  const retried = await batchPumpTrade([wallet], request, 'parallel');
  assert.equal(builds, 2);
  assert.equal(sends, 2);
  assert.equal(retried.results[0]?.ok, true);
  assert.equal(retried.results[0]?.confirmationUnknown, undefined);
  ok('a definite chain rejection can be rebuilt and confirmed safely');

  client.getSignatureStatuses = confirmed;
  const progressFailure = await batchPumpTrade([wallet], request, 'parallel', async () => {
    throw new Error('Telegram unavailable');
  });
  assert.equal(progressFailure.results[0]?.ok, true);
  ok('progress notification failure does not change a confirmed trade result');

  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url === 'https://pumpportal.fun/api/trade-local')
      return new Response('unavailable', { status: 400 });
    if (url.startsWith(`${endpoints.jupiterQuote}?`)) {
      return new Response(
        JSON.stringify({
          inputMint: NATIVE_MINT.toBase58(),
          outputMint: request.mint,
          inAmount: '10000000',
          outAmount: '100',
          otherAmountThreshold: '95',
          swapMode: 'ExactIn',
          slippageBps: 500,
          priceImpactPct: '0',
          routePlan: [{ swapInfo: { label: 'Offline venue fixture' }, percent: 100 }],
          platformFee: null,
        }),
      );
    }
    if (url === endpoints.jupiterSwap) {
      assert.ok(JSON.parse(String(init?.body)).userPublicKey === wallet.address);
      return new Response(
        JSON.stringify({
          swapTransaction: Buffer.from(
            tradeTransaction(signer, request.mint, 'jupiter').serialize(),
          ).toString('base64'),
        }),
      );
    }
    throw new Error(`Unexpected offline request: ${url}`);
  };
  sends = 0;
  client.sendRawTransaction = async () => {
    sends++;
    throw new Error('Jupiter send response lost');
  };
  const jupiterAmbiguous = await batchPumpTrade([wallet], request, 'parallel');
  assert.equal(sends, 1);
  assert.equal(jupiterAmbiguous.results[0]?.confirmationUnknown, true);
  assert.ok(jupiterAmbiguous.results[0]?.signature);
  ok('Jupiter fallback preserves uncertain submission state');

  globalThis.fetch = async (input, init) => {
    if (String(input) === 'https://pumpportal.fun/api/trade-local') {
      assert.ok(Array.isArray(JSON.parse(String(init?.body))));
      return new Response(
        JSON.stringify([bs58.encode(tradeTransaction(signer, request.mint).serialize())]),
      );
    }
    if (String(input) === 'https://mainnet.block-engine.jito.wtf/api/v1/bundles')
      throw new Error('Jito send response lost');
    throw new Error(`Unexpected offline request: ${String(input)}`);
  };
  const bundleAmbiguous = await batchPumpTrade([wallet], request, 'bundle');
  assert.equal(bundleAmbiguous.results[0]?.confirmationUnknown, true);
  assert.ok(bundleAmbiguous.results[0]?.signature);
  ok('Jito batch preserves each uncertain transaction signature');

  const sourceAccount = Keypair.generate().publicKey;
  const destination = Keypair.generate().publicKey.toBase58();
  client.getParsedTokenAccountsByOwner = async (_owner, filter) => ({
    context: { slot: 1 },
    value:
      'programId' in filter && filter.programId.equals(TOKEN_PROGRAM_ID)
        ? [
            {
              pubkey: sourceAccount,
              account: {
                executable: false,
                lamports: 2_039_280,
                owner: TOKEN_PROGRAM_ID,
                rentEpoch: 0,
                data: {
                  program: 'spl-token',
                  space: 165,
                  parsed: {
                    info: {
                      mint: request.mint,
                      tokenAmount: { amount: '123000000', decimals: 6, uiAmount: 123 },
                    },
                  },
                },
              },
            },
          ]
        : [],
  });
  client.getLatestBlockhash = async () => ({
    blockhash: Keypair.generate().publicKey.toBase58(),
    lastValidBlockHeight: 100,
  });
  client.getSignatureStatuses = confirmed;
  let sweepTx: VersionedTransaction | undefined;
  client.sendRawTransaction = async bytes => {
    sweepTx = VersionedTransaction.deserialize(new Uint8Array(bytes));
    return bs58.encode(sweepTx.signatures[0]!);
  };
  const swept = await batchSweepToken([wallet], request.mint, destination);
  assert.equal(swept.results[0]?.ok, true);
  assert.ok(sweepTx);
  const transfer = sweepTx.message.compiledInstructions[3]!;
  const close = sweepTx.message.compiledInstructions[4]!;
  assert.equal(
    sweepTx.message.staticAccountKeys[transfer.accountKeyIndexes[0]!]!.toBase58(),
    sourceAccount.toBase58(),
  );
  assert.equal(
    sweepTx.message.staticAccountKeys[close.accountKeyIndexes[0]!]!.toBase58(),
    sourceAccount.toBase58(),
  );
  ok('token sweep transfers and closes the actual non-associated holding account');
} finally {
  globalThis.fetch = originalFetch;
  Object.assign(client, originalRpc);
  closeVault();
  fs.rmSync(temporaryData, { recursive: true, force: true });
}

console.log(`\n${passed} offline transaction regressions passed.`);
