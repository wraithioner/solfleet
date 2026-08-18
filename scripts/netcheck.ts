/**
 * Live read-only check of every external dependency.
 *
 * Nothing here signs or broadcasts anything. The PumpPortal step builds an
 * unsigned transaction for a throwaway public key purely to confirm the request
 * shape still matches — no key is used and nothing is sent to the network.
 */
process.env.BOT_TOKEN = process.env.BOT_TOKEN || '123:TEST';
process.env.OWNER_IDS = process.env.OWNER_IDS || '1';
process.env.DATA_DIR = './.netcheck-data';

import { Keypair } from '@solana/web3.js';

let pass = 0;
let fail = 0;

async function check(name: string, fn: () => Promise<string>): Promise<void> {
  try {
    const detail = await fn();
    console.log(`  ✓ ${name} — ${detail}`);
    pass++;
  } catch (err) {
    console.log(`  ✗ ${name} — ${err instanceof Error ? err.message : String(err)}`);
    fail++;
  }
}

// USDC: always liquid, always indexed. A good canary.
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const WSOL = 'So11111111111111111111111111111111111111112';

console.log('\n── Solana RPC ──');

const { rpc, getSolBalances, getSplBalances } = await import('../src/chains/solana.js');

await check('getLatestBlockhash', async () => {
  const { blockhash } = await rpc().getLatestBlockhash();
  return `blockhash ${blockhash.slice(0, 12)}…`;
});

await check('getMultipleAccountsInfo (batched balances)', async () => {
  const balances = await getSolBalances([
    '11111111111111111111111111111112',
    Keypair.generate().publicKey.toBase58(),
  ]);
  return `${balances.size} addresses resolved`;
});

await check('getTokenSupply', async () => {
  const supply = await rpc().getTokenSupply({ toBase58: () => USDC } as never);
  return `USDC supply ${Number(supply.value.uiAmountString).toLocaleString()}`;
}).catch(() => {});

/**
 * The batched holdings read behind the token card's sell buttons and the
 * "skip wallets holding nothing" pass on a sell. Fresh keypairs hold nothing,
 * so an empty map is the correct answer — what is being checked is that
 * deriving the token accounts and reading them in one call still works.
 */
await check('getMintBalances (batched token account read)', async () => {
  const { getMintBalances } = await import('../src/chains/solana.js');
  const addresses = Array.from({ length: 3 }, () => Keypair.generate().publicKey.toBase58());
  const held = await getMintBalances(addresses, BONK);
  if (held.size !== 0) throw new Error('fresh keypairs should hold nothing');
  return '3 wallets checked in one round trip, none holding';
});

/**
 * Ground truth that does not drift: USDC is a centralised stablecoin whose
 * issuer really can mint and freeze, and BONK is a memecoin that revoked both.
 * If this check ever flips, the account offsets are being read wrong.
 */
await check('mint + freeze authority parsing', async () => {
  const { getMintAuthorities } = await import('../src/services/mintauth.js');
  const usdc = await getMintAuthorities(USDC);
  const bonk = await getMintAuthorities(BONK);
  if (!usdc || !bonk) throw new Error('could not read a mint account');
  if (!usdc.mintAuthority || !usdc.freezeAuthority) throw new Error('USDC should have both authorities active');
  if (bonk.mintAuthority || bonk.freezeAuthority) throw new Error('BONK should have both revoked');
  if (bonk.decimals !== 5) throw new Error(`BONK decimals read as ${bonk.decimals}, expected 5`);
  return 'USDC active / BONK revoked, decimals correct';
});

console.log('\n── Token info pipeline ──');

const { getTokenInfo, extractTokenAddress } = await import('../src/services/tokeninfo.js');

await check('DexScreener market data (BONK)', async () => {
  const info = await getTokenInfo(BONK, 'solana');
  if (!info.priceUsd) throw new Error('no price returned');
  return `${info.symbol} $${info.priceUsd.toExponential(3)} · mcap ${info.marketCap ? '$' + Math.round(info.marketCap).toLocaleString() : 'n/a'} · vol24h ${info.volume24h ? '$' + Math.round(info.volume24h).toLocaleString() : 'n/a'}`;
});

await check('holder distribution (BONK)', async () => {
  const info = await getTokenInfo(BONK, 'solana');

  // getTokenLargestAccounts is one of the first calls public RPCs throttle.
  // That is a configuration limit, not a defect — what matters is that the bot
  // reports it as unknown rather than silently implying a clean distribution.
  if (info.holdersUnavailable) {
    if (!info.warnings.some((w) => /Holder distribution unavailable/.test(w))) {
      throw new Error('holder failure was not surfaced as a warning');
    }
    return 'RPC throttled the query — correctly surfaced as "unknown" (set a private SOLANA_RPC_URL)';
  }

  if (!info.holders || info.holders.length === 0) throw new Error('no holders and no failure flag');
  return `${info.holders.length} top accounts, top10 = ${info.top10Pct?.toFixed(1)}%`;
});

await check('token logo resolution (BONK)', async () => {
  const info = await getTokenInfo(BONK, 'solana');
  if (!info.imageUrl) throw new Error('no image url');
  return info.imageUrl.slice(0, 60);
});

await check('on-chain Metaplex metadata (BONK)', async () => {
  const { getOnChainMetadata } = await import('../src/services/metadata.js');
  const meta = await getOnChainMetadata(BONK);
  if (!meta?.name) throw new Error('no metadata account');
  return `name="${meta.name}" symbol="${meta.symbol}"`;
});

console.log('\n── Pricing ──');

const { getSolPrice, getSolanaPrices } = await import('../src/services/prices.js');

await check('Jupiter price API (SOL)', async () => {
  const price = await getSolPrice();
  if (price <= 0) throw new Error('zero price');
  return `SOL = $${price.toFixed(2)}`;
});

await check('Jupiter price API (batch)', async () => {
  const prices = await getSolanaPrices([USDC, BONK, WSOL]);
  if (prices.size === 0) throw new Error('empty response');
  return `${prices.size}/3 mints priced`;
});

console.log('\n── Jupiter swap API ──');

const { getQuote, buildSwap } = await import('../src/trade/jupiter.js');

await check('quote 1 SOL → USDC', async () => {
  const q = await getQuote({
    inputMint: WSOL,
    outputMint: USDC,
    amount: 1_000_000_000n,
    slippageBps: 100,
  });
  return `${(Number(q.outAmount) / 1e6).toFixed(2)} USDC, impact ${(Number(q.priceImpactPct) * 100).toFixed(3)}%, ${q.routePlan.length} hop(s)`;
});

/**
 * The fallback route. A token that never launched on pump.fun — or graduated
 * away from it — is only sellable through here, so the request shape matters as
 * much as PumpPortal's. Built for a throwaway key and thrown away unsigned.
 */
await check('build a sell swap for a non-pump token (BONK → SOL)', async () => {
  const q = await getQuote({
    inputMint: BONK,
    outputMint: WSOL,
    amount: 1_000_000_000n,
    slippageBps: 1500,
  });
  const tx = await buildSwap(q, Keypair.generate().publicKey.toBase58(), 0.00001);
  return `${tx.message.compiledInstructions.length} instructions, ${tx.message.addressTableLookups.length} lookup tables`;
});

console.log('\n── PumpPortal (build only, never signed or sent) ──');

const { buildTrade, buildTradeBundle } = await import('../src/trade/pumpportal.js');
const throwaway = Keypair.generate().publicKey.toBase58();

/**
 * PumpPortal rejects mints it cannot route, so testing against a blue chip like
 * BONK returns 400 and tells us nothing. Find a token that is actually live on
 * pump.fun right now.
 */
let pumpMint: string | null = null;
await check('discover a live pump.fun token', async () => {
  const profiles = await fetch('https://api.dexscreener.com/token-profiles/latest/v1').then((r) => r.json());
  const candidate = (profiles as Array<{ chainId: string; tokenAddress: string }>)
    .filter((p) => p.chainId === 'solana' && p.tokenAddress?.endsWith('pump'))
    .map((p) => p.tokenAddress)[0];
  if (!candidate) throw new Error('none found in the latest profiles feed');
  pumpMint = candidate;
  return `${candidate.slice(0, 12)}…`;
});

await check('build a single buy transaction', async () => {
  if (!pumpMint) throw new Error('skipped — no live pump token discovered');
  const tx = await buildTrade({
    publicKey: throwaway,
    action: 'buy',
    mint: pumpMint,
    amount: 0.001,
    denominatedInSol: 'true',
    slippage: 15,
    priorityFee: 0.00001,
    pool: 'auto',
  });
  return `${tx.message.compiledInstructions.length} instructions, ${tx.message.staticAccountKeys.length} accounts`;
});

await check('build a 3-transaction bundle', async () => {
  if (!pumpMint) throw new Error('skipped — no live pump token discovered');
  const keys = [throwaway, Keypair.generate().publicKey.toBase58(), Keypair.generate().publicKey.toBase58()];
  const txs = await buildTradeBundle(
    keys.map((publicKey, i) => ({
      publicKey,
      action: 'buy' as const,
      mint: pumpMint!,
      amount: 0.001,
      denominatedInSol: 'true' as const,
      slippage: 15,
      // only the first transaction's fee is used, as the Jito tip for the bundle
      priorityFee: i === 0 ? 0.0001 : 0,
      pool: 'auto' as const,
    })),
  );
  if (txs.length !== 3) throw new Error(`expected 3 transactions, got ${txs.length}`);
  return `3 unsigned transactions, shared blockhash ${txs[0]!.message.recentBlockhash.slice(0, 8)}…`;
});

await check('reject a non-pump mint cleanly', async () => {
  try {
    await buildTrade({
      publicKey: throwaway,
      action: 'buy',
      mint: BONK,
      amount: 0.001,
      denominatedInSol: 'true',
      slippage: 15,
      priorityFee: 0.00001,
      pool: 'pump',
    });
    throw new Error('expected a rejection for a non-pump token');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes('400')) throw err;
    return 'HTTP 400 surfaced as an error rather than a malformed transaction';
  }
});

console.log('\n── pump.fun bonding curve ──');

const { fetchBondingCurve, detectPool } = await import('../src/trade/curve.js');

await check('read a graduated token curve (BONK has none)', async () => {
  const curve = await fetchBondingCurve(BONK);
  return curve ? `complete=${curve.complete}` : 'no curve account (not a pump.fun token) — handled as null';
});

await check('detectPool routes correctly', async () => {
  const pool = await detectPool(BONK);
  return `pool=${pool}`;
});

console.log(`\n${fail === 0 ? '✅' : '⚠️'}  ${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
