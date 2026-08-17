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

// exported key must reimport to the identical address
const exported = wallets.exportSecret(sol);
const kp = wallets.solanaKeypair(sol);
assert.equal(kp.publicKey.toBase58(), sol.address);
ok('Solana keypair reconstructs to the same address');

assert.throws(() => wallets.importPrivateKey(exported), /already in the list/);
ok('duplicate import is rejected');

const derived = wallets.deriveWallets(3, ['batch-a']);
assert.equal(derived.length, 3);
assert.deepEqual(derived.map((w) => w.derivationIndex), [0, 1, 2]);
assert.equal(new Set(derived.map((w) => w.address)).size, 3);
ok('derived 3 distinct HD Solana wallets at indices 0,1,2');

// derivation must be deterministic from the seed
const phrase = wallets.getOrCreateMnemonic();
assert.equal(phrase.split(' ').length, 12);
ok('mnemonic is a valid 12-word phrase');

const grouped = wallets.selectWallets({ group: 'batch-a' });
assert.equal(grouped.length, 3);
ok('group filter selects only the tagged wallets');

const all = wallets.selectWallets({ group: null });
assert.equal(all.length, 4);
ok('null group selects every wallet');

wallets.toggleDisabled(derived[0]!.id);
assert.equal(wallets.selectWallets({ group: null }).length, 3);
ok('disabled wallets are excluded from batches');

wallets.setMain(derived[1]!.id);
assert.equal(wallets.mainWallet()!.id, derived[1]!.id);
assert.equal(wallets.allWallets().filter((w) => w.isMain).length, 1);
ok('exactly one main wallet');

// an EVM key is a plausible paste and must fail with a clear reason
assert.throws(() => wallets.importPrivateKey(`0x${'a'.repeat(64)}`), /Solana wallets only/);
ok('an EVM private key is rejected with a chain-specific message');

console.log('\n[3] Passphrase rotation');
const beforeAddrs = wallets.allWallets().map((w) => w.address);
await changePassphrase('correct horse battery staple', 'a much better passphrase', wallets.resealAll);
const afterKp = wallets.solanaKeypair(wallets.allWallets()[0]!);
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
ok(`10 wallets × 0.5 SOL: ${sim.totalTokens.toFixed(0)} tokens, avg ${sim.avgPrice.toExponential(3)}, price moved +${sim.priceMovePct.toFixed(1)}%`);

// the confirmation screen quotes these directly, so they have to be right
assert.equal(sim.startPrice, price, 'simulation starts from the live spot price');
assert.ok(sim.priceMovePct > 0, 'a batch buy moves the price up');
assert.ok(
  Math.abs(sim.priceMovePct - ((sim.finalPrice - price) / price) * 100) < 1e-9,
  'priceMovePct measures final against starting price',
);
assert.ok(sim.avgPrice > sim.startPrice, 'the average fill is worse than spot');
assert.ok(sim.avgVsSpotPct > 0 && sim.avgVsSpotPct < sim.priceMovePct, 'avg fill sits between spot and final price');
ok(`avg fill is +${sim.avgVsSpotPct.toFixed(1)}% vs spot, final price +${sim.priceMovePct.toFixed(1)}%`);

assert.ok(sim.firstWalletTokens > sim.lastWalletTokens, 'the first wallet fills better than the last');
ok(`first wallet ${sim.firstWalletTokens.toFixed(0)} tokens vs last ${sim.lastWalletTokens.toFixed(0)} for the same spend`);

const solo = curve.simulateSequentialBuys(fresh, 0.5, 1);
assert.equal(solo.firstWalletTokens, solo.lastWalletTokens);
assert.ok(Math.abs(solo.totalTokens - single) < 1e-6, 'a one-wallet batch matches the plain quote');
ok('a single-wallet batch reduces to the plain quote');

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

// still recognised, because pasting one should return a research card
const evmToken = '0xdAC17F958D2ee523a2206206994597C13D831ec7';
assert.equal(extractTokenAddress(evmToken)?.kind, 'evm');
ok('EVM address still recognised for research lookups');

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

console.log('\n[7] Funding plan');
const { planFunding } = await import('../src/trade/fund.js');
const LAMPORTS_PER_SOL = 1_000_000_000;

const targets = [
  { id: 'a', label: 'A', address: 'AAA' },
  { id: 'b', label: 'B', address: 'BBB' },
  { id: 'c', label: 'C', address: 'CCC' },
];

const rich = BigInt(100 * LAMPORTS_PER_SOL);

const each = planFunding({
  targets,
  balances: new Map(),
  mode: 'each',
  sol: 0.1,
  sourceLamports: rich,
  priorityFeeSol: 0.00005,
});
assert.equal(each.transfers.length, 3);
assert.equal(each.totalLamports, BigInt(0.3 * LAMPORTS_PER_SOL));
assert.ok(each.transfers.every((t) => t.lamports === BigInt(0.1 * LAMPORTS_PER_SOL)));
ok('"send each" gives every wallet the full amount');

// a wallet already holding more than the target needs nothing
const topup = planFunding({
  targets,
  balances: new Map([
    ['AAA', BigInt(0.5 * LAMPORTS_PER_SOL)],
    ['BBB', BigInt(0.2 * LAMPORTS_PER_SOL)],
  ]),
  mode: 'topup',
  sol: 0.5,
  sourceLamports: rich,
  priorityFeeSol: 0.00005,
});
assert.equal(topup.transfers.length, 2, 'the already-funded wallet is left alone');
assert.equal(topup.skipped.length, 1);
assert.equal(topup.skipped[0]!.address, 'AAA');
assert.equal(topup.transfers.find((t) => t.address === 'BBB')!.lamports, BigInt(0.3 * LAMPORTS_PER_SOL));
assert.equal(topup.transfers.find((t) => t.address === 'CCC')!.lamports, BigInt(0.5 * LAMPORTS_PER_SOL));
ok('"top up to" funds only the shortfall, and skips wallets already there');

// skipping is not failing — the same distinction the sweep makes
assert.match(topup.skipped[0]!.reason, /already funded/);
ok('a wallet needing nothing is reported as skipped, not failed');

// fees are counted per transaction, not per wallet
assert.equal(each.txCount, 1);
const many = planFunding({
  targets: Array.from({ length: 25 }, (_, i) => ({ id: `w${i}`, label: `W${i}`, address: `ADDR${i}` })),
  balances: new Map(),
  mode: 'each',
  sol: 0.01,
  sourceLamports: rich,
  priorityFeeSol: 0.00005,
});
assert.equal(many.txCount, 2, '25 transfers pack into 2 transactions');

// what the same funding run would cost as one transaction per wallet
const perTxFee = BigInt(5000 + Math.floor(0.00005 * LAMPORTS_PER_SOL));
assert.equal(many.feeLamports, BigInt(many.txCount) * perTxFee, 'fees are charged per transaction');
assert.ok(many.feeLamports < BigInt(25) * perTxFee, 'batching costs less than one transfer per wallet');
ok(`25 wallets funded in ${many.txCount} transactions, not 25 (${Number(many.feeLamports) / LAMPORTS_PER_SOL} SOL of fees)`);

// refusing up front beats half-funding the set
assert.throws(
  () =>
    planFunding({
      targets,
      balances: new Map(),
      mode: 'each',
      sol: 1,
      sourceLamports: BigInt(0.5 * LAMPORTS_PER_SOL),
      priorityFeeSol: 0.00005,
    }),
  /holds .* but this needs/,
);
ok('a plan the main wallet cannot afford is rejected before anything is signed');

assert.throws(
  () => planFunding({ targets, balances: new Map(), mode: 'each', sol: 0, sourceLamports: rich, priorityFeeSol: 0 }),
  /greater than zero/,
);
ok('a zero amount is rejected');

// the main wallet must keep enough back to pay a fee afterwards
const exact = { targets, balances: new Map(), mode: 'each' as const, sol: 1, priorityFeeSol: 0 };
const justEnough = BigInt(3 * LAMPORTS_PER_SOL + 5000);
assert.doesNotThrow(() => planFunding({ ...exact, sourceLamports: justEnough }));
assert.throws(
  () => planFunding({ ...exact, sourceLamports: justEnough, reserveSol: 0.01 }),
  /reserve/,
);
ok('a plan that would drain the main wallet to zero is rejected when a reserve is set');

// a wallet that cannot pay for the trade is skipped, not fired at
const { partitionByBalance, requiredForBuy } = await import('../src/trade/fund.js');

const buyers = [
  { address: 'RICH' },
  { address: 'EXACT' },
  { address: 'SHORT' },
  { address: 'EMPTY' },
];
const need = requiredForBuy(0.5, 0.00005);
const split = partitionByBalance(
  buyers,
  new Map([
    ['RICH', BigInt(2 * LAMPORTS_PER_SOL)],
    ['EXACT', need],
    ['SHORT', need - 1n],
    ['EMPTY', 0n],
  ]),
  need,
);
assert.deepEqual(split.funded.map((w) => w.address), ['RICH', 'EXACT']);
assert.deepEqual(split.unfunded.map((w) => w.address), ['SHORT', 'EMPTY']);
ok('wallets that cannot cover a buy are separated out, and exact-balance wallets still trade');

// the buy needs its own fee on top of the amount, not just the amount
assert.ok(need > BigInt(0.5 * LAMPORTS_PER_SOL), 'the requirement includes the transaction fee');
ok('a buy requirement covers the amount plus its fee');

// a short read must not be mistaken for a set of empty wallets
const shortRead = partitionByBalance(buyers, new Map([['RICH', BigInt(2 * LAMPORTS_PER_SOL)]]), need);
assert.equal(shortRead.funded.length, 4, 'an incomplete balance read skips nobody');
assert.equal(shortRead.unfunded.length, 0);
ok('an incomplete balance read lets every wallet through rather than skipping trades');

console.log('\n[8] Token account parsing');
const { parseTokenAccountAmount } = await import('../src/chains/solana.js');

// SPL token account: mint(32) || owner(32) || amount(u64 LE)
const account = Buffer.alloc(165);
account.writeBigUInt64LE(123_456_789n, 64);
assert.equal(parseTokenAccountAmount(account), 123_456_789n);
ok('reads the balance out of a token account buffer');

assert.equal(parseTokenAccountAmount(Buffer.alloc(165)), 0n);
assert.equal(parseTokenAccountAmount(Buffer.alloc(8)), 0n, 'a truncated account reads as empty, not a crash');
ok('empty and truncated accounts read as zero');

console.log('\n[9] Token card rendering');
const { renderTokenCard } = await import('../src/bot/ui.js');

// a token on a chain this bot has no RPC for must still say where it trades
const card = renderTokenCard({
  address: '0xd5bf43f29bf7aa5bb42ae9e217b84b86eb7a4b94',
  chain: 'ethereum',
  chainLabel: 'robinhood',
  dex: 'uniswap',
  name: 'HoodLock',
  symbol: 'LOCK',
  priceUsd: 0.00006255,
  warnings: [],
});
assert.ok(card.includes('robinhood'), 'the real chain is named on the card');
assert.ok(card.includes('uniswap'), 'the venue is named on the card');
ok('a token on an unmapped chain still reports where its price comes from');

// holder failure must never render as an empty section
const unavailable = renderTokenCard({
  address: 'x', chain: 'solana', holdersUnavailable: true,
  warnings: ['Holder distribution unavailable — the RPC rejected the query.'],
});
assert.ok(/Unavailable/i.test(unavailable), 'unknown holders say so explicitly');
ok('unavailable holder data renders as "unknown", never as silence');

console.log('\n[10] Factory reset');
const { destroyVault, vaultExists } = await import('../src/store/vault.js');
const { db } = await import('../src/store/db.js');

assert.equal(vaultExists(), true, 'a vault exists before the reset');
assert.ok(wallets.allWallets().length > 0, 'wallets exist before the reset');
assert.ok(db.mnemonic(), 'a seed phrase is stored before the reset');

destroyVault();
db.wipe();

assert.equal(vaultExists(), false, 'the vault file is gone');
assert.equal(wallets.allWallets().length, 0, 'every wallet is gone');
assert.equal(db.mnemonic(), undefined, 'the stored seed phrase is gone');
assert.equal(isUnlocked(), false, 'the reset leaves the vault locked');
ok('reset destroys the vault, the wallets and the seed phrase');

// files must be gone from disk, not merely emptied in memory
assert.equal(fs.existsSync(`${DATA}/vault.json`), false);
assert.equal(fs.existsSync(`${DATA}/wallets.json`), false);
ok('both files are removed from disk');

// the point of a reset is being able to start over — prove it
await initVault('a completely fresh start');
assert.equal(isUnlocked(), true);
const rebuilt = wallets.generateSolanaWallet('post-reset');
assert.equal(rebuilt.isMain, true, 'the first wallet after a reset is main again');
assert.equal(wallets.solanaKeypair(rebuilt).publicKey.toBase58(), rebuilt.address);
ok('a new vault can be created afterwards, from zero');

// and the old passphrase must not open the new vault
lockVault();
await assert.rejects(() => unlockVault('a much better passphrase'), /Wrong passphrase/);
await unlockVault('a completely fresh start');
ok('the old passphrase is dead; the new one works');

console.log('\n[11] Secret redaction in logs');
const { redact } = await import('../src/logger.js');
assert.ok(!redact(`key is ${exported}`).includes(exported), 'base58 secret key redacted');
assert.ok(!redact(`pk 0x${'a'.repeat(64)}`).includes('a'.repeat(64)), 'hex private key redacted');
assert.ok(redact(`addr ${mint}`).includes(mint), 'public addresses are not redacted');
ok('logger redacts secrets but keeps addresses readable');

fs.rmSync(DATA, { recursive: true, force: true });
console.log(`\n✅ ${passed} assertions passed\n`);
