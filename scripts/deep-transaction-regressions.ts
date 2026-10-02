/** Adversarial external-builder checks. All HTTP and send operations are offline. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash, createPublicKey, verify } from 'node:crypto';
import bs58 from 'bs58';
import { ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { createAssociatedTokenAccountIdempotentInstruction, createCloseAccountInstruction, createSyncNativeInstruction, createApproveInstruction, createSetAuthorityInstruction, AuthorityType, getAssociatedTokenAddressSync, NATIVE_MINT } from '@solana/spl-token';
import type { TradeArgs } from '../src/trade/pumpportal.js';
import type { JupQuote } from '../src/trade/jupiter.js';

process.env.BOT_TOKEN = '123:TEST';
process.env.OWNER_IDS = '1';
process.env.SOLANA_RPC_URL = 'http://127.0.0.1:8899';
process.env.SOLANA_SEND_RPC_URL = process.env.SOLANA_RPC_URL;
process.env.JUPITER_REQUEST_INTERVAL_MS = '0';

const { buildTrade, buildTradeBundle, signTx } = await import('../src/trade/pumpportal.js');
const { getQuote, buildSwap, executeSwap, signSwap, validateQuote } = await import('../src/trade/jupiter.js');
const { assertExternalTrade, ExternalTransactionValidationError, JITO_TIP_ACCOUNTS, JUPITER_PROGRAM, pumpSwapVariants } = await import('../src/trade/validation.js');
const { rpc, WSOL_MINT } = await import('../src/chains/solana.js');
const { endpoints } = await import('../src/config.js');
const originalFetch = globalThis.fetch;
const client = rpc();
const originalSend = client.sendRawTransaction;
let sends = 0;
client.sendRawTransaction = async () => { sends++; throw new Error('No broadcast is permitted in this regression.'); };
globalThis.fetch = async () => { throw new Error('No network request is permitted in this regression.'); };
const wallet = Keypair.generate();
const other = Keypair.generate();
const mint = Keypair.generate().publicKey;
const ata = getAssociatedTokenAddressSync(NATIVE_MINT, wallet.publicKey);
const anchor = (name: string) => createHash('sha256').update(`global:${name}`).digest().subarray(0, 8);
const pumpInstruction = (action = 'buy') => new TransactionInstruction({
  programId: new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'),
  keys: [{ pubkey: wallet.publicKey, isSigner: true, isWritable: true }, { pubkey: mint, isSigner: false, isWritable: false }],
  data: Buffer.concat([anchor(action), Buffer.alloc(16, 1)]),
});
const jupiterInstruction = () => new TransactionInstruction({
  programId: new PublicKey(JUPITER_PROGRAM),
  keys: [{ pubkey: wallet.publicKey, isSigner: true, isWritable: true }, { pubkey: mint, isSigner: false, isWritable: false }],
  data: Buffer.concat([anchor('route'), Buffer.alloc(4)]),
});
function transaction(instructions: TransactionInstruction[], payer = wallet.publicKey): VersionedTransaction {
  return new VersionedTransaction(new TransactionMessage({ payerKey: payer, recentBlockhash: other.publicKey.toBase58(), instructions }).compileToV0Message());
}
const pumpArgs = {
  publicKey: wallet.publicKey.toBase58(), action: 'buy' as const, mint: mint.toBase58(),
  amount: 0.001, denominatedInSol: 'true' as const, slippage: 5, priorityFee: 0.00005, pool: 'pump' as const,
};
const quoteParams = { inputMint: WSOL_MINT, outputMint: mint.toBase58(), amount: 1_000_000n, slippageBps: 50 };
const quote = {
  inputMint: WSOL_MINT, outputMint: mint.toBase58(), inAmount: '1000000', outAmount: '10000',
  otherAmountThreshold: '9950', swapMode: 'ExactIn' as const, slippageBps: 50, priceImpactPct: '0.01',
  routePlan: [{ swapInfo: { label: 'Offline fixture' }, percent: 100 }], platformFee: null,
};
const policy = {
  wallet: wallet.publicKey.toBase58(), priorityFeeSol: 0.00005, swaps: pumpSwapVariants('pump', 'buy'),
  mints: [WSOL_MINT, mint.toBase58()], wrappedSolLamports: 1_000_000n,
};
let passed = 0;
function ok(name: string): void { passed++; console.log(`  ✓ ${name}`); }
function refuses(tx: VersionedTransaction, name: string, extra: Partial<typeof policy> = {}): void {
  assert.throws(() => assertExternalTrade(tx, { ...policy, ...extra }), ExternalTransactionValidationError);
  ok(name);
}
function bytesResponse(tx: VersionedTransaction): Response { return new Response(tx.serialize()); }
function validSignature(tx: VersionedTransaction): boolean {
  const pk = createPublicKey({ format: 'der', type: 'spki', key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), wallet.publicKey.toBuffer()]) });
  return verify(null, tx.message.serialize(), pk, tx.signatures[0]!);
}

try {
  let quoteRequests = 0;
  let swapRequests = 0;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.startsWith(`${endpoints.jupiterQuote}?`)) {
      quoteRequests++;
      assert.equal(new URL(url).searchParams.get('swapMode'), 'ExactIn');
      return new Response(JSON.stringify({ ...quote, inputMint: other.publicKey.toBase58() }));
    }
    swapRequests++;
    throw new Error('A rejected quote must not request a transaction.');
  };
  await assert.rejects(executeSwap(wallet, { ...quoteParams, priorityFeeSol: 0.00005 }), ExternalTransactionValidationError);
  assert.equal(quoteRequests, 1);
  assert.equal(swapRequests, 0);
  assert.equal(sends, 0);
  ok('a mismatched quote never reaches transaction building or sending');

  for (const [name, patch] of [
    ['wrong output mint', { outputMint: other.publicKey.toBase58() }],
    ['wrong input amount', { inAmount: '10000000000' }],
    ['ExactOut response', { swapMode: 'ExactOut' }],
    ['changed slippage', { slippageBps: 9999 }],
    ['zero output', { outAmount: '0' }],
    ['zero threshold', { otherAmountThreshold: '0' }],
    ['loosened threshold', { otherAmountThreshold: '9000' }],
    ['threshold above quote', { otherAmountThreshold: '10001' }],
    ['noncanonical amount', { inAmount: '01000000' }],
    ['u64 overflow', { outAmount: '18446744073709551616' }],
    ['missing route', { routePlan: [] }],
    ['unexpected fee', { platformFee: { amount: '1', feeBps: 1 } }],
  ] as const) {
    assert.throws(() => validateQuote({ ...quote, ...patch }, quoteParams), ExternalTransactionValidationError);
    ok(`quote rejects ${name}`);
  }
  assert.equal(validateQuote(quote, quoteParams), quote);
  assert.equal(validateQuote({ ...quote, otherAmountThreshold: '9951' }, quoteParams).otherAmountThreshold, '9951');
  ok('valid exact-input quote and conservative threshold remain compatible');

  const bareTransfer = transaction([SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: other.publicKey, lamports: 10_000_000_000 })]);
  globalThis.fetch = async () => bytesResponse(bareTransfer);
  await assert.rejects(buildTrade(pumpArgs), ExternalTransactionValidationError);
  ok('PumpPortal cannot return a plain unrelated SOL transfer');
  refuses(transaction([pumpInstruction(), SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: other.publicKey, lamports: 10_000_000_000 })]), 'appended 10 SOL wallet transfer is rejected');
  refuses(transaction([pumpInstruction(), SystemProgram.assign({ accountPubkey: wallet.publicKey, programId: other.publicKey })]), 'wallet assignment/nonce-style System operations are rejected');
  refuses(transaction([pumpInstruction(), new TransactionInstruction({ programId: other.publicKey, keys: [{ pubkey: wallet.publicKey, isSigner: true, isWritable: true }], data: Buffer.alloc(8) })]), 'an unknown program cannot be appended beside a valid swap');
  refuses(transaction([pumpInstruction(), createApproveInstruction(ata, other.publicKey, wallet.publicKey, 1n)]), 'token approval is rejected');
  refuses(transaction([pumpInstruction(), createSetAuthorityInstruction(ata, wallet.publicKey, AuthorityType.AccountOwner, other.publicKey)]), 'token authority replacement is rejected');
  refuses(transaction([pumpInstruction(), createCloseAccountInstruction(ata, other.publicKey, wallet.publicKey)]), 'token closure to an unexpected recipient is rejected');

  const wrapped = transaction([
    createAssociatedTokenAccountIdempotentInstruction(wallet.publicKey, ata, wallet.publicKey, NATIVE_MINT),
    SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: ata, lamports: 1_000_000 }),
    createSyncNativeInstruction(ata), pumpInstruction(), createCloseAccountInstruction(ata, wallet.publicKey, wallet.publicKey),
  ]);
  assertExternalTrade(wrapped, policy);
  ok('bounded WSOL ATA funding and wallet cleanup remain compatible');
  refuses(transaction([pumpInstruction(), SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: ata, lamports: 1_000_001 })]), 'WSOL funding cannot exceed the requested input');
  refuses(transaction([pumpInstruction(), ...[600_000, 600_000].map((lamports) => SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: ata, lamports }))]), 'split WSOL transfers cannot bypass the aggregate input cap');
  const foreignAta = getAssociatedTokenAddressSync(NATIVE_MINT, other.publicKey);
  refuses(transaction([pumpInstruction(), createAssociatedTokenAccountIdempotentInstruction(wallet.publicKey, foreignAta, other.publicKey, NATIVE_MINT)]), 'wallet cannot pay for an unrelated owner ATA');

  refuses(transaction([pumpInstruction()], other.publicKey), 'a foreign fee payer/additional signer is rejected');
  const readonly = transaction([pumpInstruction()]);
  readonly.message.header.numReadonlySignedAccounts = 1;
  refuses(readonly, 'the wallet signer must be writable');
  const missingSignature = transaction([pumpInstruction()]);
  missingSignature.signatures = [];
  refuses(missingSignature, 'malformed signature count is rejected');
  const loadedProgram = transaction([pumpInstruction()]);
  if (loadedProgram.message.version === 0) {
    loadedProgram.message.addressTableLookups.push({ accountKey: other.publicKey, writableIndexes: [], readonlyIndexes: [0] });
    loadedProgram.message.compiledInstructions[0]!.programIdIndex = loadedProgram.message.staticAccountKeys.length;
  }
  refuses(loadedProgram, 'an unresolved lookup-table program cannot hide a compute fee');

  const withFee = (units: number, price: bigint) => transaction([ComputeBudgetProgram.setComputeUnitLimit({ units }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: price }), pumpInstruction()]);
  assertExternalTrade(withFee(200_000, 250_000n), policy);
  ok('exact requested 50000-lamport compute fee is accepted');
  refuses(withFee(1_400_000, 1_000_000_000n), 'API cannot replace a small fee with a 1.4 SOL priority fee');
  refuses(withFee(1, 1n), 'fractional-lamport fee rounds up rather than disappearing', { priorityFeeSol: 0 });
  refuses(withFee(200_000, 18_446_744_073_709_551_615n), 'u64 CU price is checked with bigint precision');
  refuses(transaction([ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000n }), pumpInstruction()]), 'missing CU limit uses a conservative 1.4m-unit fee ceiling');
  refuses(transaction([ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 0 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 0 }), pumpInstruction()]), 'duplicate compute-price instructions are rejected');
  refuses(transaction([new TransactionInstruction({ programId: ComputeBudgetProgram.programId, keys: [], data: Buffer.alloc(9) }), pumpInstruction()]), 'deprecated compute-budget instructions are rejected');
  refuses(withFee(1_400_001, 0n), 'out-of-range compute limit is rejected');

  globalThis.fetch = async () => bytesResponse(transaction([pumpInstruction()]));
  const built = await buildTrade(pumpArgs);
  built.signatures[0] = new Uint8Array(64).fill(42);
  const signed = signTx(built, wallet);
  assert.ok(validSignature(signed));
  assert.notEqual(signed, built);
  assert.deepEqual(built.signatures[0], new Uint8Array(64).fill(42));
  ok('signing replaces builder signatures and leaves the external object untouched');
  built.message = transaction([pumpInstruction(), SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: other.publicKey, lamports: 1 })]).message;
  assert.throws(() => signTx(built, wallet), ExternalTransactionValidationError);
  assert.throws(() => signTx(bareTransfer, wallet), ExternalTransactionValidationError);
  ok('signing rechecks modified messages and refuses unvalidated messages');

  const tip = new PublicKey([...JITO_TIP_ACCOUNTS][0]!);
  const tipTx = transaction([pumpInstruction(), SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: tip, lamports: 100_000 })]);
  globalThis.fetch = async () => new Response(JSON.stringify([bs58.encode(tipTx.serialize())]));
  const bundled = await buildTradeBundle([{ ...pumpArgs, priorityFee: 0.0001 }]);
  assert.ok(validSignature(signTx(bundled[0]!, wallet)));
  ok('documented first-transaction Jito tip remains compatible');
  const doubleBid = transaction([ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 500_000n }), pumpInstruction(),
    SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: tip, lamports: 100_000 })]);
  globalThis.fetch = async () => new Response(JSON.stringify([bs58.encode(doubleBid.serialize())]));
  await assert.rejects(buildTradeBundle([{ ...pumpArgs, priorityFee: 0.0001 }]), /combined compute fee/);
  ok('one bundle fee parameter cannot fund both a full compute fee and a full tip');
  globalThis.fetch = async () => new Response(JSON.stringify([bs58.encode(tipTx.serialize()), bs58.encode(tipTx.serialize())]));
  await assert.rejects(buildTradeBundle([{ ...pumpArgs, priorityFee: 0.0001 }, { ...pumpArgs, priorityFee: 0 }]), ExternalTransactionValidationError);
  ok('later bundle transaction cannot add another tip');
  globalThis.fetch = async () => new Response(JSON.stringify([]));
  await assert.rejects(buildTradeBundle([pumpArgs]), /transactions for/);
  ok('builder bundle count is checked before signing');

  globalThis.fetch = async () => new Response(JSON.stringify({ swapTransaction: Buffer.from(transaction([jupiterInstruction()]).serialize()).toString('base64') }));
  const swap = await buildSwap(quote, wallet.publicKey.toBase58(), 0.00005);
  swap.signatures[0] = new Uint8Array(64).fill(42);
  assert.ok(validSignature(signSwap(swap, wallet)));
  assert.notEqual(signSwap(swap, wallet), swap);
  ok('Jupiter also discards supplied signatures and signs a fresh object');
  globalThis.fetch = async () => new Response(JSON.stringify({ swapTransaction: Buffer.from(bareTransfer.serialize()).toString('base64') }));
  await assert.rejects(buildSwap(quote, wallet.publicKey.toBase58(), 0.00005), ExternalTransactionValidationError);
  ok('Jupiter cannot return an unrelated standalone transaction');
  globalThis.fetch = async () => new Response(JSON.stringify({ ...quote, otherAmountThreshold: '0' }));
  await assert.rejects(getQuote(quoteParams), ExternalTransactionValidationError);
  assert.equal(sends, 0);
  ok('all adversarial cases finish with zero broadcasts');

  // Replay actual unsigned API messages captured with throwaway public keys.
  // This verifies envelope compatibility, not on-chain validity or spend intent.
  const fixtures = JSON.parse(fs.readFileSync(new URL('./fixtures/external-builder-unsigned.json', import.meta.url), 'utf8')) as {
    samples: Array<{ kind: 'pump' | 'pump-bundle' | 'jupiter'; transactionBase64: string; args?: TradeArgs; quote?: JupQuote; userPublicKey?: string; priorityFeeSol?: number; index?: number }>;
  };
  for (const sample of fixtures.samples) {
    const raw = Buffer.from(sample.transactionBase64, 'base64');
    const unsigned = VersionedTransaction.deserialize(raw);
    assert.equal(unsigned.signatures.some((signature) => signature.some((byte) => byte !== 0)), false);
    if (sample.kind === 'pump') {
      globalThis.fetch = async () => new Response(raw);
      await buildTrade(sample.args!);
    } else if (sample.kind === 'pump-bundle') {
      globalThis.fetch = async () => new Response(JSON.stringify([bs58.encode(raw)]));
      await buildTradeBundle([sample.args!]);
    } else {
      globalThis.fetch = async () => new Response(JSON.stringify({ swapTransaction: sample.transactionBase64 }));
      await buildSwap(sample.quote!, sample.userPublicKey!, sample.priorityFeeSol!);
    }
    ok(`captured unsigned ${sample.kind} ${sample.args?.action ?? 'SOL→USDC'}${sample.index === undefined ? '' : ` index ${sample.index}`} remains compatible`);
  }
  assert.equal(sends, 0);
  console.log(`\n${passed} external-transaction regressions passed.`);
} finally {
  globalThis.fetch = originalFetch;
  client.sendRawTransaction = originalSend;
}
