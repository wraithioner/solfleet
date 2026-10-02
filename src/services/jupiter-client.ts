import { config } from '../config.js';

type JupiterRequestInit = RequestInit & { timeoutMs?: number };
interface ClientOptions {
  baseUrl: string;
  apiKey: string;
  requestIntervalMs: number;
}

function aborted(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('Jupiter request aborted.', 'AbortError');
}

/** Enforce the deadline even when a transport or response body ignores abort. */
function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(aborted(signal));
    };
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    if (signal.aborted) {
      void promise.catch(() => {});
      reject(aborted(signal));
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      value => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

/** Separate instances support isolated offline checks; application callers share the instance below. */
export function createJupiterClient(options: ClientOptions) {
  const base = new URL(options.baseUrl);
  if (
    base.protocol !== 'https:' ||
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    base.pathname !== '/'
  ) {
    throw new Error('Jupiter client requires an HTTPS origin.');
  }
  if (
    !Number.isSafeInteger(options.requestIntervalMs) ||
    options.requestIntervalMs < 0 ||
    options.requestIntervalMs > 60_000
  ) {
    throw new Error(
      'Jupiter request interval must be an integer between 0 and 60000 milliseconds.',
    );
  }

  interface PendingRequest {
    signal: AbortSignal;
    start: () => void;
    cancel: () => void;
  }
  const pending: PendingRequest[] = [];
  let nextStartAt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function pump(): void {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (pending.length === 0) return;
    const waitMs = Math.max(0, nextStartAt - performance.now());
    if (waitMs > 0) {
      timer = setTimeout(pump, waitMs);
      return;
    }
    const request = pending.shift()!;
    request.signal.removeEventListener('abort', request.cancel);
    if (request.signal.aborted) {
      request.cancel();
      pump();
      return;
    }
    // Only requests actually dispatched consume a slot. Expired requests are
    // removed from the queue, so they cannot defer a subsequent live request.
    nextStartAt = performance.now() + options.requestIntervalMs;
    request.start();
    if (pending.length > 0) pump();
  }

  function enqueue<T>(signal: AbortSignal, task: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      const request: PendingRequest = {
        signal,
        start: () => {
          void task().then(resolve, reject);
        },
        cancel: () => {
          const index = pending.indexOf(request);
          if (index >= 0) pending.splice(index, 1);
          signal.removeEventListener('abort', request.cancel);
          reject(aborted(signal));
          pump();
        },
      };
      if (signal.aborted) {
        reject(aborted(signal));
        return;
      }
      signal.addEventListener('abort', request.cancel, { once: true });
      pending.push(request);
      pump();
    });
  }

  return async function fetchJupiterJson<T>(
    url: string,
    init: JupiterRequestInit = {},
  ): Promise<T> {
    const target = new URL(url);
    if (
      target.protocol !== 'https:' ||
      target.origin !== base.origin ||
      target.username ||
      target.password
    ) {
      throw new Error('Jupiter requests must use the configured HTTPS origin.');
    }
    const { timeoutMs = 20_000, signal: callerSignal, ...rest } = init;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
      throw new Error('Jupiter request timeout must be a positive integer number of milliseconds.');
    }
    const headers = new Headers(rest.headers);
    // A caller cannot override or accidentally forward a stale API key.
    headers.delete('x-api-key');
    if (options.apiKey) headers.set('x-api-key', options.apiKey);
    const ctrl = new AbortController();
    const onCallerAbort = () => ctrl.abort(callerSignal?.reason);
    if (callerSignal?.aborted) onCallerAbort();
    else callerSignal?.addEventListener('abort', onCallerAbort, { once: true });
    const deadline = setTimeout(
      () =>
        ctrl.abort(
          new DOMException('Jupiter request timed out, including queue wait.', 'TimeoutError'),
        ),
      timeoutMs,
    );
    try {
      return await enqueue(ctrl.signal, async () => {
        // Refuse redirects rather than allowing an authenticated request to
        // forward its key to an unvalidated host.
        const response = await withAbort(
          fetch(target.href, { ...rest, headers, signal: ctrl.signal, redirect: 'error' }),
          ctrl.signal,
        );
        const body = await withAbort(response.text(), ctrl.signal);
        if (!response.ok) {
          const detail = options.apiKey ? body.split(options.apiKey).join('[redacted]') : body;
          throw new Error(`HTTP ${response.status} from ${target.host}: ${detail.slice(0, 300)}`);
        }
        return body ? (JSON.parse(body) as T) : ({} as T);
      });
    } catch (error) {
      // JSON parsing and transport errors may also include an echoed key.
      // Create a clean error so an already-captured stack cannot retain it.
      if (options.apiKey && error instanceof Error && error.message.includes(options.apiKey)) {
        const message = error.message.split(options.apiKey).join('[redacted]');
        const safeError =
          error instanceof SyntaxError ? new SyntaxError(message) : new Error(message);
        safeError.name = error.name;
        throw safeError;
      }
      throw error;
    } finally {
      clearTimeout(deadline);
      callerSignal?.removeEventListener('abort', onCallerAbort);
    }
  };
}

/** Quotes, swaps, prices and token metadata share one gateway rate allowance. */
export const fetchJupiterJson = createJupiterClient(config.jupiter);
