import 'dotenv/config';
import path from 'node:path';

function req(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`Missing required env var ${name}. Copy .env.example to .env and fill it in.`);
  return v;
}

function opt(name: string, fallback = ''): string {
  return process.env[name]?.trim() || fallback;
}

function num(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  return raw === 'true' || raw === '1' || raw === 'yes';
}

export type ExecutionMode = 'bundle' | 'parallel';

/** Solana's own endpoint: fine for a health check, unusable for real reads. */
const PUBLIC_RPC = 'https://api.mainnet-beta.solana.com';

export const config = {
  botToken: req('BOT_TOKEN'),

  ownerIds: req('OWNER_IDS')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0),

  solana: {
    rpcUrl: opt('SOLANA_RPC_URL', PUBLIC_RPC),
    sendRpcUrl: opt('SOLANA_SEND_RPC_URL') || opt('SOLANA_RPC_URL', PUBLIC_RPC),
    /**
     * True when no private endpoint was configured.
     *
     * The public endpoint answers `getHealth` in milliseconds and then stalls
     * indefinitely on the account reads every balance screen depends on, so
     * this is worth saying in the interface and not only in the boot log.
     */
    isPublicRpc: !opt('SOLANA_RPC_URL'),
  },


  vault: {
    /**
     * Minutes of inactivity before the key is wiped from memory. Off by
     * default: with no passphrase there is nothing to type to get it back, so
     * locking would just break the bot until it restarts.
     */
    autolockMinutes: num('VAULT_AUTOLOCK_MINUTES', 0),
  },

  trading: {
    slippagePercent: num('DEFAULT_SLIPPAGE_PERCENT', 15),
    priorityFeeSol: num('DEFAULT_PRIORITY_FEE_SOL', 0.00005),
    executionMode: (opt('DEFAULT_EXECUTION_MODE', 'parallel') as ExecutionMode),
    concurrency: Math.max(1, num('EXECUTION_CONCURRENCY', 5)),
    jitoTipSol: num('JITO_TIP_SOL', 0.0001),
  },

  safety: {
    maxBuySolPerWallet: num('MAX_BUY_SOL_PER_WALLET', 5),
    requireConfirmation: bool('REQUIRE_CONFIRMATION', true),
  },

  dataDir: path.resolve(process.cwd(), opt('DATA_DIR', './data')),
} as const;

if (config.ownerIds.length === 0) {
  throw new Error('OWNER_IDS did not contain a valid numeric Telegram user ID.');
}

/** Endpoints for the external services the bot talks to. */
export const endpoints = {
  pumpPortalTradeLocal: 'https://pumpportal.fun/api/trade-local',
  jitoBundles: 'https://mainnet.block-engine.jito.wtf/api/v1/bundles',
  jupiterQuote: 'https://lite-api.jup.ag/swap/v1/quote',
  jupiterSwap: 'https://lite-api.jup.ag/swap/v1/swap',
  jupiterPrice: 'https://lite-api.jup.ag/price/v3',
  dexscreenerTokens: 'https://api.dexscreener.com/latest/dex/tokens',
  /**
   * Every pair for one token on one chain.
   *
   * Chain-scoped because the unscoped lookup mixes in forked chains that reuse
   * the same contract address, which produces wildly wrong prices. Every pair
   * because `tokens/v1` returns only one — measured against this endpoint on
   * the same mints, it answered with a single pool where thirty exist, and the
   * one it picks is the deepest rather than the first. For a graduated pump.fun
   * token the deepest pool is the one created at graduation, so a token that
   * launched five days ago reads as an hour old. Age has to come from the
   * oldest pair, which means seeing all of them.
   */
  dexscreenerPairs: 'https://api.dexscreener.com/token-pairs/v1',
  /**
   * A launch index, used for the three things a single mint cannot tell you:
   * which of its holders are the pool, which are one person behind many
   * wallets, and whether its developer has done this before.
   */
  rugcheck: 'https://api.rugcheck.xyz/v1/tokens',
} as const;

/**
 * DexScreener chain ids searched when someone pastes a non-Solana address.
 * Research only — the bot holds no wallets on these chains.
 */
export const EVM_LOOKUP_CHAINS = [
  'ethereum',
  'base',
  'bsc',
  'arbitrum',
  'polygon',
  'optimism',
  'avalanche',
  'robinhood',
] as const;
