import crypto from 'node:crypto';

/**
 * In-memory conversational state. Single-operator bot, so a plain Map keyed by
 * Telegram user id is enough — and keeping it out of the database means a
 * restart cannot resurrect a half-finished destructive action.
 */

export type PendingInput =
  | { kind: 'unlock' }
  | { kind: 'create_vault' }
  | { kind: 'change_passphrase'; stage: 'current'; }
  | { kind: 'change_passphrase'; stage: 'new'; current: string }
  | { kind: 'import_key' }
  | { kind: 'import_mnemonic' }
  | { kind: 'rename_wallet'; walletId: string }
  | { kind: 'group_wallet'; walletId: string }
  | { kind: 'derive_count'; chainKind: 'solana' | 'evm' }
  | { kind: 'custom_buy'; mint: string }
  | { kind: 'custom_sell'; mint: string }
  | { kind: 'send_to_address'; chainKind: 'solana' | 'evm'; token?: string }
  | { kind: 'set_slippage' }
  | { kind: 'set_priority_fee' }
  | { kind: 'set_jito_tip' }
  | { kind: 'set_reserve' }
  | { kind: 'set_group_filter' }
  | { kind: 'manual_token_lookup' };

export interface SessionState {
  pending?: PendingInput;
  /** Callback id -> action, for two-step confirmation of destructive things. */
  confirmations: Map<string, ConfirmAction>;
  lastTokenMint?: string;
}

export interface ConfirmAction {
  label: string;
  createdAt: number;
  run: () => Promise<void>;
}

const sessions = new Map<number, SessionState>();

export function session(userId: number): SessionState {
  let s = sessions.get(userId);
  if (!s) {
    s = { confirmations: new Map() };
    sessions.set(userId, s);
  }
  return s;
}

export function setPending(userId: number, pending: PendingInput | undefined): void {
  session(userId).pending = pending;
}

export function takePending(userId: number): PendingInput | undefined {
  const s = session(userId);
  const p = s.pending;
  s.pending = undefined;
  return p;
}

/** Register an action behind a confirm button. Expires after five minutes. */
export function stageConfirmation(userId: number, label: string, run: () => Promise<void>): string {
  const s = session(userId);
  const id = crypto.randomBytes(4).toString('hex');

  // drop anything the operator walked away from
  const cutoff = Date.now() - 5 * 60_000;
  for (const [key, action] of s.confirmations) {
    if (action.createdAt < cutoff) s.confirmations.delete(key);
  }

  s.confirmations.set(id, { label, createdAt: Date.now(), run });
  return id;
}

export function takeConfirmation(userId: number, id: string): ConfirmAction | undefined {
  const s = session(userId);
  const action = s.confirmations.get(id);
  if (action) s.confirmations.delete(id);
  return action;
}

/**
 * Telegram caps callback_data at 64 bytes, and a Solana mint alone is 44 of
 * them. Short ids keep the buttons well under the limit no matter how many
 * parameters an action needs.
 */
const tokenIds = new Map<string, string>();
const idsByToken = new Map<string, string>();

export function tokenId(mint: string): string {
  const existing = idsByToken.get(mint);
  if (existing) return existing;

  const id = crypto.randomBytes(4).toString('hex');
  tokenIds.set(id, mint);
  idsByToken.set(mint, id);

  // bound the registry; these are only needed while a card is on screen
  if (tokenIds.size > 500) {
    const oldest = tokenIds.keys().next().value;
    if (oldest) {
      const mintForOldest = tokenIds.get(oldest);
      tokenIds.delete(oldest);
      if (mintForOldest) idsByToken.delete(mintForOldest);
    }
  }

  return id;
}

export function mintFromId(id: string): string | undefined {
  return tokenIds.get(id);
}

/** Same trick for wallet ids, which are UUIDs and far too long for a button. */
const walletIds = new Map<string, string>();
const idsByWallet = new Map<string, string>();

export function shortWalletId(walletId: string): string {
  const existing = idsByWallet.get(walletId);
  if (existing) return existing;
  const id = crypto.randomBytes(3).toString('hex');
  walletIds.set(id, walletId);
  idsByWallet.set(walletId, id);
  return id;
}

export function walletFromShortId(id: string): string | undefined {
  return walletIds.get(id);
}

export function clearSession(userId: number): void {
  sessions.delete(userId);
}
