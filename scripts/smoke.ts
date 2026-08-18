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

const {
  initVault,
  initVaultWithKeyfile,
  unlockFromKeyfile,
  removePassphrase,
  unlockAndConvert,
  convertEmptyVaultToKeyfile,
  vaultMode,
  openAtBoot,
  destroyVault,
  vaultExists,
  isUnlocked,
  lockVault,
  unlockVault,
  encryptSecret,
  decryptSecret,
} = await import('../src/store/vault.js');

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

console.log('\n[3] Dropping the passphrase');

/*
 * The migration that matters: a vault made under a passphrase, holding real
 * keys, moved onto a key file. If this loses a single secret the wallets are
 * gone, so it is checked address by address rather than by a success flag.
 */
const beforeAddrs = wallets.allWallets().map((w) => w.address);
assert.equal(vaultMode(), 'passphrase');

removePassphrase(wallets.resealAll);
assert.equal(vaultMode(), 'keyfile', 'the vault is now opened by its key file');
assert.deepEqual(wallets.allWallets().map((w) => w.address), beforeAddrs, 'no wallet lost or changed');
assert.equal(wallets.solanaKeypair(wallets.allWallets()[0]!).publicKey.toBase58(), beforeAddrs[0]);
ok('every key survives being re-sealed without a passphrase');

// the whole point: a restart must not shut anyone out
lockVault();
assert.equal(isUnlocked(), false);
assert.equal(unlockFromKeyfile(), true, 'the key file reopens it with nothing typed');
assert.equal(wallets.solanaKeypair(sol).publicKey.toBase58(), sol.address);
ok('the vault reopens itself after a restart');

// and the old passphrase is genuinely dead, not merely unused
await assert.rejects(() => unlockVault('correct horse battery staple'), /no passphrase/i);
ok('the old passphrase no longer opens anything');

// a key file that does not belong to this vault must be refused, not half-used
const goodKey = fs.readFileSync(`${DATA}/vault.key`, 'utf8');
fs.writeFileSync(`${DATA}/vault.key`, Buffer.alloc(32, 7).toString('base64'));
lockVault();
assert.throws(() => unlockFromKeyfile(), /does not match/);
assert.equal(isUnlocked(), false, 'a wrong key leaves the vault shut rather than open with garbage');
fs.writeFileSync(`${DATA}/vault.key`, goodKey);
assert.equal(unlockFromKeyfile(), true);
ok('a mismatched key file is rejected loudly');

// a missing key file is recoverable from a backup, so say so instead of failing blank
fs.rmSync(`${DATA}/vault.key`);
lockVault();
assert.throws(() => unlockFromKeyfile(), /missing/i);
ok('a missing key file names the file and says to restore it');
fs.writeFileSync(`${DATA}/vault.key`, goodKey);
assert.equal(unlockFromKeyfile(), true);

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

// A stalled endpoint stalls again, and each retry is another full timeout the
// operator waits through before being told anything. One is enough.
let timeoutTries = 0;
await assert.rejects(
  () =>
    util.retry(
      async () => {
        timeoutTries++;
        const e = new Error('Solana RPC did not answer within 12s.');
        e.name = 'TimeoutError';
        throw e;
      },
      { attempts: 4, baseDelayMs: 5 },
    ),
  /did not answer/,
);
assert.equal(timeoutTries, 1, 'a timeout is fatal, not retried');
ok('retry gives up immediately on a timeout');

assert.equal(util.isTimeout(Object.assign(new Error('x'), { name: 'AbortError' })), true);
assert.equal(util.isTimeout(new Error('The operation was aborted due to timeout')), true);
assert.equal(util.isTimeout(new Error('HTTP 429 rate limited')), false, 'a rate limit is worth retrying');
ok('timeouts are told apart from ordinary failures');

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

console.log('\n[9] Copy trading detection');
const { detectTokenMoves } = await import('../src/services/copytrade.js');
const THEM = 'TargetWallet';
const bal = (mint: string, owner: string, amount: number) => ({ mint, owner, uiTokenAmount: { uiAmount: amount } });
const WSOL_M = 'So11111111111111111111111111111111111111112';

// a fresh buy: nothing before, a balance after
const bought = detectTokenMoves([], [bal('MINT_A', THEM, 1000)], THEM);
assert.equal(bought.length, 1);
assert.equal(bought[0]!.delta, 1000, 'a new position reads as a buy');
ok('a first buy is detected with no prior balance');

// a partial exit, with the prior size kept so it can be copied proportionally
const trimmed = detectTokenMoves([bal('MINT_A', THEM, 1000)], [bal('MINT_A', THEM, 250)], THEM);
assert.equal(trimmed[0]!.delta, -750);
assert.equal(trimmed[0]!.before, 1000, 'the prior holding is reported for sizing the copy');
ok('a partial sell reports both the change and the size it came from');

// somebody else's balances in the same transaction must not be mirrored
const others = detectTokenMoves([], [bal('MINT_B', 'SomeoneElse', 5000)], THEM);
assert.equal(others.length, 0, 'only the followed wallet counts');
ok('another wallet trading in the same transaction is ignored');

// wrapped SOL moves on nearly every swap and is not a position
const wsol = detectTokenMoves([], [bal(WSOL_M, THEM, 2), bal('MINT_C', THEM, 10)], THEM);
assert.deepEqual(wsol.map((m) => m.mint), ['MINT_C'], 'WSOL is not treated as a trade');
ok('wrapped SOL is filtered out rather than copied');

// dust must not trigger a real buy
assert.equal(detectTokenMoves([bal('MINT_A', THEM, 1)], [bal('MINT_A', THEM, 1)], THEM).length, 0);
ok('an unchanged balance produces no trade');

// ── how much their trade cost them, which is what proportional sizing scales to
const { solSpent, copyBuySol, copySellPercent } = await import('../src/services/copytrade.js');
const SOL = 1_000_000_000;
const keys = [{ pubkey: 'SomeoneElse' }, { pubkey: THEM }, { pubkey: 'Program' }];

assert.equal(solSpent(keys, [5 * SOL, 10 * SOL, 0], [5 * SOL, 8 * SOL, 0], THEM), 2, 'spent 2 SOL');
assert.equal(solSpent(keys, [0, 8 * SOL, 0], [0, 10 * SOL, 0], THEM), -2, 'a sale reads as negative');
assert.equal(solSpent(keys, [0, 0, 0], [0, 0, 0], 'NotInThisTx'), 0, 'an absent wallet spent nothing');
ok('native SOL movement is read off the transaction');

// ── sizing ────────────────────────────────────────────────────────────────────
const fixedTarget = { sizeMode: 'fixed' as const, buySol: 0.05, sizePercent: 5 };
assert.equal(copyBuySol(fixedTarget, 999, 10, 1), 0.05, 'fixed ignores what they spent');

// "5% of their size" must mean the batch is 5% of their trade, not 5% per wallet
const pctTarget = { sizeMode: 'percent' as const, buySol: 0.05, sizePercent: 5 };
assert.equal(copyBuySol(pctTarget, 10, 10, 1), 0.05, '5% of 10 SOL over 10 wallets is 0.05 each');
assert.equal(copyBuySol(pctTarget, 10, 10, 1) * 10, 0.5, 'the batch totals 5% of their 10 SOL');
assert.equal(copyBuySol(pctTarget, 2, 10, 1), 0.01, 'a smaller entry of theirs is copied smaller');
ok('percent sizing scales the whole batch to their conviction, not each wallet');

// a whale's entry must not blow past the per-wallet safety cap
assert.equal(copyBuySol(pctTarget, 10_000, 1, 0.5), 0.5, 'the per-wallet cap still binds');
assert.equal(copyBuySol(pctTarget, 0, 10, 1), 0, 'a trade that cost them nothing is not copied');
assert.equal(copyBuySol(fixedTarget, 1, 0, 1), 0, 'no wallets means no copy');
ok('sizing is capped and refuses to guess at zero');

// ── exits ─────────────────────────────────────────────────────────────────────
const trim = { mint: 'M', delta: -100, before: 1000 };
assert.equal(copySellPercent('proportional', trim), 10, 'a 10% trim is copied as 10%');
assert.equal(copySellPercent('all', trim), 100, 'full-exit mode reads any sell as the exit');
assert.equal(copySellPercent('off', trim), 0, 'exits can be left to your own rules');
ok('each exit mode does what its label says');

// rounding must never silently turn a real sell into nothing
assert.equal(copySellPercent('proportional', { mint: 'M', delta: -1, before: 100_000 }), 1);
assert.equal(copySellPercent('proportional', { mint: 'M', delta: -5000, before: 1000 }), 100, 'never past a full exit');
assert.equal(copySellPercent('proportional', { mint: 'M', delta: -10, before: 0 }), 100, 'a sell from an unseen bag exits fully');
ok('proportional exits stay between 1% and 100%');

// ── the size prompt takes both forms ──────────────────────────────────────────
const { parseCopySize } = await import('../src/bot/handlers/trade.js');
assert.deepEqual(parseCopySize('0.05'), { mode: 'fixed', value: 0.05 });
assert.deepEqual(parseCopySize(' 5% '), { mode: 'percent', value: 5 });
assert.deepEqual(parseCopySize('0,05'), { mode: 'fixed', value: 0.05 }, 'a decimal comma is accepted');
assert.equal(parseCopySize('101%'), null, 'more than all of their size is refused');
assert.equal(parseCopySize('0'), null);
assert.equal(parseCopySize('-1'), null);
assert.equal(parseCopySize('a lot'), null, 'garbage is refused rather than guessed at');
ok('one prompt tells a SOL amount from a percentage');

console.log('\n[10] Auto-sell rules');
const { ruleTriggered } = await import('../src/services/watcher.js');
const baseRule = { id: 'r', mint: 'M', sellPercent: 100, enabled: true, createdAt: 0 };

const tp = { ...baseRule, kind: 'take_profit' as const, triggerPct: 100 };
assert.equal(ruleTriggered(tp, 2.0, 1.0), true, 'a 2x hits a +100% take profit');
assert.equal(ruleTriggered(tp, 1.9, 1.0), false, 'just short does not fire');
ok('take profit fires at the target and not before');

const sl = { ...baseRule, kind: 'stop_loss' as const, triggerPct: -30 };
assert.equal(ruleTriggered(sl, 0.7, 1.0), true, '-30% hits a -30% stop');
assert.equal(ruleTriggered(sl, 0.75, 1.0), false, '-25% does not');
ok('stop loss fires at the target and not before');

// a trailing stop measures from the peak, not from entry — that is the point
const trail = { ...baseRule, kind: 'trailing_stop' as const, triggerPct: -20, peakPriceSol: 5.0 };
assert.equal(ruleTriggered(trail, 4.0, 1.0), true, '20% off the peak fires');
assert.equal(ruleTriggered(trail, 4.5, 1.0), false, '10% off the peak does not');
assert.equal(ruleTriggered(trail, 4.0, null), true, 'and it works with no entry price at all');
ok('trailing stop measures from the peak, and needs no entry price');

// limit orders anchor to an absolute price fixed when the rule was made
const dip = { ...baseRule, kind: 'limit_buy' as const, triggerPct: -30, triggerPriceSol: 0.7, buySol: 0.05 };
assert.equal(ruleTriggered(dip, 0.7, null), true, 'a limit buy fills at the target');
assert.equal(ruleTriggered(dip, 0.69, null), true, 'and below it');
assert.equal(ruleTriggered(dip, 0.71, null), false, 'but not above it');
ok('a dip buy fills at or below its target price');

const lsell = { ...baseRule, kind: 'limit_sell' as const, triggerPct: 100, triggerPriceSol: 2.0 };
assert.equal(ruleTriggered(lsell, 2.0, null), true, 'a limit sell fills at the target');
assert.equal(ruleTriggered(lsell, 1.99, null), false, 'and not below it');
ok('a limit sell fills at or above its target price');

// a limit order with no price recorded must never fire
assert.equal(ruleTriggered({ ...dip, triggerPriceSol: undefined }, 0.0001, null), false);
ok('a limit order missing its target price stays dormant');

// limit orders need no entry price — they are absolute, not relative
assert.equal(ruleTriggered(dip, 0.5, null), true, 'no entry price is required');
ok('limit orders work without a recorded entry');

// the failure that must never happen: an unreadable price dumping a position
assert.equal(ruleTriggered(tp, 0, 1.0), false, 'a zero price is not a trigger');
assert.equal(ruleTriggered(sl, 0, 1.0), false, 'not even for a stop loss');
ok('a zero or unreadable price never fires a rule');

// without an entry price a TP/SL has nothing to measure against
assert.equal(ruleTriggered(tp, 99, null), false);
assert.equal(ruleTriggered(sl, 0.01, null), false);
ok('take profit and stop loss stay dormant without a recorded entry');

console.log('\n[11] Batch vs slippage');
// The batch competes with itself: each wallet's slippage limit is measured
// against a price the earlier wallets already moved. Ten wallets at 0.5 SOL
// move a fresh curve ~36%, so a 15% tolerance reverts the tail of the batch.
const conflict = curve.simulateSequentialBuys(fresh, 0.5, 10);
assert.ok(conflict.priceMovePct > 15, 'the default 15% slippage is under this batch\'s own impact');
ok(`10 × 0.5 SOL moves ${conflict.priceMovePct.toFixed(1)}% — a 15% slippage setting would revert later wallets`);

const gentle = curve.simulateSequentialBuys(fresh, 0.02, 10);
assert.ok(gentle.priceMovePct < 15, 'a smaller size per wallet stays inside the tolerance');
ok(`10 × 0.02 SOL moves only ${gentle.priceMovePct.toFixed(2)}% — inside the same setting`);

console.log('\n[12] Priority fee bidding');
const { priorityFeeSolFromMicroLamports } = await import('../src/chains/solana.js');
const clampOpts = { floorSol: 0.00005, ceilingSol: 0.005 };

// a busy chain should raise the bid above the configured floor
const busy = priorityFeeSolFromMicroLamports(838_139, clampOpts);
assert.ok(busy > clampOpts.floorSol, 'a congested chain bids above the configured fee');
assert.ok(busy < clampOpts.ceilingSol, 'and still well under the ceiling');
ok(`838k microLamports/CU → ${busy.toFixed(6)} SOL, above the ${clampOpts.floorSol} floor`);

// the configured fee is a floor, never something auto mode undercuts
assert.equal(priorityFeeSolFromMicroLamports(1, clampOpts), clampOpts.floorSol);
ok('a quiet chain never bids below what the operator configured');

// and a spike cannot run away with the balance
assert.equal(priorityFeeSolFromMicroLamports(500_000_000, clampOpts), clampOpts.ceilingSol);
ok('a congestion spike is capped at the ceiling');

// the bid scales with observed cost
assert.ok(
  priorityFeeSolFromMicroLamports(2_000_000, clampOpts) > priorityFeeSolFromMicroLamports(1_000_000, clampOpts),
  'a more expensive market produces a higher bid',
);
ok('the bid tracks the observed market rather than a fixed guess');

console.log('\n[13] Mint authorities');
const { parseMintAccount } = await import('../src/services/mintauth.js');

function mintAccount(opts: { mintAuth?: boolean; freezeAuth?: boolean; decimals?: number }): Buffer {
  const b = Buffer.alloc(82);
  b.writeUInt32LE(opts.mintAuth ? 1 : 0, 0);
  if (opts.mintAuth) Buffer.alloc(32, 7).copy(b, 4);       // some authority pubkey
  b.writeBigUInt64LE(1_000_000n, 36);
  b.writeUInt8(opts.decimals ?? 6, 44);
  b.writeUInt8(1, 45);
  b.writeUInt32LE(opts.freezeAuth ? 1 : 0, 46);
  if (opts.freezeAuth) Buffer.alloc(32, 9).copy(b, 50);
  return b;
}

const safe = parseMintAccount(mintAccount({}))!;
assert.equal(safe.mintAuthority, null);
assert.equal(safe.freezeAuthority, null);
assert.equal(safe.decimals, 6);
ok('a fully revoked mint reads as revoked on both authorities');

const risky = parseMintAccount(mintAccount({ mintAuth: true, freezeAuth: true, decimals: 9 }))!;
assert.ok(risky.mintAuthority, 'an active mint authority is surfaced');
assert.ok(risky.freezeAuthority, 'an active freeze authority is surfaced');
assert.equal(risky.decimals, 9);
ok('active authorities are surfaced with their addresses');

// The trap: when an authority is revoked the 32 bytes after the option flag are
// stale padding. Reading them without checking the flag reports a safe token as
// controlled — or worse, the reverse.
const stale = mintAccount({ mintAuth: true, freezeAuth: true });
stale.writeUInt32LE(0, 0);   // revoke mint, leave the old pubkey bytes in place
stale.writeUInt32LE(0, 46);  // revoke freeze, likewise
const cleared = parseMintAccount(stale)!;
assert.equal(cleared.mintAuthority, null, 'a cleared option means revoked, whatever the bytes say');
assert.equal(cleared.freezeAuthority, null);
ok('a revoked authority is not misread from leftover pubkey bytes');

assert.equal(parseMintAccount(Buffer.alloc(40)), null, 'a truncated account returns null, not a guess');
ok('a truncated mint account returns null rather than a false reading');

console.log('\n[14] Position P&L');
const { positionPnl, formatPnl } = await import('../src/services/pnl.js');
const base = { mint: 'M', investedSol: 0, realisedSol: 0, buyFills: 0, sellFills: 0, firstBuyAt: 0, lastTradeAt: 0 };

// bought 5 SOL, sold nothing, now worth 8
const up = positionPnl({ ...base, investedSol: 5 }, 8);
assert.equal(up.netSol, 3);
assert.equal(up.netPct, 60);
assert.equal(up.inProfitOnRealised, false, 'unrealised gains are not "in profit" yet');
ok(`5 SOL in, worth 8 → ${formatPnl(up)}`);

// bought 5, sold 6, still holding 1 — profit is banked
const banked = positionPnl({ ...base, investedSol: 5, realisedSol: 6 }, 1);
assert.equal(banked.netSol, 2);
assert.equal(banked.inProfitOnRealised, true, 'sells alone have returned more than it cost');
ok(`5 in, 6 back, 1 held → ${formatPnl(banked)} and the cost is already recovered`);

// a position that went to zero must show the full loss, not a divide-by-zero
const rug = positionPnl({ ...base, investedSol: 4 }, 0);
assert.equal(rug.netSol, -4);
assert.equal(rug.netPct, -100);
ok(`a worthless position reads ${formatPnl(rug)}`);

// a token that was never bought through the bot has no cost basis to divide by
const airdrop = positionPnl({ ...base }, 2);
assert.equal(airdrop.netSol, 2);
assert.equal(airdrop.netPct, 0, 'no invested SOL means no percentage, not Infinity');
assert.ok(Number.isFinite(airdrop.netPct));
ok('a position with no cost basis reports no percentage rather than Infinity');

console.log('\n[15] Token card rendering');
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

console.log('\n[16] Factory reset');
const { db } = await import('../src/store/db.js');

assert.equal(vaultExists(), true, 'a vault exists before the reset');
assert.ok(wallets.allWallets().length > 0, 'wallets exist before the reset');
assert.ok(db.mnemonic(), 'a seed phrase is stored before the reset');

destroyVault();
db.wipe();

assert.equal(vaultExists(), false, 'the vault file is gone');
assert.equal(wallets.allWallets().length, 0, 'every wallet is gone');
assert.equal(db.mnemonic(), undefined, 'the stored seed phrase is gone');
assert.equal(isUnlocked(), false, 'nothing is left open');
ok('reset destroys the vault, the wallets and the seed phrase');

// files must be gone from disk, not merely emptied in memory
assert.equal(fs.existsSync(`${DATA}/vault.json`), false);
assert.equal(fs.existsSync(`${DATA}/wallets.json`), false);
assert.equal(fs.existsSync(`${DATA}/vault.key`), false, 'the key file goes too');
ok('every file is removed from disk');

// the point of a reset is being able to start over, with nothing to type
assert.equal(openAtBoot(false), 'created');
assert.equal(isUnlocked(), true, 'the replacement vault is open immediately');
const rebuilt = wallets.generateSolanaWallet('post-reset');
assert.equal(rebuilt.isMain, true, 'the first wallet after a reset is main again');
assert.equal(wallets.solanaKeypair(rebuilt).publicKey.toBase58(), rebuilt.address);
ok('a fresh vault is created and opened with no passphrase');

// a stale key file must never carry over into a new vault
const freshKey = fs.readFileSync(`${DATA}/vault.key`, 'utf8');
assert.notEqual(freshKey, goodKey, 'the new vault gets a new key, not the old one');
ok('a reset does not inherit the previous key');

console.log('\n[17] Legacy wallets from the multi-chain version');

/*
 * This bot used to hold EVM wallets. A vault written back then still carries
 * those records, and the keys in them may still control funds. The rule is
 * simple: this version never signs with one, and never deletes one behind the
 * operator's back.
 */
const legacyRecord = {
  id: 'legacy-1',
  kind: 'evm',
  address: '0x1111111111111111111111111111111111111111',
  label: 'OLD-EVM-01',
  secret: encryptSecret('0x' + 'ab'.repeat(32)),
  groups: [],
  isMain: false,
  disabled: false,
  createdAt: 1,
};

// write it the way the old version would have, then read the file fresh
const onDisk = JSON.parse(fs.readFileSync(`${DATA}/wallets.json`, 'utf8'));
onDisk.wallets.push(legacyRecord);
fs.writeFileSync(`${DATA}/wallets.json`, JSON.stringify(onDisk, null, 2));
db.reload();

assert.equal(db.legacyWallets().length, 1, 'the legacy record survives a load from disk');
assert.equal(wallets.allWallets().some((w) => w.id === 'legacy-1'), false);
ok('legacy records load but are hidden from every Solana code path');

// the regression that mattered: filtering inside load() meant the next flush
// wrote the file back without them, destroying the keys
db.updateSettings({ slippagePercent: 7 });
db.reload();
assert.equal(db.legacyWallets().length, 1, 'an unrelated settings write must not drop it');
ok('a settings change does not eat the legacy keys');

// nor does any wallet mutation, which goes through setWallets()
const doomed = wallets.generateSolanaWallet('to-be-removed');
wallets.removeWallet(doomed.id);
db.reload();
assert.equal(db.legacyWallets().length, 1, 'removing a Solana wallet must not drop it');
ok('wallet edits preserve them too');

// creating a wallet has to actually persist — wallets() hands back a filtered copy
const persisted = wallets.generateSolanaWallet('persisted');
db.reload();
assert.ok(
  wallets.allWallets().some((w) => w.address === persisted.address),
  'a new wallet is on disk, not just in a discarded array',
);
ok('new wallets survive the read-time filter');

// and the operator can get the key back out
const exportedLegacy = wallets.exportLegacyKeys();
assert.equal(exportedLegacy.length, 1);
assert.equal(exportedLegacy[0]!.chain, 'evm');
assert.equal(exportedLegacy[0]!.secret, '0x' + 'ab'.repeat(32), 'the plaintext key comes back intact');
ok('legacy keys export in plaintext for recovery');

// deleting is explicit and complete
assert.equal(wallets.forgetLegacyWallets(), 1);
db.reload();
assert.equal(db.legacyWallets().length, 0, 'and they are gone once asked for');
assert.ok(wallets.allWallets().length > 0, 'the Solana wallets are untouched');
ok('deletion is opt-in and leaves the real wallets alone');

// ── a followed wallet saved before the sizing options existed ─────────────────
const doc = JSON.parse(fs.readFileSync(`${DATA}/wallets.json`, 'utf8'));
doc.copyTargets = [
  { id: 'old-1', address: 'Whale', label: 'Whale', buySol: 0.05, copySells: true, enabled: true, copiedMints: ['MINT_A'], createdAt: 1 },
  { id: 'old-2', address: 'Quiet', label: 'Quiet', buySol: 0.1, copySells: false, enabled: true, copiedMints: [], createdAt: 1 },
];
fs.writeFileSync(`${DATA}/wallets.json`, JSON.stringify(doc, null, 2));
db.reload();

const [whale, quiet] = db.copyTargets();
assert.equal(whale!.sizeMode, 'fixed', 'an old target keeps its fixed size');
assert.equal(whale!.buySol, 0.05, 'and the size itself is untouched');
assert.equal(whale!.entryMode, 'first', 'and still takes only their opening buy');
assert.equal(whale!.exitMode, 'proportional', 'copySells: true becomes proportional exits');
assert.equal(quiet!.exitMode, 'off', 'copySells: false becomes exits off');
ok('targets saved before the options existed keep trading exactly as they did');

console.log('\n[18] Copy trading screens');

/*
 * The sizing arithmetic is covered above as pure functions. This drives the
 * actual handlers through a stub context, because a screen that throws while
 * building its text is indistinguishable, from Telegram, from a dead button.
 */
function stubCtx() {
  const rendered: string[] = [];
  const alerts: string[] = [];
  const ctx = {
    from: { id: 1 },
    callbackQuery: { message: { message_id: 1, chat: { id: 1 } }, data: '' },
    async editMessageText(text: string) { rendered.push(text); return true; },
    async editMessageCaption(opts: { caption: string }) { rendered.push(opts.caption); return true; },
    async reply(text: string) { rendered.push(text); return { chat: { id: 1 }, message_id: 2 }; },
    async answerCallbackQuery(opts?: { text?: string }) { alerts.push(opts?.text ?? ''); return true; },
  };
  return { ctx: ctx as never, rendered, alerts, last: () => rendered[rendered.length - 1] ?? '' };
}

const T = await import('../src/bot/handlers/trade.js');

// start from a clean slate: [17] left two migrated targets behind
for (const t of db.copyTargets()) db.removeCopyTarget(t.id);

const add = stubCtx();
await T.handleCopySize(add.ctx, 'FollowedWhaleAddress', '5%');
const target = db.copyTargets()[0]!;
assert.equal(target.sizeMode, 'percent');
assert.equal(target.sizePercent, 5);
assert.equal(target.entryMode, 'first', 'the safe default is their opening buy only');
assert.equal(target.exitMode, 'proportional');
ok('following a wallet at "5%" stores percent sizing with conservative defaults');

// a bad size must not create a half-configured target
const bad = stubCtx();
await T.handleCopySize(bad.ctx, 'AnotherAddress', 'a lot');
assert.equal(db.copyTargets().length, 1, 'garbage input creates nothing');
assert.match(bad.last(), /SOL amount/, 'and says what it wanted instead');
ok('an unparseable size is refused rather than guessed at');

// the wallet's own screen must render every setting it offers to change
const screen = stubCtx();
await T.showCopyTarget(screen.ctx, target.id);
assert.match(screen.last(), /5% of their size/);
assert.match(screen.last(), /first buy only/);
assert.match(screen.last(), /mirrors the share they sell/);
ok('the wallet screen renders size, entries and exits');

// entries cycle: first → 3 → 5 → 10 → first
const seen: string[] = [];
for (let i = 0; i < 5; i++) {
  const c = stubCtx();
  await T.cycleCopyEntries(c.ctx, target.id);
  const t = db.copyTargets()[0]!;
  seen.push(t.entryMode === 'first' ? 'first' : `every:${t.maxEntries}`);
}
assert.deepEqual(seen, ['every:3', 'every:5', 'every:10', 'first', 'every:3']);
ok('entries cycle through the DCA caps and back to first-buy-only');

// exits cycle: proportional → all → off → proportional
const exits: string[] = [];
for (let i = 0; i < 4; i++) {
  const c = stubCtx();
  await T.cycleCopyExits(c.ctx, target.id);
  exits.push(db.copyTargets()[0]!.exitMode);
}
assert.deepEqual(exits, ['all', 'off', 'proportional', 'all']);
ok('exits cycle through mirror, full exit and off');

// resizing swaps the mode rather than leaving both half-set
const resize = stubCtx();
await T.handleCopyResize(resize.ctx, target.id, '0.08');
assert.equal(db.copyTargets()[0]!.sizeMode, 'fixed');
assert.equal(db.copyTargets()[0]!.buySol, 0.08);
ok('resizing to a SOL amount switches the mode with it');

// and the fixed-size screen renders its own explanation, not the percent one
const fixedScreen = stubCtx();
await T.showCopyTarget(fixedScreen.ctx, target.id);
assert.match(fixedScreen.last(), /0\.08 SOL per wallet/);
assert.doesNotMatch(fixedScreen.last(), /of their size/);
ok('the screen describes whichever sizing is actually in force');

// a target removed in another tab must not throw when its screen is opened
const gone = stubCtx();
await T.showCopyTarget(gone.ctx, 'no-such-target');
assert.match(gone.alerts.join(' '), /no longer followed/);
ok('opening a wallet that was unfollowed says so instead of crashing');

console.log('\n[19] Every button has a route');

/*
 * A button whose callback_data no routeCallback case matches does nothing at
 * all when tapped — no error, no screen, just a spinner that stops. That is
 * indistinguishable from a slow screen, so it survives manual testing easily.
 * Comparing what the keyboards emit against what the router handles catches it
 * the moment a screen is added.
 */
const uiSources = ['src/bot/ui.ts', 'src/bot/handlers/core.ts', 'src/bot/handlers/trade.ts', 'src/bot/handlers/wallets.ts'];
const emitted = new Map<string, string>();

for (const file of uiSources) {
  const src = fs.readFileSync(file, 'utf8');
  const button = /\.text\(\s*(?:'[^']*'|"[^"]*"|`[^`]*`)\s*,\s*(?:'([^']+)'|`([^`]+)`)/g;
  for (const m of src.matchAll(button)) {
    const action = (m[1] ?? m[2] ?? '').split(':')[0] ?? '';
    // a computed action cannot be checked statically
    if (!action || action.includes('${')) continue;
    if (!emitted.has(action)) emitted.set(action, file);
  }
}

const router = fs.readFileSync('src/bot/index.ts', 'utf8');
const routed = new Set([...router.slice(router.indexOf('async function routeCallback')).matchAll(/case '([a-z_0-9]+)'/g)].map((m) => m[1]!));

const orphans = [...emitted].filter(([action]) => !routed.has(action));
assert.deepEqual(orphans, [], `buttons with no route: ${orphans.map(([a, f]) => `${a} (${f})`).join(', ')}`);
assert.ok(emitted.size > 40, `expected the scan to find the keyboards, found ${emitted.size} buttons`);
ok(`all ${emitted.size} button actions reach a handler`);

console.log('\n[20] Secret redaction in logs');
const { redact } = await import('../src/logger.js');
assert.ok(!redact(`key is ${exported}`).includes(exported), 'base58 secret key redacted');
assert.ok(!redact(`pk 0x${'a'.repeat(64)}`).includes('a'.repeat(64)), 'hex private key redacted');
assert.ok(redact(`addr ${mint}`).includes(mint), 'public addresses are not redacted');
ok('logger redacts secrets but keeps addresses readable');

console.log('\n[21] Opening a vault at boot');

/*
 * What happens on an existing deployment the first time it runs this build.
 * Two shapes: a vault that was created and never used, which can be re-keyed
 * with nothing typed, and one holding real keys, which needs the passphrase
 * once because there is no other way to decrypt what is in it.
 */

// an untouched passphrase vault converts silently
destroyVault();
db.wipe();
await initVault('a passphrase nobody will need again');
lockVault();
assert.equal(vaultMode(), 'passphrase');
assert.equal(openAtBoot(false), 'opened', 'an empty vault needs nothing typed');
assert.equal(vaultMode(), 'keyfile');
assert.equal(isUnlocked(), true);
ok('a vault with nothing sealed in it re-keys itself at boot');

// one holding keys must not be silently re-keyed — that would orphan them
destroyVault();
db.wipe();
await initVault('the passphrase that still matters');
const stranded = wallets.generateSolanaWallet('pre-migration');
lockVault();
assert.equal(openAtBoot(true), 'needs-passphrase', 'a vault with keys in it asks once');
assert.equal(isUnlocked(), false, 'and stays shut until it gets one');
assert.equal(vaultMode(), 'passphrase', 'and nothing was changed underneath it');
ok('a vault holding keys is never re-keyed without the passphrase');

// and that one passphrase both opens and converts it
await unlockAndConvert('the passphrase that still matters', wallets.resealAll);
assert.equal(vaultMode(), 'keyfile');
assert.equal(wallets.solanaKeypair(wallets.allWallets()[0]!).publicKey.toBase58(), stranded.address);
lockVault();
assert.equal(openAtBoot(true), 'opened', 'and from then on it opens by itself');
ok('one passphrase converts the vault and is never asked for again');

// a wrong one must change nothing at all
lockVault();
await assert.rejects(() => unlockAndConvert('not it', wallets.resealAll));
assert.equal(convertEmptyVaultToKeyfile(true), false, 'and a populated vault refuses the shortcut');
ok('a failed attempt leaves the vault exactly as it was');

fs.rmSync(DATA, { recursive: true, force: true });
console.log(`\n✅ ${passed} assertions passed\n`);
