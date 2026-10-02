# Reliability review — 2026-10-02

Reviewed transaction submission, funding and sweeps, copy trading, automated
exits and DCA, wallet persistence, Telegram access, sessions, portfolio valuation,
and validation. Baseline: `817fd8f00ef908d6e3590b282e002f5df261b8ae`.

The existing single-operator architecture is reasonable for this workload:
bounded concurrency, mint locks, atomic persistence, and conservative safety
gates are useful foundations. The review found correctness gaps in failure
handling that those safeguards alone did not cover.

## Implemented corrections

| Area | Problem | Result |
| --- | --- | --- |
| Jito | Successful `{ Ok: null }` responses were reported as failures | Confirmed and finalized successful bundles count as fills |
| Submission | A lost response or absent status could lead to rebuilding a spend | Preserve the signed identity and flag unknown outcomes; only a confirmed rejection permits retry |
| Automation | Notification/accounting errors could rearm a filled rule | Confirmed fills stay claimed; uncertain submissions stop automatic replay |
| Exits | Failed balance reads looked like an empty position | Unreadable balances preserve protection for a bounded retry |
| DCA | Updating the store mutated the saved round counter | Restore the original counter for definite zero-fill failures; pause uncertain execution |
| Copy safety | Unknown holdings were treated as no exposure | Refuse the buy when exposure cannot be established |
| Telegram | Owner actions could expose secrets in a group; stale confirmations remained valid | Accept private chats only and enforce expiry when a confirmation is used |
| Session IDs | A random collision could redirect an existing button | Allocate unused IDs without overwriting mappings |
| Wallet addresses | Lowercasing conflated distinct Solana addresses | Match base58 addresses exactly |
| Vault migration | Ciphertext could be rewritten before its new key was saved | Save the verified existing key before atomically changing vault mode |
| Storage recovery | A missing primary could discard the surviving backup | Recover validated backups and refuse fresh vault creation over existing secrets |
| Valuation | Partial reads could become false losses or permanent history marks | Label known value, withhold incomplete P&L, and record only complete valuations |
| Group views | Group holdings were compared with account-wide cost | Keep account P&L on the complete account view |
| History repair | Truncated scans and missing parsed transactions were called complete | Preserve measured proceeds and report an incomplete scan |
| Sweeps and fees | Non-associated token balances were transferred from the wrong account; zero priority still charged a fee | Transfer and close the actual source account; honor zero priority pricing |
| Validation | Network outages determined the normal check result | Run strict typechecking and offline behavioral tests in CI; keep live checks separate |

## Verification

Run `npm run check` for strict typechecking, the existing smoke suite, and the
new offline regressions. The new tests inject RPC/trading failures, exercise real
bot middleware with a fake Telegram API, and inject persistence failures. They
use temporary data and never broadcast transactions.

`npm run check` passed after these changes: strict typechecking, **279 smoke
checks**, **27 transaction**, **15 automation**, **7 portfolio**, **9 history
reconciliation** cases, and the wallet/auth/persistence regression suite.

The live read-only `npm run netcheck` run returned **25 passed, 1 failed**.
The failure was the BONK Rugcheck lookup timing out; other Rugcheck probes
answered. The public RPC also returned holder-query rate limits. This result
does not establish uninterrupted upstream availability or production execution.

## Further improvements

- Persist a transaction journal before submission, then reconcile pending
  signatures after restart. This would let unknown outcomes recover their
  ledger entries automatically; the present fix stops replay and asks the
  operator to check the wallets.
- Separate copy-event receipt from successful transaction parsing. An RPC
  parse failure currently consumes the signature and can miss a copy. A
  durable queue needs distinct received, parsed, and executed states so that
  retrying reads cannot duplicate execution.
- A wallet can hold one mint in several token accounts. A comprehensive sweep
  should process every account and report any remainder.

## Dependency findings

`npm audit --omit=dev` reported **9 findings: 3 high and 6 moderate**, including
inherited package findings. No forced dependency downgrade or major override
was applied. The installed Solana packages still pull the affected dependencies.

| Advisory | Applicability review |
| --- | --- |
| [bigint-buffer](https://github.com/advisories/GHSA-3gc7-fjrx-p6mg) | No patched release is listed. SPL-token uses fixed-width u64 layouts; the reviewed paths did not demonstrate exploitation. It remains a dependency risk, especially where native bindings are installed. |
| [stream-json](https://github.com/advisories/GHSA-528h-pc64-c93x) | Affects streaming filters; the reviewed web3 client path uses JSON.parse rather than those filters. |
| [uuid](https://github.com/advisories/GHSA-w5hq-g745-h8pq) | Affects v3/v5/v6 output buffers; the reviewed Jayson path calls v4 without a buffer. |

These are applicability observations, not a clean security audit. Track upstream
compatible fixes and rerun the audit when changing the Solana dependencies.
