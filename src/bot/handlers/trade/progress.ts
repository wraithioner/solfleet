import type { Context } from 'grammy';
import { h, progressBarText } from '../../ui.js';
import { render } from '../core.js';

/**
 * Telegram rate limits message edits hard. Batches of 50 wallets would otherwise
 * generate 50 edits and get the bot throttled mid-execution, so progress updates
 * are coalesced to at most one every 1.5 seconds.
 */
export function throttledProgress(ctx: Context, title: string) {
  let last = 0;
  return async (done: number, total: number, note?: string) => {
    const now = Date.now();
    if (now - last < 1500 && done < total) return;
    last = now;

    const text = [
      `<b>${h(title)}</b>`,
      '',
      progressBarText(done, total),
      note ? `<i>${h(note)}</i>` : '',
    ]
      .filter(Boolean)
      .join('\n');

    await render(ctx, text).catch(() => {});
  };
}
