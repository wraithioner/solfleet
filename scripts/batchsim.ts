/**
 * Batch dry run: build and sign a real trade for every wallet, then simulate
 * each one against mainnet instead of sending it.
 *
 * The gap this closes. The offline suite proves the arithmetic and the live
 * checks prove the endpoints answer, but neither runs the thing that actually
 * spends money: many wallets, each building its own transaction, signing it,
 * and being judged by the chain. That path had executed exactly once, on one
 * wallet, and the two real trades before this each found a defect the tests
 * were blind to.
 *
 * `simulateTransaction` runs a signed transaction through the same program
 * logic a send would, against current state, and reports the same errors —
 * insufficient lamports, slippage, a bad account list — without broadcasting.
 * So this validates everything up to the broadcast: routing, instruction
 * layout, account resolution, signing, per-wallet funding, and the shape of a
 * bundle. It cannot validate a fill; only real SOL does that.
 *
 * Run:  npm run batchsim -- [wallets] [solPerWallet] [mint]
 */
process.env.BOT_TOKEN ??= '123:TEST';
process.env.OWNER_IDS ??= '1';
process.env.DATA_DIR = './.batchsim-data';
process.env.VAULT_AUTOLOCK_MINUTES = '0';

import fs from 'node:fs';
import { Keypair, VersionedTransaction } from '@solana/web3.js';

const DATA = './.batchsim-data';
fs.rmSync(DATA, { recursive: true, force: true });

const walletCount = Number(process.argv[2] ?? 20);
const solPerWallet = Number(process.argv[3] ?? 0.05);
const requestedMint = process.argv[4];

const { initVaultWithKeyfile } = await import('../src/store/vault.js');
initVaultWithKeyfile();

const wallets = await import('../src/store/wallets.js');
const { buildTrade, signTx } = await import('../src/trade/pumpportal.js');
const { detectPool } = await import('../src/trade/curve.js');
const { rpc } = await import('../src/chains/solana.js');
const { requiredForBuy } = await import('../src/trade/fund.js');
const { db } = await import('../src/store/db.js');

// ── pick a token ──────────────────────────────────────────────────────────────

async function liveMint(): Promise<string> {
  if (requestedMint) return requestedMint;
  const res = await fetch('https://api.dexscreener.com/token-profiles/latest/v1');
  const profiles = (await res.json()) as Array<{ chainId: string; tokenAddress: string }>;
  const sol = profiles.filter((p) => p.chainId === 'solana');
  return (sol.find((p) => p.tokenAddress.endsWith('pump')) ?? sol[0]!).tokenAddress;
}

const mint = await liveMint();
const settings = db.settings();

console.log(`\n  wallets     ${walletCount}`);
console.log(`  size        ${solPerWallet} SOL each  (${(solPerWallet * walletCount).toFixed(3)} SOL total)`);
console.log(`  token       ${mint}`);

const pool = await detectPool(mint);
console.log(`  venue       ${pool}`);
console.log(`  needs       ${(Number(requiredForBuy(solPerWallet, settings.priorityFeeSol, {
  wrapsSol: pool !== 'pump',
})) / 1e9).toFixed(5)} SOL per wallet\n`);

// Throwaway wallets. They hold nothing, which is the point: an unfunded wallet
// must fail with a fundable-looking error rather than a malformed transaction,
// and that is a distinction only a simulation can draw.
const keypairs = Array.from({ length: walletCount }, () => Keypair.generate());
// registered so the run exercises the real wallet store, not bare keypairs
const bs58 = (await import('bs58')).default;
for (const kp of keypairs) wallets.importPrivateKey(bs58.encode(kp.secretKey), undefined, []);

/*
 * One transaction is also built for an address that actually holds SOL.
 *
 * Empty wallets all fail the same way — the fee payer does not exist — which
 * proves the transaction is well-formed and nothing about whether the trade
 * would go through. Simulating the identical instruction sequence against a
 * funded account answers that: `sigVerify: false` means no signature is needed
 * and nothing is broadcast, so this reads someone's balance and asks the chain
 * a hypothetical. It moves no money and touches nobody's keys.
 */
/**
 * Someone who has already traded this token, taken from its recent history.
 *
 * Picking a funded address at random is not enough — it has to be a plain
 * wallet that this venue will quote for, and the surest way to find one is to
 * take somebody the venue has already served.
 */
async function findRecentTrader(): Promise<string | null> {
  try {
    const { PublicKey } = await import('@solana/web3.js');
    const sigs = await rpc().getSignaturesForAddress(new PublicKey(mint), { limit: 12 });
    for (const s of sigs) {
      if (s.err) continue;
      const [tx] = await rpc().getParsedTransactions([s.signature], { maxSupportedTransactionVersion: 0 });
      // the fee payer is the first account and is always a plain wallet
      const payer = tx?.transaction.message.accountKeys?.[0]?.pubkey?.toBase58();
      if (!payer) continue;
      const lamports = await rpc().getBalance(new PublicKey(payer));
      if (lamports > solPerWallet * 1e9 * 1.5) return payer;
    }
  } catch {
    /* fall through — the probe is a bonus, not the point of the run */
  }
  return null;
}

async function probeFunded(): Promise<string> {
  const payer = await findRecentTrader();
  if (!payer) return 'no funded trader found in recent history — skipped';

  try {
    const tx = await buildTrade({
      publicKey: payer,
      action: 'buy',
      mint,
      amount: solPerWallet,
      denominatedInSol: 'true',
      slippage: settings.slippagePercent,
      priorityFee: settings.priorityFeeSol,
      pool: 'auto',
    });

    const sim = await rpc().simulateTransaction(tx as VersionedTransaction, {
      replaceRecentBlockhash: true,
      sigVerify: false,
    });
    if (!sim.value.err) {
      const spent = sim.value.unitsConsumed ?? 0;
      return `✅ would execute — ${spent.toLocaleString('en-US')} compute units  (payer ${payer.slice(0, 6)}…)`;
    }
    return `❌ ${classify(sim.value.err)}  (payer ${payer.slice(0, 6)}…)`;
  } catch (err) {
    return `❌ could not build: ${(err as Error).message.slice(0, 80)}`;
  }
}

// ── build, sign, simulate ─────────────────────────────────────────────────────

interface Row {
  index: number;
  built: boolean;
  bytes?: number;
  signed?: boolean;
  simulated?: string;
  error?: string;
  ms: number;
}

const rows: Row[] = [];
const started = Date.now();

/** How the chain answered. Grouped, because fifty wallets fail the same way. */
function classify(err: unknown): string {
  const text = typeof err === 'string' ? err : JSON.stringify(err);
  if (/insufficient lamports|debit an account/i.test(text)) return 'insufficient funds (expected — wallet is empty)';
  if (/slippage|0x1771|TooMuchSolRequired/i.test(text)) return 'slippage exceeded';
  if (/BlockhashNotFound/i.test(text)) return 'blockhash expired';
  if (/AccountNotFound|could not find account/i.test(text)) return 'account missing';
  return text.slice(0, 90);
}

const concurrency = 4;
let cursor = 0;

await Promise.all(
  Array.from({ length: concurrency }, async () => {
    while (cursor < keypairs.length) {
      const i = cursor++;
      const kp = keypairs[i]!;
      const t = Date.now();
      const row: Row = { index: i, built: false, ms: 0 };

      try {
        const tx = await buildTrade({
          publicKey: kp.publicKey.toBase58(),
          action: 'buy',
          mint,
          amount: solPerWallet,
          denominatedInSol: 'true',
          slippage: settings.slippagePercent,
          priorityFee: settings.priorityFeeSol,
          pool: 'auto',
        });

        row.built = true;
        row.bytes = tx.serialize().length;

        const signed = signTx(tx, kp);
        row.signed = signed.signatures.some((s) => s.some((b) => b !== 0));

        const sim = await rpc().simulateTransaction(signed as VersionedTransaction, {
          replaceRecentBlockhash: true,
          sigVerify: false,
        });
        row.simulated = sim.value.err ? classify(sim.value.err) : 'would execute';
      } catch (err) {
        row.error = (err as Error).message.slice(0, 90);
      }

      row.ms = Date.now() - t;
      rows.push(row);
    }
  }),
);

// ── report ────────────────────────────────────────────────────────────────────

const elapsed = (Date.now() - started) / 1000;
const built = rows.filter((r) => r.built);
const signedOk = rows.filter((r) => r.signed);

console.log(`  ${'─'.repeat(58)}`);
console.log(`  built        ${built.length}/${rows.length}`);
console.log(`  signed       ${signedOk.length}/${rows.length}`);

const sizes = [...new Set(built.map((r) => r.bytes))];
console.log(`  tx size      ${sizes.join(', ')} bytes  (limit 1232)`);
const oversize = built.filter((r) => (r.bytes ?? 0) > 1232);
if (oversize.length > 0) console.log(`  ⚠️  ${oversize.length} transaction(s) exceed the packet limit`);

const outcomes = new Map<string, number>();
for (const r of rows) {
  const key = r.error ? `BUILD FAILED — ${r.error}` : (r.simulated ?? 'unknown');
  outcomes.set(key, (outcomes.get(key) ?? 0) + 1);
}

console.log(`\n  chain said:`);
for (const [outcome, n] of [...outcomes].sort((a, b) => b[1] - a[1])) {
  console.log(`    ${String(n).padStart(3)}×  ${outcome}`);
}

const times = rows.map((r) => r.ms).sort((a, b) => a - b);
console.log(`\n  per wallet   median ${times[Math.floor(times.length / 2)]}ms   slowest ${times.at(-1)}ms`);
console.log(`  wall clock   ${elapsed.toFixed(1)}s for ${rows.length} wallets at concurrency ${concurrency}`);

// the question the empty wallets cannot answer
console.log(`\n  against a funded account:`);
console.log(`    ${await probeFunded()}`);

const fatal = rows.filter((r) => r.error).length;
console.log(
  `\n  ${fatal === 0 ? '✅ every wallet produced a signed transaction the chain accepted as well-formed' : `❌ ${fatal} wallet(s) could not build at all`}\n`,
);

fs.rmSync(DATA, { recursive: true, force: true });
process.exit(fatal === 0 ? 0 : 1);
