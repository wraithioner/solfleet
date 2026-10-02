import crypto from 'node:crypto';

/** IDs for automatic exits and schedules, independent of the watcher runtime. */
export function newRuleId(): string {
  return crypto.randomBytes(4).toString('hex');
}
