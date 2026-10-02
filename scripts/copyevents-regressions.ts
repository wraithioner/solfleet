/** Offline copy receipt regressions. RPC methods and execution are substituted. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CopyTarget } from '../src/store/db.js';
import type { CopyBuyServices } from '../src/services/copytrade.js';
import type { WalletRecord } from '../src/types.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'solfleet-copyevents-'));
process.env.BOT_TOKEN = '123:OFFLINE_TEST';
process.env.OWNER_IDS = '1';
process.env.DATA_DIR = dataDir;
process.env.SOLANA_RPC_URL = 'http://127.0.0.1:1';
process.env.VAULT_AUTOLOCK_MINUTES = '0';

const { db } = await import('../src/store/db.js');
const { rpc } = await import('../src/chains/solana.js');
const {
  pollCopyTargets,
  syncSubscriptions,
  stopSubscriptions,
  resetProcessed,
  mirrorBuy,
  detectTokenMoves,
} = await import('../src/services/copytrade.js');
const { withExecutionMaintenance, ExecutionCancelledError } = await import(
  '../src/services/execution.js'
);

type LogCallback = (logs: { signature: string; err: null }) => void;
type Signature = { signature: string; err: null | { InstructionError: [number, string] } };
const connection = rpc() as unknown as {
  getSignaturesForAddress(
    address: { toBase58(): string },
    options: { limit: number; before?: string },
  ): Promise<Signature[]>;
  getParsedTransactions(signatures: string[]): Promise<Array<ReturnType<typeof receipt> | null>>;
  onLogs(address: { toBase58(): string }, callback: LogCallback): number;
  removeOnLogsListener(id: number): Promise<void>;
};
const addressA = '11111111111111111111111111111111';
const addressB = 'So11111111111111111111111111111111111111112';
const noopNotify = async (_text: string) => {};
const sig = (signature: string): Signature => ({ signature, err: null });
const callbacks = new Map<string, LogCallback>();
let subscriptionId = 0;
connection.onLogs = (address, callback) => {
  callbacks.set(address.toBase58(), callback);
  return ++subscriptionId;
};
connection.removeOnLogsListener = async () => {};

function receipt(owners: string[] = [], failed = false) {
  return {
    meta: {
      err: failed ? { InstructionError: [0, 'Custom'] } : null,
      preTokenBalances: [],
      postTokenBalances: owners.map((owner, i) => ({
        mint: `offline-mint-${i}`,
        owner,
        uiTokenAmount: { uiAmount: 1 },
      })),
      preBalances: owners.map(() => 100),
      postBalances: owners.map(() => 100),
    },
    transaction: { message: { accountKeys: owners.map(pubkey => ({ pubkey })) } },
  };
}

function target(
  id: string,
  address = addressA,
  lastSignature: string | undefined = 'old',
): CopyTarget {
  const value: CopyTarget = {
    id,
    address,
    label: id,
    buySol: 0.05,
    sizeMode: 'fixed',
    sizePercent: 5,
    entryMode: 'first',
    maxEntries: 1,
    exitMode: 'off',
    copiedMints: [],
    enabled: true,
    createdAt: 1,
    lastSignature,
  };
  db.addCopyTarget(value);
  return value;
}

async function clean(): Promise<void> {
  await stopSubscriptions();
  for (const t of [...db.copyTargets()]) db.removeCopyTarget(t.id);
  callbacks.clear();
  resetProcessed();
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  assert.ok(predicate(), 'offline callback did not settle');
}

let passed = 0;
const check = (name: string) => {
  passed++;
  console.log(`  ✓ ${name}`);
};

try {
  {
    const balance = (amount: string, uiAmount: number | null) => ({
      mint: 'raw-mint',
      owner: addressA,
      uiTokenAmount: { amount, decimals: 6, uiAmount },
    });
    assert.deepEqual(
      detectTokenMoves([balance('1000000', null)], [balance('2500000', null)], addressA),
      [{ mint: 'raw-mint', delta: 1.5, before: 1 }],
    );
    assert.deepEqual(
      detectTokenMoves([balance('1000000', 1)], [balance('1000000', 50)], addressA),
      [],
    );
    assert.deepEqual(
      detectTokenMoves([balance('unreadable', null)], [balance('1000000', 1)], addressA),
      [],
    );
    check('raw token amounts survive null UI values and display scaling cannot fabricate a move');
  }

  {
    const value = target('null-receipt');
    connection.getSignaturesForAddress = async () => [sig('new'), sig('old')];
    let reads = 0;
    connection.getParsedTransactions = async () => {
      reads++;
      return [null];
    };
    await pollCopyTargets(noopNotify);
    assert.equal(reads, 2);
    assert.equal(value.lastSignature, 'old');
    assert.equal(value.handledSignatures, undefined);
    connection.getParsedTransactions = async () => {
      reads++;
      return [receipt()];
    };
    await pollCopyTargets(noopNotify);
    assert.equal(reads, 3);
    assert.equal(value.lastSignature, 'new');
    assert.deepEqual(value.handledSignatures, ['new']);
    check('null receipts remain unclaimed and reconcile after RPC recovery');
    await clean();
  }

  {
    const value = target('throw-receipt');
    connection.getSignaturesForAddress = async () => [sig('newest'), sig('middle'), sig('old')];
    const readOrder: string[] = [];
    connection.getParsedTransactions = async ([signature]) => {
      readOrder.push(signature!);
      if (signature === 'middle') throw new Error('Offline RPC unavailable');
      return [receipt()];
    };
    await pollCopyTargets(noopNotify);
    assert.equal(value.lastSignature, 'old');
    assert.deepEqual(readOrder, ['middle', 'middle']);
    connection.getParsedTransactions = async ([signature]) => {
      readOrder.push(signature!);
      return [receipt()];
    };
    await pollCopyTargets(noopNotify);
    assert.deepEqual(readOrder.slice(2), ['middle', 'newest']);
    assert.equal(value.lastSignature, 'newest');
    check('an unreadable oldest receipt blocks the cursor and newer backlog');
    await clean();
  }

  {
    const value = target('partial-cursor');
    connection.getSignaturesForAddress = async () => [
      sig('newest'),
      sig('middle'),
      sig('first'),
      sig('old'),
    ];
    connection.getParsedTransactions = async ([signature]) => [
      signature === 'middle' ? null : receipt(),
    ];
    await pollCopyTargets(noopNotify);
    assert.equal(value.lastSignature, 'first');
    assert.deepEqual(value.handledSignatures, ['first']);
    check('a successful earlier receipt advances the cursor only to that receipt');
    await clean();
  }

  {
    target('shared-a', addressA);
    target('shared-b', addressB);
    connection.getSignaturesForAddress = async () => [sig('shared'), sig('old')];
    let reads = 0;
    connection.getParsedTransactions = async () => {
      reads++;
      return [receipt([addressA, addressB])];
    };
    const before = db.copyDecisions(100).length;
    await pollCopyTargets(noopNotify);
    assert.equal(reads, 2);
    assert.equal(db.copyDecisions(100).length, before + 2);
    assert.ok(db.copyTargets().every(t => t.handledSignatures?.includes('shared')));
    check('one atomic signature is interpreted separately for every followed target');
    await clean();
  }

  {
    const value = target('socket-restart');
    let reads = 0;
    connection.getParsedTransactions = async () => {
      reads++;
      return [receipt()];
    };
    connection.getSignaturesForAddress = async () => [sig('socket-event'), sig('old')];
    await syncSubscriptions(noopNotify);
    callbacks.get(addressA)!({ signature: 'socket-event', err: null });
    await waitFor(() => !!value.handledSignatures?.includes('socket-event'));
    assert.equal(value.lastSignature, 'old');
    const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'wallets.json'), 'utf8'));
    assert.deepEqual(saved.copyTargets[0].handledSignatures, ['socket-event']);
    resetProcessed();
    await pollCopyTargets(noopNotify);
    assert.equal(reads, 1);
    assert.equal(value.lastSignature, 'socket-event');
    check('socket receipts are durable and a fresh process does not replay them');
    await clean();
  }

  {
    const value = target('overlap');
    let release!: (value: ReturnType<typeof receipt>) => void;
    const pending = new Promise<ReturnType<typeof receipt>>(resolve => {
      release = resolve;
    });
    let reads = 0;
    connection.getParsedTransactions = async () => {
      reads++;
      return [await pending];
    };
    connection.getSignaturesForAddress = async () => [sig('overlap-event'), sig('old')];
    await syncSubscriptions(noopNotify);
    callbacks.get(addressA)!({ signature: 'overlap-event', err: null });
    await waitFor(() => reads === 1);
    const poll = pollCopyTargets(noopNotify);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(value.lastSignature, 'old');
    release(receipt());
    await poll;
    assert.equal(reads, 1);
    assert.equal(value.lastSignature, 'overlap-event');
    check('socket and poll share a pending read and commit one receipt');
    await clean();
  }

  {
    const value = target('pagination');
    const signatures = Array.from({ length: 105 }, (_, i) => sig(`page-${104 - i}`));
    const pageRequests: Array<string | undefined> = [];
    connection.getSignaturesForAddress = async (_address, options) => {
      pageRequests.push(options.before);
      if (!options.before) return signatures.slice(0, options.limit);
      return [...signatures.slice(100), sig('old')];
    };
    const readOrder: string[] = [];
    connection.getParsedTransactions = async ([signature]) => {
      readOrder.push(signature!);
      return [receipt()];
    };
    await pollCopyTargets(noopNotify);
    assert.deepEqual(pageRequests, [undefined, 'page-5']);
    assert.equal(readOrder.length, 105);
    assert.equal(readOrder[0], 'page-0');
    assert.equal(readOrder.at(-1), 'page-104');
    assert.equal(value.lastSignature, 'page-104');
    check('reconciliation paginates beyond ten signatures and follows oldest first');
    await clean();
  }

  {
    const value = target('bounded-gap');
    let pages = 0;
    connection.getSignaturesForAddress = async (_address, options) => {
      pages++;
      return Array.from({ length: options.limit }, (_, i) => sig(`gap-${pages}-${i}`));
    };
    let reads = 0;
    connection.getParsedTransactions = async () => {
      reads++;
      return [receipt()];
    };
    const notices: string[] = [];
    await pollCopyTargets(async text => {
      notices.push(text);
    });
    assert.equal(pages, 5);
    assert.equal(reads, 0);
    assert.equal(value.enabled, false);
    assert.equal(value.lastSignature, 'old');
    assert.ok(notices.some(text => text.includes('gap in the history')));
    check('an unknown history gap pauses the target without replaying a partial backlog');
    await clean();
  }

  {
    const value = target('failed-onchain');
    connection.getSignaturesForAddress = async () => [
      { signature: 'listed-failure', err: { InstructionError: [0, 'Custom'] } },
      sig('parsed-failure'),
      sig('old'),
    ];
    let reads = 0;
    connection.getParsedTransactions = async () => {
      reads++;
      return [receipt([addressA], true)];
    };
    const decisions = db.copyDecisions(100).length;
    await pollCopyTargets(noopNotify);
    assert.equal(reads, 1);
    assert.equal(value.lastSignature, 'listed-failure');
    assert.equal(db.copyDecisions(100).length, decisions);
    assert.deepEqual(value.handledSignatures, ['parsed-failure', 'listed-failure']);
    check('failed transactions advance checkpoints without triggering token moves');
    await clean();
  }

  const wallet: WalletRecord = {
    id: 'offline-wallet',
    kind: 'solana',
    address: 'offline-address',
    label: 'Offline wallet',
    secret: '',
    groups: [],
    isMain: false,
    disabled: false,
    createdAt: 1,
  };
  for (const cancellation of ['disable', 'remove'] as const) {
    const value = target(`cancel-${cancellation}`);
    let release!: (value: Awaited<ReturnType<CopyBuyServices['screenToken']>>) => void;
    const screen = new Promise<Awaited<ReturnType<CopyBuyServices['screenToken']>>>(resolve => {
      release = resolve;
    });
    let trades = 0;
    const services: CopyBuyServices = {
      selectWallets: () => [wallet],
      getMintBalances: async () => new Map(),
      screenToken: () => screen,
      batchPumpTrade: async () => {
        trades++;
        return { results: [], succeeded: 0, failed: 0, startedAt: 1, finishedAt: 2 };
      },
      measureTokensGained: async () => 0,
    };
    const work = mirrorBuy(
      value,
      { mint: 'cancel-mint', delta: 1, before: 0 },
      1,
      noopNotify,
      services,
    );
    const rejected = assert.rejects(work, ExecutionCancelledError);
    await waitFor(() => !!value.entryCounts?.['cancel-mint']);
    if (cancellation === 'disable') db.updateCopyTarget(value.id, { enabled: false });
    else db.removeCopyTarget(value.id);
    release({ verdict: { safe: true, reasons: [], notes: [] } });
    await rejected;
    assert.equal(trades, 0);
    check(`${cancellation} while screening prevents a copied buy submission`);
    await clean();
  }

  {
    const value = target('reset-pending-read');
    let release!: (value: ReturnType<typeof receipt>) => void;
    const pending = new Promise<ReturnType<typeof receipt>>(resolve => {
      release = resolve;
    });
    let reads = 0;
    connection.getSignaturesForAddress = async () => [sig('pre-reset'), sig('old')];
    connection.getParsedTransactions = async () => {
      reads++;
      return [await pending];
    };
    const work = pollCopyTargets(noopNotify);
    await waitFor(() => reads === 1);
    await withExecutionMaintenance(async () => {});
    release(receipt());
    await work;
    assert.equal(value.lastSignature, 'old');
    assert.equal(value.handledSignatures, undefined);
    check('maintenance invalidates a pending receipt before it can commit or spend');
    await clean();
  }

  {
    const value = target('flood');
    let release!: (value: ReturnType<typeof receipt>) => void;
    const pending = new Promise<ReturnType<typeof receipt>>(resolve => {
      release = resolve;
    });
    let reads = 0;
    connection.getParsedTransactions = async () => {
      reads++;
      return [await pending];
    };
    await syncSubscriptions(noopNotify);
    const callback = callbacks.get(addressA)!;
    callback({ signature: 'active-flood', err: null });
    await waitFor(() => reads === 1);
    for (let i = 0; i < 85; i++) callback({ signature: `queued-flood-${i}`, err: null });
    assert.equal(value.enabled, false);
    const subscriptionsBefore = subscriptionId;
    await syncSubscriptions(noopNotify);
    assert.equal(subscriptionId, subscriptionsBefore);
    release(receipt());
    await new Promise<void>(resolve => setImmediate(resolve));
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(reads, 1, 'the disabled target backlog must be removed');
    assert.equal(value.handledSignatures, undefined);
    check('flood protection persists disablement and drops the target backlog');
    await clean();
  }

  console.log(`\nCopy event regressions: ${passed} passed.`);
} finally {
  await stopSubscriptions();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
