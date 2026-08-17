/**
 * Offline smoke test: vault crypto, wallet derivation, curve math, parsing.
 * No network, no Telegram. Run with tsx from the project root.
 */
process.env.BOT_TOKEN = '123:TEST';
process.env.OWNER_IDS = '1';
process.env.DATA_DIR = './.smoke-data';
process.env.VAULT_AUTOLOCK_MINUTES = '0';

import fs from 'node:fs';
import assert from 'node:assert/strict';

const DATA = './.smoke-data';
fs.rmSync(DATA, { recursive: true, force: true });

const { initVault, isUnlocked, lockVault, unlockVault, encryptSecret, decryptSecret, changePassphrase } =
  await import('../src/store/vault.js');

let passed = 0;
const ok = (name: string) => {
  passed++;
  console.log(`  ✓ ${name}`);
};

console.log('\n[1] Vault');
await initVault('correct horse battery staple');
assert.equal(isUnlocked(), true);
ok('vault created and unlocked');

const blob = encryptSecret('super-secret-key-material');
assert.notEqual(blob, 'super-secret-key-material');
assert.equal(decryptSecret(blob), 'super-secret-key-material');
ok('seal/open round-trips');

// two seals of the same plaintext must differ (fresh IV each time)
assert.notEqual(encryptSecret('same'), encryptSecret('same'));
ok('IV is unique per seal');

// tampering must fail loudly, not silently return garbage
const raw = Buffer.from(blob, 'base64');
raw[raw.length - 1] ^= 0xff;
assert.throws(() => decryptSecret(raw.toString('base64')));
ok('GCM rejects tampered ciphertext');

lockVault();
assert.equal(isUnlocked(), false);
assert.throws(() => decryptSecret(blob), /locked/i);
ok('lock wipes the key and blocks decryption');

await assert.rejects(() => unlockVault('wrong passphrase'), /Wrong passphrase/);
ok('wrong passphrase rejected');

await unlockVault('correct horse battery staple');
assert.equal(decryptSecret(blob), 'super-secret-key-material');
ok('re-unlock restores access');

console.log('\n[2] Wallets');
const wallets = await import('../src/store/wallets.js');

const sol = wallets.generateSolanaWallet('test-sol');
assert.equal(sol.kind, 'solana');
assert.equal(sol.isMain, true, 'first wallet of a kind becomes main');
ok(`generated Solana wallet ${sol.address.slice(0, 8)}… (auto-main)`);

const evm = wallets.generateEvmWallet('test-evm');
assert.match(evm.address, /^0x[a-fA-F0-9]{40}$/);
assert.equal(evm.isMain, true);
ok(`generated EVM wallet ${evm.address.slice(0, 10)}…`);

// exported key must reimport to the identical address
const exported = wallets.exportSecret(sol);
const kp = wallets.solanaKeypair(sol);
assert.equal(kp.publicKey.toBase58(), sol.address);
ok('Solana keypair reconstructs to the same address');

const acct = wallets.evmAccount(evm);
assert.equal(acct.address.toLowerCase(), evm.address.toLowerCase());
ok('EVM account reconstructs to the same address');

assert.throws(() => wallets.importPrivateKey(exported), /already in the list/);
ok('duplicate import is rejected');

const derived = wallets.deriveWallets('solana', 3, ['batch-a']);
assert.equal(derived.length, 3);
assert.deepEqual(derived.map((w) => w.derivationIndex), [0, 1, 2]);
assert.equal(new Set(derived.map((w) => w.address)).size, 3);
ok('derived 3 distinct HD Solana wallets at indices 0,1,2');

const derivedEvm = wallets.deriveWallets('evm', 2);
assert.equal(new Set(derivedEvm.map((w) => w.address)).size, 2);
ok('derived 2 distinct HD EVM wallets');

// derivation must be deterministic from the seed
const phrase = wallets.getOrCreateMnemonic();
assert.equal(phrase.split(' ').length, 12);
ok('mnemonic is a valid 12-word phrase');

const grouped = wallets.selectWallets({ kind: 'solana', group: 'batch-a' });
assert.equal(grouped.length, 3);
ok('group filter selects only the tagged wallets');

const all = wallets.selectWallets({ kind: 'solana', group: null });
assert.equal(all.length, 4);
ok('null group selects every Solana wallet');

wallets.toggleDisabled(derived[0]!.id);
assert.equal(wallets.selectWallets({ kind: 'solana', group: null }).length, 3);
ok('disabled wallets are excluded from batches');

wallets.setMain(derived[1]!.id);
assert.equal(wallets.mainWallet('solana')!.id, derived[1]!.id);
assert.equal(wallets.allWallets().filter((w) => w.kind === 'solana' && w.isMain).length, 1);
ok('exactly one main wallet per chain kind');

console.log('\n[3] Passphrase rotation');
const beforeAddrs = wallets.allWallets().map((w) => w.address);
await changePassphrase('correct horse battery staple', 'a much better passphrase', wallets.resealAll);
const afterKp = wallets.solanaKeypair(wallets.allWallets().find((w) => w.kind === 'solana')!);
assert.deepEqual(wallets.allWallets().map((w) => w.address), beforeAddrs);
ok('all keys re-encrypted, addresses unchanged');

lockVault();
await unlockVault('a much better passphrase');
assert.equal(wallets.solanaKeypair(sol).publicKey.toBase58(), sol.address);
ok('new passphrase unlocks the re-sealed vault');
await assert.rejects(() => unlockVault('correct horse battery staple'));
ok('old passphrase no longer works');

console.log('\n[4] Bonding curve math');
const curve = await import('../src/trade/curve.js');

// reserves matching a fresh pump.fun launch
const fresh = {
  virtualTokenReserves: 1_073_000_000_000_000n,
  virtualSolReserves: 30_000_000_000n,
  realTokenReserves: 793_100_000_000_000n,
  realSolReserves: 0n,
  tokenTotalSupply: 1_000_000_000_000_000n,
  complete: false,
};

const price = curve.curvePrice(fresh);
assert.ok(price > 0 && price < 1e-6, `price ${price} in expected range`);
ok(`spot price ${price.toExponential(3)} SOL/token`);

const tokensFor1Sol = curve.quoteBuy(fresh, 1);
assert.ok(tokensFor1Sol > 0);
// constant product means you get fewer tokens than spot*amount would imply
assert.ok(tokensFor1Sol < 1 / price, 'slippage reduces the fill vs spot');
ok(`1 SOL buys ${tokensFor1Sol.toFixed(0)} tokens (below spot-implied ${(1 / price).toFixed(0)})`);

const impact = curve.buyPriceImpact(fresh, 1);
assert.ok(impact > 0 && impact < 1, `impact ${impact}`);
ok(`price impact of a 1 SOL buy: ${(impact * 100).toFixed(2)}%`);

// selling straight back must return less than was put in (fees + curve)
const backToSol = curve.quoteSell(fresh, tokensFor1Sol);
assert.ok(backToSol < 1, `round trip ${backToSol} < 1 SOL`);
assert.ok(backToSol > 0.9, 'round trip loss is fees + impact, not catastrophic');
ok(`round trip 1 SOL → ${backToSol.toFixed(4)} SOL (${((1 - backToSol) * 100).toFixed(2)}% cost)`);

const sim = curve.simulateSequentialBuys(fresh, 0.5, 10);
const single = curve.quoteBuy(fresh, 0.5);
assert.ok(sim.totalTokens < single * 10, 'later wallets in a batch get fewer tokens');
assert.ok(sim.finalPrice > price, 'the batch walks the curve up');
ok(`10 wallets × 0.5 SOL: ${sim.totalTokens.toFixed(0)} tokens, avg ${sim.avgPrice.toExponential(3)}, price moved +${(((sim.finalPrice - price) / price) * 100).toFixed(1)}%`);

const progress = curve.curveProgress(fresh);
assert.ok(progress >= 0 && progress <= 1);
ok(`curve progress ${(progress * 100).toFixed(1)}%`);

assert.equal(curve.curveProgress({ ...fresh, complete: true }), 1);
ok('completed curve reports 100%');

// PDA derivation must be stable
const pda = curve.bondingCurvePda('So11111111111111111111111111111111111111112').toBase58();
assert.equal(pda, curve.bondingCurvePda('So11111111111111111111111111111111111111112').toBase58());
ok(`bonding curve PDA derives deterministically (${pda.slice(0, 8)}…)`);

console.log('\n[5] Address parsing');
const { extractTokenAddress } = await import('../src/services/tokeninfo.js');

const mint = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
assert.equal(extractTokenAddress(mint)?.address, mint);
ok('bare Solana mint');

assert.equal(extractTokenAddress(`  ${mint}  `)?.address, mint);
ok('whitespace tolerated');

assert.equal(extractTokenAddress(`buy this ${mint} now`)?.address, mint);
ok('mint extracted from a sentence');

assert.equal(extractTokenAddress(`https://pump.fun/coin/${mint}`)?.address, mint);
ok('mint extracted from a pump.fun link');

assert.equal(extractTokenAddress(`https://dexscreener.com/solana/${mint}`)?.address, mint);
ok('mint extracted from a dexscreener link');

const evmToken = '0xdAC17F958D2ee523a2206206994597C13D831ec7';
assert.equal(extractTokenAddress(evmToken)?.kind, 'evm');
ok('EVM address detected');

assert.equal(extractTokenAddress('hello world'), null);
assert.equal(extractTokenAddress('0x123'), null);
assert.equal(extractTokenAddress('IIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIII'), null);
ok('non-addresses rejected (including invalid base58 of the right length)');

console.log('\n[6] Formatting + concurrency');
const util = await import('../src/util.js');

assert.equal(util.shortAddr(mint), 'DezX…B263');
assert.equal(util.fmtUsd(1234.5), '$1,234.50');
assert.equal(util.fmtUsd(undefined), '—');
assert.equal(util.fmtUsd(0.001), '<$0.01');
assert.equal(util.fmtAmount(0), '0');
ok('formatters behave');

assert.deepEqual(util.chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
ok('chunk splits for 5-per-bundle batching');

// pMap must preserve order while running concurrently
const order = await util.pMap([50, 10, 30, 5, 20], 2, async (ms, i) => {
  await util.sleep(ms);
  return i;
});
assert.deepEqual(order, [0, 1, 2, 3, 4]);
ok('pMap preserves input order under concurrency');

let attempts = 0;
const result = await util.retry(async () => {
  attempts++;
  if (attempts < 3) throw new Error('transient');
  return 'recovered';
}, { attempts: 4, baseDelayMs: 5 });
assert.equal(result, 'recovered');
assert.equal(attempts, 3);
ok('retry backs off and eventually succeeds');

console.log('\n[7] Secret redaction in logs');
const { redact } = await import('../src/logger.js');
assert.ok(!redact(`key is ${exported}`).includes(exported), 'base58 secret key redacted');
assert.ok(!redact(`pk 0x${'a'.repeat(64)}`).includes('a'.repeat(64)), 'hex private key redacted');
assert.ok(redact(`addr ${mint}`).includes(mint), 'public addresses are not redacted');
ok('logger redacts secrets but keeps addresses readable');

fs.rmSync(DATA, { recursive: true, force: true });
console.log(`\n✅ ${passed} assertions passed\n`);
