/** History reconciliation checks with in-memory RPC responses and no delays. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import bs58 from 'bs58';
import type { ConfirmedSignatureInfo, ParsedTransactionWithMeta } from '@solana/web3.js';
import type { ReconcileServices } from '../src/services/reconcile.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'solfleet-reconcile-regressions-'));
process.env.BOT_TOKEN = '123:OFFLINE_TEST';
process.env.OWNER_IDS = '1';
process.env.DATA_DIR = dataDir;

const { db } = await import('../src/store/db.js');
const { proceedsByMint, rebuildRealised } = await import('../src/services/reconcile.js');
const owner = '11111111111111111111111111111111';
const mint = 'offline-reconciliation-mint';
const sale = {
  transaction: {
    message: {
      accountKeys: [{ pubkey: owner, signer: true }, { pubkey: 'token-account' }],
      instructions: [
        {
          programId: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
          accounts: [owner, 'token-account'],
          data: bs58.encode(createHash('sha256').update('global:sell').digest().subarray(0, 8)),
        },
      ],
    },
  },
  meta: {
    err: null,
    preTokenBalances: [
      {
        accountIndex: 1,
        mint,
        owner,
        uiTokenAmount: { amount: '100', decimals: 0, uiAmount: 100 },
      },
    ],
    postTokenBalances: [
      { accountIndex: 1, mint, owner, uiTokenAmount: { amount: '0', decimals: 0, uiAmount: 0 } },
    ],
    preBalances: [0, 2_039_280],
    postBalances: [100_000_000, 2_039_280],
    innerInstructions: [
      {
        index: 0,
        instructions: [
          {
            programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
            parsed: {
              type: 'transfer',
              info: { source: 'token-account', destination: 'pool-token-account', amount: '100' },
            },
          },
        ],
      },
    ],
  },
} as unknown as ParsedTransactionWithMeta;
const page = (prefix: string, count: number, blockTime = 10_000): ConfirmedSignatureInfo[] =>
  Array.from({ length: count }, (_, i) => ({
    signature: `${prefix}-${i}`,
    slot: 1,
    err: null,
    memo: null,
    blockTime,
    confirmationStatus: 'confirmed',
  }));
const mocks = (
  pages: ConfirmedSignatureInfo[][],
  parse: (signature: string) => ParsedTransactionWithMeta | null = () => sale,
): ReconcileServices => {
  let nextPage = 0;
  return {
    rpc: () => ({
      getSignaturesForAddress: async (_address, options) => {
        assert.equal(options?.limit, 100);
        return pages[nextPage++] ?? [];
      },
      getParsedTransactions: async signatures => signatures.map(parse),
    }),
    // Production still retries and spaces reads; tests execute only their mocks.
    paced: async fn => fn(),
  };
};
let passed = 0;
const check = (name: string) => {
  passed++;
  console.log(`  ✓ ${name}`);
};

try {
  {
    const result = await proceedsByMint(owner, 9_000_000, undefined, mocks([]));
    assert.equal(result.complete, true);
    assert.equal(result.scanned, 0);
    check('an empty history is complete');
  }

  {
    const result = await proceedsByMint(owner, 9_000_000, undefined, mocks([page('full', 100)]));
    assert.equal(result.complete, true);
    assert.equal(result.scanned, 100);
    assert.ok(result.found.get(mint)! > 9.99);
    check('a full page followed by the end of history is complete');
  }

  {
    const pages = Array.from({ length: 12 }, (_, i) => page(`cap-${i}`, 100));
    const result = await proceedsByMint(owner, 9_000_000, undefined, mocks(pages));
    assert.equal(result.scanned, 1200);
    assert.equal(result.complete, false);
    assert.ok(result.found.get(mint)! > 119.99, 'partial proceeds remain available');
    check('reaching the signature budget without the history boundary is incomplete');
  }

  {
    const pages = Array.from({ length: 12 }, (_, i) =>
      page(`boundary-${i}`, 100, i === 11 ? 8_000 : 10_000),
    );
    const result = await proceedsByMint(owner, 9_000_000, undefined, mocks(pages));
    assert.equal(
      result.scanned,
      1100,
      'transactions before the history boundary are excluded individually',
    );
    assert.equal(
      result.complete,
      true,
      'the history boundary was established at the budget boundary',
    );
    check('the signature budget still permits a proven complete history boundary');
  }

  {
    const services = mocks([page('missing', 3)], signature => {
      if (signature.endsWith('-1')) return null;
      if (signature.endsWith('-2')) return { ...sale, meta: null };
      return sale;
    });
    const result = await proceedsByMint(owner, 9_000_000, undefined, services);
    assert.equal(result.complete, false);
    assert.equal(result.scanned, 1);
    assert.equal(result.found.get(mint), 0.1);
    check('null transactions and absent metadata report incomplete while preserving known sales');
  }

  {
    const services = mocks([page('first', 100), page('last', 1)], signature =>
      signature === 'first-0' ? null : sale,
    );
    const result = await proceedsByMint(owner, 9_000_000, undefined, services);
    assert.equal(result.complete, false);
    assert.equal(result.scanned, 100);
    check('an unreadable earlier transaction stays incomplete after later pages finish');
  }

  {
    const services = mocks([page('failed', 1)], () => ({
      ...sale,
      meta: { ...sale.meta!, err: { InstructionError: [0, 'InvalidArgument'] } },
    }));
    const result = await proceedsByMint(owner, 9_000_000, undefined, services);
    assert.equal(result.complete, true, 'a known failed transaction is fully accounted for');
    assert.equal(result.found.size, 0);
    check('known failed transactions do not make a scan incomplete');
  }

  {
    const services = mocks([page('short-response', 2)]);
    services.rpc = () => ({
      ...mocks([page('short-response', 2)]).rpc(),
      getParsedTransactions: async () => [sale],
    });
    const result = await proceedsByMint(owner, 9_000_000, undefined, services);
    assert.equal(result.complete, false);
    assert.equal(result.found.get(mint), 0.1);
    check('a short parse response cannot claim complete coverage');
  }

  {
    db.addWallet({
      id: 'offline-wallet',
      kind: 'solana',
      address: owner,
      label: 'Offline wallet',
      secret: '',
      groups: [],
      isMain: false,
      disabled: false,
      createdAt: 1,
    });
    db.recordBuy(mint, { solSpent: 0.2, fills: 1, tokensBought: 100 });
    const result = await rebuildRealised(
      undefined,
      mocks([page('repair', 2, Math.floor(Date.now() / 1000))], signature =>
        signature.endsWith('-0') ? sale : null,
      ),
    );
    assert.equal(result.complete, false);
    assert.equal(result.walletsRead, 1);
    assert.equal(result.repaired.length, 1);
    assert.equal(db.position(mint)?.realisedSol, 0.1);
    check('partial scans repair measured proceeds and expose incompleteness in the final report');
  }

  console.log(`\n${passed} offline reconciliation regressions passed.`);
} finally {
  fs.rmSync(dataDir, { recursive: true, force: true });
}
