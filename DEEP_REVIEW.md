# Deeper review — 2026-10-02

Repository: `wraithioner/solfleet`. Baseline: `817fd8f`; this extends the
first reliability pass in PR #3. Findings were reproduced with injected RPC,
transaction-builder, persistence and lifecycle events. No funds were moved.

## Verified failures and corrections

| Area | Reproduced failure | Implemented result |
| --- | --- | --- |
| Builder authorization | An unrelated 10 SOL transfer, foreign payer, appended transfer or excessive compute fee could be signed | Require the wallet as sole signer and payer, recheck before signing, clear supplied signatures, constrain compute/tip budgets and direct SOL/token setup, refuse unknown top-level programs |
| Jupiter quotes | Wrong mint, input, mode or slippage could reach the builder | Bind ExactIn quotes to the exact request; validate canonical positive u64 amounts, output threshold and unexpected platform fees |
| Copy receipts | RPC null consumed an event; socket events replayed after restart; global dedup suppressed a second target | Persist target-scoped receipts only after readable parsing, retry unreadable RPC results, serialize per-target handling and checkpoint resolved receipts |
| Copy history | More than ten recent signatures silently lost older events | Paginate up to 500 signatures; an unprovable history gap pauses the target and preserves its checkpoint |
| Copy lifecycle | Disabled targets could spend after screening; flood protection re-enabled itself | Recheck the target intent through submission; flood protection persistently disables the target and clears queued events |
| Concurrent execution | Two operations checked and spent the same balance; one operation contaminated another's measurements | Hold one FIFO operation through balance checks, submission, measurements and bookkeeping; wallets inside one batch remain concurrent |
| Reset and deletion | A key obtained before reset could sign and submit afterwards | Invalidate queued operations immediately, check authorization just before dispatch, drain active bookkeeping before erasing keys, clear all owner sessions |
| Confirmation context | A confirmation could execute with different wallets or financial settings | Require the same account generation, settings and wallet selection at confirmation; recheck funding deficits under the operation gate |
| Automation cancellation | Removed rules or DCA plans still fired from old snapshots | Verify live instructions before claiming and submitting; disabled or changed automation cancels builds before dispatch |
| Open cost basis | Buy 100 for 1 SOL, sell 90, buy 10 for 1 SOL produced an entry of 2/110 rather than 1.1/20 | Retire basis proportionally on measured sells; unknown quantities and legacy sales invalidate entry instead of guessing |
| Quantity measurement | Nine-decimal tokens were measured as six decimals; a group with no holdings reset the account's basis | Read actual mint decimals and all account wallets; measure confirmed fills only, invalidate mixed uncertain quantities |
| Token reads | Token-2022 outages, null UI amounts and non-associated accounts became zero or disappeared | Read both token programs completely, use validated raw units, aggregate every account and reject confidential/unreadable balances |
| Sweeps | Only one account per mint moved | Transfer all matching accounts, including non-ATAs; harvest withheld Token-2022 fees before closing |
| Token safety | Live pause authorities and malformed mint/numeric facts could pass | Validate owner, initialized mint and authority options; refuse pausable/unreviewed extensions and unread chain facts |
| Concentration | Lower indexed numbers overwrote higher chain facts; account fragmentation understated wallet concentration | Aggregate by owner, retain the strongest observation, include all unsampled supply in a conservative concentration bound |
| Vesting | End dates and unrelated vault balances waived concentration limits | Apply no discount; label outstanding stream balances potentially claimable and remove the misleading discount control |
| History repair | Token transfer plus wallet funding looked like a sale; unrelated mint units split one SOL delta | Require a supported isolated swap, attributable token debit and SOL/WSOL return; unfamiliar/composed history stays incomplete |
| History boundaries | The last scanned page included transactions older than the requested boundary | Apply the cutoff to each transaction, reject unknown timestamps and repeated page receipts; cancel stale repair writes after reset |
| Position cards | Group or unreadable values were compared against the full account's costs | Withhold profit/cost comparisons for filtered, incomplete or unpriced views; unread holdings do not become an empty position set |
| Gateway and configuration | Retiring Jupiter URLs, unshared request limits and malformed environment values were accepted | Use one authenticated, deadline-aware `api.jup.ag` client; strictly validate startup financial and execution settings |
| Dependencies | Jayson brought vulnerable uuid and stream-json paths | Scope an exact Jayson 5.0.0 override to web3.js, with HTTP/RPC compatibility checks; audit falls from 9 findings to 3 inherited high findings |

## Evidence and validation

`npm run check` runs strict typechecking, 279 smoke checks and all offline
regression suites: 27 transaction, 15 automation, 11 portfolio, 9 history,
51 external-builder, 14 copy-event, 12 concurrency, 12 accounting, 31 deep
history and 10 client/configuration groups, plus wallet and safety suites.
Regression files are under `scripts/`; five actual unsigned
builder responses are recorded in `scripts/fixtures/external-builder-unsigned.json`.
The captures contain public requests and zero signatures, with no private keys.
They exercise current PumpPortal buy/sell, Jupiter SOL-to-USDC and a two-wallet
Jito bundle. Live probes were read-only and established envelope compatibility,
not successful fills or complete swap intent.

The integrated live `npm run netcheck` returned **24 passed, 2 failed**. The
graduated-token concentration probe had no holder figure after public-RPC
rate limits and indexed timeouts; the BONK-to-SOL builder request received
Jupiter HTTP 429. Other quotes, prices, unsigned PumpPortal builds and all eight
sampled live-curve Jupiter routes answered. These results do not establish
uninterrupted provider availability.

The scoped Jayson override also passed isolated single/batch web3 RPC tests,
CJS/browser imports, generated request IDs, notifications and error propagation.
The project checks passed on actual Node 20.18 with its TSX launcher; Node 22.12
native web3 imports and mocked RPC also passed. CI checks Node 22 and 24. Ordinary
installation scripts remain enabled. Missing native bindings in this workspace
are not a deployment mitigation.

`npm audit --omit=dev` now reports **3 high, 0 moderate** findings: one unpatched
`bigint-buffer` advisory plus its SPL parent findings. Reviewed SPL conversions
use fixed-width buffers, but this is an applicability observation, not proof of
safety. No unreviewed fork or forced SPL downgrade was substituted.

## Behavioral tradeoffs

- The holder bound assumes every unsampled token belongs to the ten largest
  wallets. This may refuse tokens whose real distribution is acceptable. It
  avoids claiming a twenty-account sample proves complete wallet concentration.
  Curve/pool exclusion still depends on recognized on-chain ownership evidence.
- Exhaustive mint balances require a bounded read per wallet rather than an ATA
  batch. Correctness improves, with more RPC work and latency.
- A copy receipt is persisted before attempting its trade. A crash after that
  claim can miss a copy; it will not automatically repeat spending. Receipts are
  bounded to 600 per target, and gaps beyond the polling budget pause copying.
- Keyless Jupiter requests share a 2000 ms interval. Deadlines include queue wait;
  expired queued requests do not consume slots. Optional indexed safety facts
  may remain absent, while essential chain facts refuse copying when unreadable.
- Unsupported builders, lookup-table program/debit accounts and composed history
  are refused or reported incomplete. This is deliberately conservative.

## Remaining work, in priority order

1. **Durable per-wallet submission journal and reservations.** Write signed
   identities before broadcasting, recover/reconcile them after restart and
   block further spending on wallets with unresolved submissions. The current
   gate stops in-process overlap; an uncertain transaction can still land after
   the gate releases. Accounting for those fills is not automatically repaired.
2. **Complete swap-intent decoding.** Match mint, input cap, minimum output,
   recipient, accounts and fee rules to the signed venue instructions. Current
   checks protect the envelope and direct instructions, but do not prove all
   CPI behavior. PumpPortal currently returns the opaque program
   `FAdo9NCw1ssek6Z6yeWzWjhLVsr8uiCwcWNUnKgzTnHe`; no published IDL/source was
   found. Its allowlisted presence preserves compatibility and retains builder
   trust. Simulation alone would not establish intent.
3. **Non-ATA sale consolidation.** Sweeps handle all accounts, but a Jupiter sell
   can still expect an input ATA even when holdings exist elsewhere. Plan bounded
   consolidation before quoting; failures currently remain failures, not fills.
4. **Execution and accounting beyond one process.** The FIFO gate is process
   local. External wallet activity can contaminate balance deltas; multiple bot
   instances are not coordinated. Per-signature accounting and a transactional
   store would be stronger for that workload.
5. **Index coverage and repair coverage.** Optional developer-history, trader,
   age and insider index fields can be absent. History repair supports bounded
   known swap layouts and must not certify unfamiliar wrappers or composed swaps.
   Repairs only raise proceeds; older overstatements need a separately reviewed
   correction workflow.

## Primary references

- [Solana transaction structure](https://solana.com/docs/core/transactions/transaction-structure)
- [Solana compute fees](https://solana.com/docs/core/fees/fee-structure)
- [Solana parsed transaction structures](https://solana.com/docs/rpc/json-structures)
- [Solana signature pagination](https://solana.com/docs/rpc/http/getsignaturesforaddress)
- [Solana Token-2022 pausable mint](https://solana.com/docs/tokens/extensions/pausable)
- [PumpPortal local builder](https://pumpportal.fun/local-trading-api/trading-api/)
- [PumpPortal Jito bundle fees](https://pumpportal.fun/local-trading-api/jito-bundles/)
- [Pump public IDLs](https://github.com/pump-fun/pump-public-docs/tree/main/idl)
- [Jupiter quote contract](https://developers.jup.ag/docs/swap/v1/get-quote)
- [Jupiter gateway migration and rate allowance](https://developers.jup.ag/docs/portal/migration)
- [Jupiter instruction IDL](https://github.com/jup-ag/jupiter-cpi/blob/main/idl.json)
- [Streamflow withdrawal calculation](https://github.com/streamflow-finance/js-sdk/blob/master/packages/stream/solana/contractUtils.ts)
- [Jayson 5 changelog](https://github.com/tedeh/jayson#changelog-only-notable-milestoneschanges)
- [Unpatched bigint-buffer advisory](https://github.com/advisories/GHSA-3gc7-fjrx-p6mg)
