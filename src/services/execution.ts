import { AsyncLocalStorage } from 'node:async_hooks';

/** A cancelled operation has not been authorised to submit another transaction. */
export class ExecutionCancelledError extends Error {
  constructor() {
    super('The account changed while this action was waiting. Start the action again.');
    this.name = 'ExecutionCancelledError';
  }
}

interface ExecutionContext {
  epoch: number;
  owner: { active: boolean };
  guards: ReadonlyArray<() => boolean>;
}

const context = new AsyncLocalStorage<ExecutionContext>();
let epoch = 0;
let maintenance = false;
let tail: Promise<void> = Promise.resolve();

export function executionEpoch(): number {
  return epoch;
}

export function assertExecutionEpoch(expected: number): void {
  if (maintenance || expected !== epoch) throw new ExecutionCancelledError();
}

/** Check immediately before submitting, including after an asynchronous build. */
export function assertExecutionCurrent(): void {
  const current = context.getStore();
  if (current && (!current.owner.active || current.guards.some((guard) => !guard()))) {
    throw new ExecutionCancelledError();
  }
  assertExecutionEpoch(current?.epoch ?? epoch);
}

function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const run = tail.then(fn);
  tail = run.then(() => undefined, () => undefined);
  return run;
}

/**
 * Hold one operation through its before/after measurements and ledger writes.
 *
 * The bot, watcher and copy socket share wallets. Serialising complete operations
 * keeps their balance checks and measurements from consuming each other's funds.
 * A batch still runs its wallets concurrently. Nested engine calls reuse the
 * caller's operation, so callers can protect bookkeeping without taking two locks.
 */
export async function withExecution<T>(fn: () => Promise<T>, authorize?: () => boolean): Promise<T> {
  const current = context.getStore();
  if (current) {
    assertExecutionCurrent();
    if (!authorize) return fn();
    return context.run({ ...current, guards: [...current.guards, authorize] }, async () => {
      assertExecutionCurrent();
      return fn();
    });
  }

  const expected = epoch;
  assertExecutionEpoch(expected);
  return enqueue(async () => {
    assertExecutionEpoch(expected);
    const owner = { active: true };
    return context.run({ epoch: expected, owner, guards: authorize ? [authorize] : [] }, async () => {
      try {
        assertExecutionCurrent();
        return await fn();
      } finally {
        // Detached callbacks cannot retain the completed operation's lock.
        owner.active = false;
      }
    });
  });
}

/**
 * Invalidate queued work and stop further submissions before deleting keys.
 * Active operations finish their result processing before maintenance runs;
 * their submission checks reject any transaction they have not sent yet.
 */
export async function withExecutionMaintenance<T>(fn: () => Promise<T>): Promise<T> {
  if (context.getStore() || maintenance) throw new ExecutionCancelledError();
  maintenance = true;
  epoch++;
  try {
    return await enqueue(fn);
  } finally {
    maintenance = false;
  }
}
