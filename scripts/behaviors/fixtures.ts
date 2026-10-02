import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  Keypair,
  type PublicKey,
  type Commitment,
  type GetProgramAccountsConfig,
  type GetProgramAccountsResponse,
  type RpcResponseAndContext,
} from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import type { Context, InlineKeyboard } from 'grammy';
import type { CopyTarget } from '../../src/store/db.js';
import type { BatchSummary, WalletRecord } from '../../src/types.js';
import type { CopyBuyServices } from '../../src/services/copytrade.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'solfleet-behaviors-'));
Object.assign(process.env, {
  BOT_TOKEN: '123:OFFLINE_TEST',
  OWNER_IDS: '1',
  DATA_DIR: dataDir,
  VAULT_AUTOLOCK_MINUTES: '0',
  JUPITER_REQUEST_INTERVAL_MS: '0',
  SOLANA_RPC_URL: 'http://127.0.0.1:8899',
  SOLANA_SEND_RPC_URL: 'http://127.0.0.1:8899',
});

const { db } = await import('../../src/store/db.js');
const vault = await import('../../src/store/vault.js');
const wallets = await import('../../src/store/wallets.js');
const { rpc, BASE_FEE_LAMPORTS } = await import('../../src/chains/solana.js');
const { fire } = await import('../../src/services/watcher.js');
const { mirrorBuy, mirrorSell, armCopyRules } = await import('../../src/services/copytrade.js');
const { getTokenInfo } = await import('../../src/services/tokeninfo.js');
const { readTokenLocks } = await import('../../src/services/locks.js');
const { createNotifier } = await import('../../src/services/notifications.js');
const { createBot } = await import('../../src/bot/index.js');
const session = await import('../../src/bot/session.js');
const handlers = await import('../../src/bot/handlers/trade.js');
const ui = await import('../../src/bot/ui.js');
const { rebuildPnl } = await import('../../src/bot/handlers/core.js');
const { batchSweepSol } = await import('../../src/trade/engine.js');
const { exitReserveLamports } = await import('../../src/trade/fund.js');
const { reviewFeedHealth, queueEvictionIndex } = await import(
  '../../src/services/copytrade/intake-policy.js'
);
const client = rpc();
const originalFetch = globalThis.fetch;
const originalSetTimeout = globalThis.setTimeout;
const originalNow = Date.now;
let passed = 0;
const check = (name: string) => {
  passed++;
  console.log(`  ✓ ${name}`);
};
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const settle = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};
const wallet: WalletRecord = {
  id: 'offline-wallet',
  kind: 'solana',
  address: Keypair.generate().publicKey.toBase58(),
  label: 'Offline',
  secret: '',
  groups: [],
  isMain: false,
  disabled: false,
  createdAt: 1,
};
const filled = (): BatchSummary => ({
  results: [
    {
      walletId: wallet.id,
      address: wallet.address,
      label: wallet.label,
      ok: true,
      signature: 'confirmed',
    },
  ],
  succeeded: 1,
  failed: 0,
  startedAt: 1,
  finishedAt: 2,
  solSpent: 0.05,
  solReceived: 0.1,
});
const rejected = (): BatchSummary => ({
  results: [
    {
      walletId: wallet.id,
      address: wallet.address,
      label: wallet.label,
      ok: false,
      error: 'definitely rejected',
    },
  ],
  succeeded: 0,
  failed: 1,
  startedAt: 1,
  finishedAt: 2,
});
let sequence = 0;
function target(patch: Partial<CopyTarget> = {}): CopyTarget {
  const value: CopyTarget = {
    id: `target-${++sequence}`,
    address: `trader-${sequence}`,
    label: 'Offline trader',
    buySol: 0.05,
    sizeMode: 'fixed',
    sizePercent: 5,
    entryMode: 'first',
    maxEntries: 1,
    exitMode: 'all',
    copiedMints: [],
    entryCounts: {},
    refusedMints: [],
    enabled: true,
    createdAt: 1,
    ...patch,
  };
  db.addCopyTarget(value);
  return value;
}
const buyServices = (): CopyBuyServices => ({
  selectWallets: () => [wallet],
  getMintDecimals: async () => 6,
  getMintBalances: async () => new Map([[wallet.address, 0n]]),
  screenToken: async () => ({ verdict: { safe: true, reasons: [], notes: [] } }),
  batchPumpTrade: async () => filled(),
  measureTokensGained: async () => 100,
});
function context() {
  const text: string[] = [];
  const keyboards: InlineKeyboard[] = [];
  const ctx = {
    from: { id: 1 },
    reply: async (message: string, options?: { reply_markup?: InlineKeyboard }) => {
      text.push(message);
      if (options?.reply_markup) keyboards.push(options.reply_markup);
      return {};
    },
    answerCallbackQuery: async () => true,
  } as unknown as Context;
  return { ctx, text, keyboards };
}

function programAccountsFixture(
  accounts: GetProgramAccountsResponse,
  onRead = () => {},
): typeof client.getProgramAccounts {
  function read(
    program: PublicKey,
    options: GetProgramAccountsConfig & { withContext: true },
  ): Promise<RpcResponseAndContext<GetProgramAccountsResponse>>;
  function read(
    program: PublicKey,
    options?: Commitment | GetProgramAccountsConfig,
  ): Promise<GetProgramAccountsResponse>;
  async function read(
    _program: PublicKey,
    options?: Commitment | GetProgramAccountsConfig,
  ): Promise<GetProgramAccountsResponse | RpcResponseAndContext<GetProgramAccountsResponse>> {
    onRead();
    return typeof options === 'object' && options.withContext
      ? { context: { slot: 1 }, value: accounts }
      : accounts;
  }
  return read;
}

/** Stub every remote boundary used by token cards, leaving assembly/classification real. */
function mockToken(mint: string): void {
  const mintData = Buffer.alloc(82);
  mintData.writeBigUInt64LE(1000n, 36);
  mintData[44] = 0;
  mintData[45] = 1;
  client.getAccountInfo = async key =>
    key.toBase58() === mint
      ? { owner: TOKEN_PROGRAM_ID, data: mintData, executable: false, lamports: 1, rentEpoch: 0 }
      : null;
  client.getTokenSupply = async () => ({
    context: { slot: 1 },
    value: {
      amount: '1000',
      decimals: 0,
      uiAmount: 1000,
      uiAmountString: '1000',
    },
  });
  client.getTokenLargestAccounts = async () => ({ context: { slot: 1 }, value: [] });
  client.getMultipleAccountsInfo = async keys => keys.map(() => null);
  client.getProgramAccounts = programAccountsFixture([]);
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes('dexscreener'))
      return new Response(
        JSON.stringify([
          {
            chainId: 'solana',
            dexId: 'fixture',
            baseToken: { address: mint, name: 'Fixture', symbol: 'F' },
            priceUsd: '0.01',
            liquidity: { usd: 10_000 },
            volume: { h1: 10_000 },
            pairCreatedAt: Date.now() - 600_000,
          },
        ]),
      );
    if (url.includes('/tokens/v2/search')) return new Response('[]');
    if (init?.method === 'POST')
      return new Response(JSON.stringify({ result: { accounts: [], paginationKey: null } }));
    return new Response('{}');
  };
}

export {
  dataDir,
  db,
  vault,
  wallets,
  BASE_FEE_LAMPORTS,
  fire,
  mirrorBuy,
  mirrorSell,
  armCopyRules,
  getTokenInfo,
  readTokenLocks,
  createNotifier,
  createBot,
  session,
  handlers,
  ui,
  rebuildPnl,
  batchSweepSol,
  exitReserveLamports,
  reviewFeedHealth,
  queueEvictionIndex,
  client,
  originalFetch,
  originalSetTimeout,
  originalNow,
  check,
  deferred,
  settle,
  wallet,
  filled,
  rejected,
  target,
  buyServices,
  context,
  programAccountsFixture,
  mockToken,
};
export const passCount = () => passed;
