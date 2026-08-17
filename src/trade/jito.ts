import { VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { endpoints } from '../config.js';
import { fetchJson, sleep } from '../util.js';

/**
 * Jito bundle submission. A bundle is an ordered list of up to 5 transactions
 * that a validator either includes together in one block or drops entirely —
 * which is what makes "all wallets buy at the same price" actually true rather
 * than approximately true.
 */

interface JitoRpcResponse<T> {
  jsonrpc: string;
  id: number;
  result?: T;
  error?: { code: number; message: string };
}

export async function sendBundle(transactions: VersionedTransaction[]): Promise<string> {
  if (transactions.length === 0) throw new Error('Nothing to send.');
  if (transactions.length > 5) throw new Error('A Jito bundle holds at most 5 transactions.');

  const encoded = transactions.map((tx) => bs58.encode(tx.serialize()));

  const res = await fetchJson<JitoRpcResponse<string>>(endpoints.jitoBundles, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'sendBundle', params: [encoded] }),
    timeoutMs: 20_000,
  });

  if (res.error) throw new Error(`Jito rejected the bundle: ${res.error.message}`);
  if (!res.result) throw new Error('Jito accepted the request but returned no bundle id.');
  return res.result;
}

export type BundleState = 'Pending' | 'Landed' | 'Failed' | 'Invalid' | 'Unknown';

export async function getBundleStatus(bundleId: string): Promise<BundleState> {
  try {
    const res = await fetchJson<JitoRpcResponse<{ value: Array<{ confirmation_status?: string; err?: unknown }> }>>(
      endpoints.jitoBundles,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getBundleStatuses', params: [[bundleId]] }),
        timeoutMs: 15_000,
      },
    );

    const entry = res.result?.value?.[0];
    if (!entry) return 'Pending';
    if (entry.err) return 'Failed';
    if (entry.confirmation_status === 'confirmed' || entry.confirmation_status === 'finalized') return 'Landed';
    return 'Pending';
  } catch {
    return 'Unknown';
  }
}

/** Poll until the bundle lands or the deadline passes. */
export async function waitForBundle(bundleId: string, timeoutMs = 45_000): Promise<BundleState> {
  const deadline = Date.now() + timeoutMs;
  let last: BundleState = 'Pending';

  while (Date.now() < deadline) {
    last = await getBundleStatus(bundleId);
    if (last === 'Landed' || last === 'Failed' || last === 'Invalid') return last;
    await sleep(2000);
  }

  return last;
}
