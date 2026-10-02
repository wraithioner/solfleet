export interface CopyClaimCounts {
  socket: number;
  poll: number;
}

export interface FeedHealthReview {
  rebuild: boolean;
  warned: boolean;
  claims: CopyClaimCounts;
}

/** Decide recovery from observed delivery, independently of RPC transport. */
export function reviewFeedHealth(claims: CopyClaimCounts, warned: boolean): FeedHealthReview {
  const total = claims.socket + claims.poll;
  if (total < 12) return { rebuild: false, warned, claims: { ...claims } };

  const pollShare = claims.poll / total;
  if (pollShare > 0.6 && !warned) {
    return { rebuild: true, warned: true, claims: { socket: 0, poll: 0 } };
  }

  return {
    rebuild: false,
    warned: pollShare <= 0.3 ? false : warned,
    claims:
      total > 200
        ? { socket: Math.round(claims.socket / 2), poll: Math.round(claims.poll / 2) }
        : { ...claims },
  };
}

/** Evict the oldest item belonging to the busiest address; ties keep arrival order. */
export function queueEvictionIndex(addresses: readonly string[]): number {
  const counts = new Map<string, number>();
  for (const address of addresses) counts.set(address, (counts.get(address) ?? 0) + 1);

  let busiest: string | undefined;
  let largest = 0;
  for (const [address, count] of counts) {
    if (count > largest) {
      busiest = address;
      largest = count;
    }
  }
  return busiest === undefined ? -1 : addresses.indexOf(busiest);
}
