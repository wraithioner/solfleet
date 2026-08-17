import {
  createPublicClient,
  createWalletClient,
  http,
  erc20Abi,
  formatUnits,
  parseUnits,
  isAddress,
  getAddress,
  type PublicClient,
  type Address,
  type PrivateKeyAccount,
} from 'viem';
import { mainnet, base, arbitrum, bsc, polygon, optimism, type Chain as ViemChain } from 'viem/chains';
import { config } from '../config.js';
import { retry } from '../util.js';
import type { EvmChain, TokenBalance } from '../types.js';

/** Multicall3 — same address on every chain we support. */
const MULTICALL3: Address = '0xcA11bde05977b3631167028862bE2a173976CA11';
const MULTICALL3_ABI = [
  {
    name: 'getEthBalance',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'addr', type: 'address' }],
    outputs: [{ name: 'balance', type: 'uint256' }],
  },
] as const;

export interface EvmChainInfo {
  key: EvmChain;
  viem: ViemChain;
  symbol: string;
  name: string;
  explorer: string;
  /** Gas units a plain native transfer costs on this chain. */
  transferGas: bigint;
}

const CHAIN_TABLE: Record<EvmChain, Omit<EvmChainInfo, 'key'>> = {
  ethereum: { viem: mainnet, symbol: 'ETH', name: 'Ethereum', explorer: 'https://etherscan.io', transferGas: 21_000n },
  base: { viem: base, symbol: 'ETH', name: 'Base', explorer: 'https://basescan.org', transferGas: 21_000n },
  arbitrum: { viem: arbitrum, symbol: 'ETH', name: 'Arbitrum', explorer: 'https://arbiscan.io', transferGas: 400_000n },
  bsc: { viem: bsc, symbol: 'BNB', name: 'BNB Chain', explorer: 'https://bscscan.com', transferGas: 21_000n },
  polygon: { viem: polygon, symbol: 'POL', name: 'Polygon', explorer: 'https://polygonscan.com', transferGas: 21_000n },
  optimism: { viem: optimism, symbol: 'ETH', name: 'Optimism', explorer: 'https://optimistic.etherscan.io', transferGas: 21_000n },
};

/** Chains that actually have an RPC configured. */
export function enabledChains(): EvmChainInfo[] {
  return (Object.keys(CHAIN_TABLE) as EvmChain[])
    .filter((k) => Boolean(config.evmRpc[k]))
    .map((k) => ({ key: k, ...CHAIN_TABLE[k]! }));
}

export function chainInfo(key: EvmChain): EvmChainInfo {
  return { key, ...CHAIN_TABLE[key]! };
}

const clients = new Map<EvmChain, PublicClient>();

export function publicClient(key: EvmChain): PublicClient {
  let c = clients.get(key);
  if (!c) {
    const url = config.evmRpc[key];
    if (!url) throw new Error(`No RPC configured for ${key}. Set ${key.toUpperCase()}_RPC_URL in .env.`);
    c = createPublicClient({
      chain: CHAIN_TABLE[key]!.viem,
      transport: http(url, { batch: true, retryCount: 2 }),
    }) as PublicClient;
    clients.set(key, c);
  }
  return c;
}

function walletClient(key: EvmChain, account: PrivateKeyAccount) {
  const url = config.evmRpc[key]!;
  return createWalletClient({ account, chain: CHAIN_TABLE[key]!.viem, transport: http(url) });
}

// ── balances ──────────────────────────────────────────────────────────────────

/** Native balances for many addresses in a single multicall round trip. */
export async function getNativeBalances(key: EvmChain, addresses: string[]): Promise<Map<string, bigint>> {
  const client = publicClient(key);
  const out = new Map<string, bigint>();
  if (addresses.length === 0) return out;

  try {
    const results = await retry(() =>
      client.multicall({
        contracts: addresses.map((a) => ({
          address: MULTICALL3,
          abi: MULTICALL3_ABI,
          functionName: 'getEthBalance' as const,
          args: [getAddress(a)] as const,
        })),
        allowFailure: true,
      }),
    );
    addresses.forEach((a, i) => {
      const r = results[i];
      out.set(getAddress(a), r?.status === 'success' ? (r.result as bigint) : 0n);
    });
    return out;
  } catch {
    // chain without Multicall3, or a provider that rejects batching — fall back
    await Promise.all(
      addresses.map(async (a) => {
        try {
          out.set(getAddress(a), await client.getBalance({ address: getAddress(a) }));
        } catch {
          out.set(getAddress(a), 0n);
        }
      }),
    );
    return out;
  }
}

/** ERC-20 balances for one holder across several tokens. */
export async function getErc20Balances(
  key: EvmChain,
  holder: string,
  tokens: string[],
): Promise<TokenBalance[]> {
  if (tokens.length === 0) return [];
  const client = publicClient(key);
  const owner = getAddress(holder);

  const contracts = tokens.flatMap((t) => {
    const address = getAddress(t);
    return [
      { address, abi: erc20Abi, functionName: 'balanceOf' as const, args: [owner] as const },
      { address, abi: erc20Abi, functionName: 'decimals' as const },
      { address, abi: erc20Abi, functionName: 'symbol' as const },
    ];
  });

  const results = await retry(() => client.multicall({ contracts, allowFailure: true }));

  const out: TokenBalance[] = [];
  tokens.forEach((token, i) => {
    const bal = results[i * 3];
    const dec = results[i * 3 + 1];
    const sym = results[i * 3 + 2];
    if (bal?.status !== 'success' || dec?.status !== 'success') return;

    const rawAmount = bal.result as bigint;
    if (rawAmount === 0n) return;
    const decimals = Number(dec.result);

    out.push({
      mint: getAddress(token),
      symbol: sym?.status === 'success' ? String(sym.result) : '???',
      decimals,
      rawAmount,
      amount: Number(formatUnits(rawAmount, decimals)),
    });
  });

  return out;
}

// ── transfers ─────────────────────────────────────────────────────────────────

async function feePerGas(key: EvmChain): Promise<bigint> {
  const client = publicClient(key);
  try {
    const fees = await client.estimateFeesPerGas();
    return fees.maxFeePerGas ?? fees.gasPrice ?? (await client.getGasPrice());
  } catch {
    return client.getGasPrice();
  }
}

export async function sendNative(
  key: EvmChain,
  account: PrivateKeyAccount,
  to: string,
  amount: number,
): Promise<string> {
  const client = walletClient(key, account);
  const hash = await client.sendTransaction({
    to: getAddress(to),
    value: parseUnits(String(amount), 18),
    chain: CHAIN_TABLE[key]!.viem,
    account,
  });
  await publicClient(key).waitForTransactionReceipt({ hash, timeout: 120_000 });
  return hash;
}

/**
 * Move the whole native balance minus gas. Returns null when the balance does
 * not cover its own transfer, which is common for dust wallets.
 */
export async function sweepNative(
  key: EvmChain,
  account: PrivateKeyAccount,
  to: string,
): Promise<{ hash: string; amount: number } | null> {
  const client = publicClient(key);
  const info = CHAIN_TABLE[key]!;

  const balance = await client.getBalance({ address: account.address });
  const gasPrice = await feePerGas(key);

  // 25% headroom: L2 gas estimates move between quote and inclusion, and a
  // sweep that underestimates simply reverts and wastes the fee
  const gasCost = (info.transferGas * gasPrice * 125n) / 100n;
  if (balance <= gasCost) return null;

  const value = balance - gasCost;
  const wallet = walletClient(key, account);
  const hash = await wallet.sendTransaction({
    to: getAddress(to),
    value,
    chain: info.viem,
    account,
  });

  await client.waitForTransactionReceipt({ hash, timeout: 120_000 });
  return { hash, amount: Number(formatUnits(value, 18)) };
}

export async function sendErc20(
  key: EvmChain,
  account: PrivateKeyAccount,
  token: string,
  to: string,
  rawAmount: bigint,
): Promise<string> {
  const wallet = walletClient(key, account);
  const hash = await wallet.writeContract({
    address: getAddress(token),
    abi: erc20Abi,
    functionName: 'transfer',
    args: [getAddress(to), rawAmount],
    chain: CHAIN_TABLE[key]!.viem,
    account,
  });
  await publicClient(key).waitForTransactionReceipt({ hash, timeout: 120_000 });
  return hash;
}

export function isValidEvmAddress(a: string): boolean {
  return isAddress(a);
}

export function explorerTxUrl(key: EvmChain, hash: string): string {
  return `${CHAIN_TABLE[key]!.explorer}/tx/${hash}`;
}

export { formatUnits, parseUnits, getAddress };
