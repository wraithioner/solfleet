import { log } from '../logger.js';
import { errMessage } from '../util.js';

export interface AlertApi {
  sendMessage(owner: number, text: string, options?: { parse_mode: 'HTML' }): Promise<unknown>;
}

/** Deliver watcher alerts even when Telegram refuses their HTML formatting. */
export function createNotifier(
  api: AlertApi,
  owner: number,
  warn: (message: string) => void = log.warn,
): (text: string) => Promise<void> {
  return async text => {
    try {
      await api.sendMessage(owner, text, { parse_mode: 'HTML' });
    } catch (err) {
      const reason = errMessage(err);
      try {
        await api.sendMessage(owner, text.replace(/<[^>]+>/g, ''));
        warn(`Alert sent without formatting — Telegram rejected the markup: ${reason}`);
      } catch (plainErr) {
        warn(`Could not deliver a watcher alert: ${errMessage(plainErr)} (first: ${reason})`);
      }
    }
  };
}
