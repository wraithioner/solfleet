/**
 * The reason behind a failure count.
 *
 * A watcher-fired batch has no screen to open, so a bare "❌ 1" is the whole
 * report — and it says nothing about whether the wallet was short, the token
 * untradeable, or the network down. The first distinct reason is worth more
 * than the count on its own.
 */
export function firstReason(summary: { results: Array<{ ok: boolean; error?: string }> }): string {
  const reasons = [...new Set(summary.results.filter(r => !r.ok && r.error).map(r => r.error!))];
  if (reasons.length === 0) return '';
  const more =
    reasons.length > 1
      ? ` <i>(+${reasons.length - 1} other reason${reasons.length > 2 ? 's' : ''})</i>`
      : '';
  return `\n\n<i>${reasons[0]!.slice(0, 250)}</i>${more}`;
}
