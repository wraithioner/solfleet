/** Offline regressions: partial reads must not become a full valuation. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Context } from 'grammy';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'solfleet-portfolio-'));
process.env.BOT_TOKEN = '123:TEST';
process.env.OWNER_IDS = '1';
process.env.DATA_DIR = dataDir;
process.env.VAULT_AUTOLOCK_MINUTES = '0';

const { initVaultWithKeyfile, lockVault } = await import('../src/store/vault.js');
const { generateSolanaWallet } = await import('../src/store/wallets.js');
const { db } = await import('../src/store/db.js');
const { rpc, WSOL_MINT } = await import('../src/chains/solana.js');
const { clearPriceCache } = await import('../src/services/prices.js');
const { buildPortfolio } = await import('../src/services/portfolio.js');
const { showPnl, showPortfolio } = await import('../src/bot/handlers/core.js');
const { renderPortfolio } = await import('../src/bot/ui.js');
const { PublicKey } = await import('@solana/web3.js');
const { TOKEN_PROGRAM_ID } = await import('@solana/spl-token');

const connection = rpc();
const originalMultiple = connection.getMultipleAccountsInfo;
const originalTokens = connection.getParsedTokenAccountsByOwner;
const originalFetch = globalThis.fetch;
const mint = PublicKey.unique().toBase58();
let failTokens = false;
let priceTokens = true;
let priceSol = true;
let passed = 0;
function ok(name: string): void {
  passed++;
  console.log(`  ✓ ${name}`);
}

try {
  initVaultWithKeyfile();
  generateSolanaWallet('test wallet', ['one']);
  connection.getMultipleAccountsInfo = async (keys) => keys.map(() => ({
    lamports: 1_000_000_000, owner: PublicKey.default, data: Buffer.alloc(0), executable: false, rentEpoch: 0,
  }));
  connection.getParsedTokenAccountsByOwner = async (_owner, filter) => {
    if (failTokens) throw new Error('offline token read failure');
    const classic = 'programId' in filter && filter.programId.equals(TOKEN_PROGRAM_ID);
    return {
      context: { slot: 1 },
      value: classic ? [{
        pubkey: PublicKey.unique(),
        account: {
          lamports: 0, owner: TOKEN_PROGRAM_ID, executable: false, rentEpoch: 0,
          data: { program: 'spl-token', space: 165, parsed: { info: {
            mint, tokenAmount: { amount: '2000000', decimals: 6, uiAmount: 2 },
          } } },
        },
      }] : [],
    };
  };
  globalThis.fetch = async () => new Response(JSON.stringify({
    ...(priceSol ? { [WSOL_MINT]: { usdPrice: 100 } } : {}),
    ...(priceTokens ? { [mint]: { usdPrice: 5 } } : {}),
  }), { status: 200 });

  const complete = await buildPortfolio();
  assert.deepEqual(complete.errors, []);
  assert.equal(complete.totals.grandTotalUsd, 110);
  ok('complete holdings and prices produce a complete valuation');

  failTokens = true;
  const unreadable = await buildPortfolio();
  assert.match(unreadable.errors.join(' '), /Token balances for test wallet/);
  assert.match(renderPortfolio(unreadable, null), /Known value only/);
  ok('failed token balance reads surface as an incomplete portfolio');

  let rendered = '';
  const ctx = { reply: async (text: string) => { rendered = text; } } as unknown as Context;
  await showPnl(ctx);
  assert.match(rendered, /Could not work out the P&amp;L/);
  assert.equal(db.valueMarks().length, 0);
  ok('failed balance reads cannot turn into P&L losses or history marks');

  failTokens = false;
  priceTokens = false;
  clearPriceCache();
  const unpriced = await buildPortfolio();
  assert.match(unpriced.errors.join(' '), /1 token price unavailable/);
  await showPnl(ctx);
  assert.equal(db.valueMarks().length, 0);
  ok('missing token prices cannot turn into complete history marks');

  priceTokens = true;
  priceSol = false;
  clearPriceCache();
  assert.match((await buildPortfolio()).errors.join(' '), /SOL price unavailable/);
  ok('missing SOL pricing is explicitly incomplete');

  priceSol = true;
  clearPriceCache();
  db.recordBuy(mint, { solSpent: 0.1, tokensBought: 2, fills: 1 });
  db.updateSettings({ activeGroup: 'one' });
  await showPortfolio(ctx);
  assert.doesNotMatch(rendered, /on .* traded/);
  ok('a wallet group is not compared against the entire account cost basis');

  await showPnl(ctx);
  assert.equal(db.valueMarks().length, 1);
  ok('a complete account still records its value');
} finally {
  connection.getMultipleAccountsInfo = originalMultiple;
  connection.getParsedTokenAccountsByOwner = originalTokens;
  globalThis.fetch = originalFetch;
  lockVault();
  fs.rmSync(dataDir, { recursive: true, force: true });
}

console.log(`\n${passed} offline portfolio regressions passed.`);
