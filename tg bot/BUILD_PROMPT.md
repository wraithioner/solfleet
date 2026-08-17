# Build Prompt — Multi-Wallet Command Center

> Paste this whole file into a coding agent (Claude Code, Copilot Workspace, Cursor)
> to build the project from scratch, or keep it in the repo as the spec that
> explains *why* the code is shaped the way it is.
>
> Everything in **§7 Verified API contracts** was confirmed against the live
> endpoints. Do not "fix" it from memory — several of those endpoints have moved
> recently and the stale versions are what most training data contains.

---

## 1. What this is

A Telegram bot that operates **many crypto wallets simultaneously** — Solana and
EVM — from a phone.

The problem it solves: someone running 10–50 wallets currently juggles browser
extensions, spreadsheets of addresses, and manual repetition. Checking a total
balance means adding up 40 numbers by hand. Buying a token across every wallet
means 40 separate approvals. Getting funds back into one place means 40 transfers.

This collapses all of that into single taps in a chat window.

**Primary user:** one person, operating their own wallets, from their own phone.
Not a service, not multi-tenant, no accounts, no web UI.

**Core loop:** paste a token address → read its stats and holder distribution →
buy it across every wallet → later, sell across every wallet → sweep the proceeds
back to a main wallet.

### Non-goals

- Multi-user / SaaS. One owner, hardcoded by Telegram user ID.
- Custody of anyone else's keys.
- A web dashboard. Telegram is the entire interface.
- EVM batch trading. EVM gets balances, transfers and sweeps only. Batch trading
  is Solana/pump.fun.

---

## 2. Feature requirements

### 2.1 Portfolio

- SOL and SPL token balances for every wallet, USD-valued, with a grand total.
- Native balances across Ethereum, Base, Arbitrum, BNB Chain, Polygon, Optimism.
  Only chains with a configured RPC are enabled.
- A designated **main wallet** per chain kind, displayed separately at the top.
  Exactly one per kind — this is an invariant enforced in the store.
- Aggregated open positions across all wallets, sorted by USD value.
- Batching is mandatory: one `getMultipleAccounts` per 100 Solana wallets, one
  Multicall3 round trip per EVM chain. Never one RPC call per wallet for native
  balances.

### 2.2 Token research — the headline feature

Pasting any contract address into the chat (bare, in a sentence, or as a
pump.fun / DexScreener URL) must produce a card containing:

- Token logo, name, symbol
- Price, 1h and 24h change
- Market cap, FDV, liquidity, 24h volume, buy/sell transaction counts
- **Top holder distribution**, with the bonding curve and the operator's own
  wallets explicitly labelled
- pump.fun bonding-curve progress bar and graduation status
- How much of the supply the operator's own wallets already control
- Automatic risk warnings (see §2.3)
- Inline buy and sell buttons

It must work on tokens that are **minutes old**, before any indexer has them.
That means reading Metaplex metadata and the bonding curve directly on-chain when
DexScreener returns nothing.

### 2.3 Risk warnings

Surface these on the card, computed not guessed:

- Top 10 holders (excluding pool/curve accounts) hold > 50% of supply
- Liquidity under $5,000 on a non-pump token
- Pair created less than an hour ago
- 24h volume more than 50× liquidity (wash-trading shaped)
- Bonding curve already complete
- No indexed market found at all
- **Holder data unavailable.** Critical: a failed holder query must render as
  "unknown", never as an absent section. Silence reads as "no concentration
  risk" and that is the exact opposite of the truth.

### 2.4 Batch trading (Solana)

- Buy a preset or custom SOL amount **from every selected wallet**.
- Sell 25/50/75/100% **from every selected wallet**.
- "Sell Everything" — discover every distinct mint held across all wallets, then
  sell 100% of each, one mint at a time.
- Route automatically: bonding curve while live, AMM once graduated, **and the
  aggregator for anything pump.fun cannot route at all**. PumpPortal answers HTTP
  400 for any mint it does not know, which is the normal response for a plain SPL
  token — an airdrop, a Raydium-only coin, the USDC a wallet was funded with.
  Treating that 400 as the end of the story makes "sell everything" quietly mean
  "sell everything that happens to be a live pump.fun token". Fall back to
  Jupiter per wallet. A token still on its curve exists nowhere else, so skip the
  fallback there rather than paying for a request that cannot succeed.
- Before a sell, read every wallet's balance in **one batched call** and skip the
  wallets holding nothing. Selling across 50 wallets when 3 hold the token should
  not produce 47 failures. Distrust an entirely empty read — that is far more
  likely to be a bad response than 50 genuinely empty wallets the operator just
  asked to sell.
- Two execution modes, switchable at runtime:
  - **parallel** — independent sends with bounded concurrency. One wallet
    failing costs nothing on the others.
  - **bundle** — Jito bundles, 5 wallets per bundle, atomic per group. For when
    fill price matters.

### 2.5 Batch buy price simulation — do not skip this

Buying the same token from N wallets **walks the bonding curve**. The tenth
wallet does not get the first wallet's price.

Before confirming a buy, simulate the wallets buying *in sequence* against the
live curve reserves and show the true aggregate: total tokens, average fill
price, and how far the price moved.

Reference figures from testing, 10 wallets × 0.5 SOL into a fresh curve: the
price moves **+35.7%**, the average fill lands **+17.7%** above spot, and the
first wallet receives **17.4M** tokens where the last receives **13.2M** for the
identical 0.5 SOL. Showing `N × spot_quote` instead would be a material lie to
the operator at the exact moment they are committing funds.

Every one of those numbers must reach the screen. Computing the price move and
then not rendering it is the same failure as never computing it — put the
arithmetic in one tested function rather than re-deriving it in the handler,
and call out a move past ~25% in bold.

### 2.6 Moving funds — both directions

**Distribution** (main wallet → trading wallets). Batch buying is worthless if
the wallets doing the buying hold no SOL, and funding fifty wallets by hand is
the exact drudgery this tool exists to remove.

- Send a fixed amount to every selected wallet, **or** top every wallet up to a
  target and skip the ones already there.
- Pack transfers into multi-recipient transactions. One transaction per wallet
  costs a signature fee per wallet for no reason; 16 recipients serialise to
  ~1004 bytes, comfortably inside the 1232-byte transaction limit.
- Send those transactions **sequentially** — they all spend from one wallet, and
  firing them concurrently races the source balance into "insufficient lamports".
- Compute the whole plan and **refuse up front** if the source cannot cover it.
  Half-funding a set and leaving the operator to work out which wallets missed
  is worse than not starting.

**Consolidation** (trading wallets → main wallet).

- Sweep all SOL from every wallet into the main wallet.
- Sweep any SPL token, **closing the emptied token account** to reclaim its rent.
- Sweep native balance on any configured EVM chain.
- Leave a configurable reserve behind per wallet so it can still pay fees later.
- A wallet holding less than its own transfer cost is **skipped, not failed** —
  that is a normal outcome of a sweep, not an error. The same applies to a wallet
  that is already funded during a top-up.

### 2.7 Wallet management

- Generate, import (raw key), or derive HD sets from one seed phrase.
- Use standard derivation paths so wallets import cleanly into Phantom/MetaMask:
  - Solana `m/44'/501'/{i}'/0'`
  - EVM `m/44'/60'/0'/0/{i}`
- Accept both real-world export formats on import: base58 Solana secret keys
  (64-byte, and 32-byte seed) and `0x`-prefixed EVM hex.
- Label wallets, tag them into groups, target batch operations at one group.
- Disable individual wallets to exclude them from batches without deleting them.
- Export addresses as a file. Export individual private keys as self-destructing
  messages.

---

## 3. Security requirements

These are requirements, not suggestions. The whole point of the tool is that it
holds keys that can move money.

| Requirement | Implementation |
| --- | --- |
| Keys encrypted at rest | AES-256-GCM, fresh random 12-byte IV per secret. Authenticated, so tampering fails loudly instead of yielding a garbage key. |
| Passphrase stretching | scrypt, N=2¹⁷, r=8, p=1 (~1s per attempt, ~128 MiB). Pass `maxmem` explicitly — Node's 32 MB default rejects these parameters. |
| Key in memory only | Master key lives in one module closure. Never written, never logged. Zeroed on lock and on shutdown. |
| Passphrase verification | A `verifier` blob sealed under the key, so a wrong passphrase is detected without touching wallet data. |
| Auto-lock | Configurable idle timeout, default 30 minutes. |
| Secrets in chat | Delete the operator's message containing a passphrase, private key, or seed phrase **immediately on receipt**. Key exports self-destruct after 60s. |
| Log redaction | Filter anything shaped like a private key (long base58, 0x+64 hex) out of every log line. Public addresses must stay readable. |
| Access control | Drop updates from non-owner Telegram IDs **without replying**. An unauthorised caller should not learn the bot exists. |
| Destructive actions | Every fund-moving operation requires a second confirming tap. Confirmations expire after 5 minutes and are held in memory only, so a restart cannot resurrect a half-finished action. |
| Passphrase rotation | Re-encrypt every stored secret under the new key **before** committing the new vault file, so a crash cannot orphan wallets from their vault. |

Also required:

- A per-wallet buy ceiling (`MAX_BUY_SOL_PER_WALLET`). Across 50 wallets a
  mistyped amount gets expensive instantly.
- State clearly in the README that this does **not** protect against someone with
  read access to the machine while unlocked — keys are in memory by definition,
  that is what allows signing.

---

## 4. Architecture

Layered, with a single encryption boundary. Nothing outside `store/` ever sees a
plaintext key except the signing call that needs it.

```
src/
  config.ts            env parsing, endpoint constants
  types.ts             shared domain types
  util.ts              pMap, retry, chunk, fetch-with-timeout, formatters
  logger.ts            logging + secret redaction

  chains/
    solana.ts          balances, transfers, sweeps, confirmation polling
    evm.ts             multicall balances, transfers, gas-aware sweeps

  store/
    vault.ts           scrypt + AES-256-GCM keystore, lock/unlock/rotate
    wallets.ts         registry, HD derivation, THE encryption boundary
    db.ts              atomic JSON persistence

  trade/
    pumpportal.ts      builds pump.fun transactions, signs them locally
    jito.ts            bundle submission and status polling
    curve.ts           bonding curve reads, quotes, sequential simulation
    jupiter.ts         aggregator swaps for graduated / general SPL
    fund.ts            distribution: planning (pure) + batched execution
    engine.ts          batch execution across wallets

  services/
    tokeninfo.ts       the token card: market data + holders + warnings
    metadata.ts        Metaplex metadata for un-indexed tokens
    portfolio.ts       cross-wallet, cross-chain aggregation
    prices.ts          cached USD pricing

  bot/
    index.ts           auth middleware, commands, callback router
    ui.ts              rendering + inline keyboards
    session.ts         pending-input state, confirmations, short-id registries
    handlers/          core / wallets / trade screens
```

### Stack

TypeScript (ESM, strict), Node ≥ 20, run with `tsx`.

- `grammy` — Telegram
- `@solana/web3.js`, `@solana/spl-token`
- `viem` — EVM
- `bip39`, `ed25519-hd-key`, `bs58`

**Use a flat JSON store with atomic writes, not SQLite.** The dataset is a few
hundred rows; a native module drags a compiler toolchain onto Windows for zero
benefit. Write to a temp file and `rename` so a crash cannot truncate the wallet
index.

### Two implementation details that matter

**Telegram caps `callback_data` at 64 bytes.** A Solana mint alone is 44 of them,
and a wallet UUID is 36. Keep in-memory registries mapping short random ids
(6–8 hex chars) to mints and wallet ids, and put only the short id in buttons.

**Telegram throttles message edits.** A 50-wallet batch that edits after every
wallet gets rate-limited mid-execution. Coalesce progress updates to at most one
every ~1.5 seconds.

---

## 5. Execution engine

`parallel` mode: `pMap` with bounded concurrency. Wrap each wallet so one failure
is captured as a result row rather than rejecting the batch. Retry with
**exponential backoff plus jitter** — without jitter, a batch of wallets retries
in lockstep and re-hammers the RPC at the same instant.

`bundle` mode: chunk wallets into groups of 5, build all 5 transactions in one
request so they share a blockhash, sign each with its own keypair, submit as a
Jito bundle, poll for landing.

Every batch returns a summary of per-wallet results — success, signature, or
error — never a single pass/fail. The operator needs to know *which* wallets
missed.

---

## 6. UX rules

- Paste-an-address is the primary entry point, not a menu item.
- Attach the token logo as a **link preview**, not a photo. A photo caption caps
  at 1024 characters; a link preview keeps the full 4096 and still shows the
  image.
- Show a confirmation screen with concrete numbers — wallet count, total spend,
  simulated average fill — not a generic "Are you sure?".
- Render batch results per wallet with explorer links.
- Distinguish "nothing to do" from "failed". A dust wallet skipped during a sweep
  is not a failure.

---

## 7. Verified API contracts

**Confirmed live. Do not substitute remembered versions.**

### 7.1 PumpPortal — pump.fun execution

`POST https://pumpportal.fun/api/trade-local`

```json
{
  "publicKey": "<base58 pubkey>",
  "action": "buy" | "sell",
  "mint": "<mint>",
  "amount": 0.001,
  "denominatedInSol": "true" | "false",
  "slippage": 15,
  "priorityFee": 0.00001,
  "pool": "auto" | "pump" | "pump-amm" | "raydium" | "bonk" | "launchlab" | "raydium-cpmm"
}
```

- Single object → response is **raw transaction bytes** (`application/octet-stream`).
  Deserialize with `VersionedTransaction.deserialize(bytes)`.
- Array of up to **5** objects → response is a **JSON array of base58-encoded**
  transactions, sharing a blockhash. This is the bundle form.
- In bundle form, **only the first transaction's `priorityFee` is used** — as the
  Jito tip for the whole bundle. Fees on the rest are ignored, so set them to 0.
- For sells, pass the amount as a percentage string like `"100%"`. PumpPortal
  resolves it against the wallet's actual holding at build time, which avoids a
  stale-balance race between your read and the transaction landing.
- **HTTP 400 is normal and correct** for a mint that is not tradable on the
  requested pool, or an invalid/off-curve public key. Do not treat a 400 as a
  broken integration — verify with a token that is live on pump.fun right now.

The transaction comes back **unsigned**. Sign locally. Rebuild from the message
(`new VersionedTransaction(tx.message)`) before signing so no placeholder
signature survives onto the wire. No third party ever holds the keys.

Why use this rather than hand-rolling the instructions: pump.fun changes its
program layout without notice — account ordering, the creator-vault PDA. Using
the builder keeps that their problem instead of your wave of failed transactions.

### 7.2 Jito bundles

`POST https://mainnet.block-engine.jito.wtf/api/v1/bundles`

```json
{ "jsonrpc": "2.0", "id": 1, "method": "sendBundle", "params": [["<base58 tx>", "..."]] }
```

Base58, not base64. Max 5 transactions. Poll `getBundleStatuses` for landing.

### 7.3 Jupiter

- Quote: `GET https://lite-api.jup.ag/swap/v1/quote?inputMint=&outputMint=&amount=&slippageBps=`
- Swap: `POST https://lite-api.jup.ag/swap/v1/swap` → base64 in `swapTransaction`
- **Price: `GET https://lite-api.jup.ag/price/v3?ids=<comma-separated mints>`**

⚠️ **Price v2 is dead — it returns 404 "Route not found".** v3 also changed shape:

```jsonc
// v2 (GONE):  { "data": { "<mint>": { "price": "75.79" } } }
// v3 (LIVE):  { "<mint>": { "usdPrice": 75.79, "decimals": 9, "priceChange24h": 0.73 } }
```

Flat map, no `data` wrapper, field is `usdPrice` and it is a number.

### 7.4 DexScreener

Use the **chain-scoped** endpoint:

`GET https://api.dexscreener.com/tokens/v1/{chainId}/{tokenAddress}`

⚠️ **Two traps, both of which produce confidently wrong prices:**

1. **Every field describes the pair's BASE token.** `priceUsd`, `marketCap`,
   `volume` — all of it. If your address appears as the *quote* side of a pair,
   you will read an unrelated token's price. Filter to
   `baseToken.address === yourAddress` before picking a pair.

2. **An EVM address is not unique across chains.** Forks reuse identical contract
   addresses. The unscoped `/latest/dex/tokens/{address}` endpoint queried for
   USDT returned **only pulsechain pairs** and reported **$0.0009** instead of
   **$0.9993**. Query each chain explicitly and pick the deepest pool.

Then select the pair with the highest `liquidity.usd` — thin pools quote nonsense.

Logo is at `info.imageUrl`.

### 7.5 pump.fun bonding curve (on-chain)

- Program: `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P`
- Curve PDA seeds: `["bonding-curve", mintPubkey]`
- Account layout (little-endian, after the 8-byte Anchor discriminator):

| Offset | Field | Type |
| --- | --- | --- |
| 8 | virtualTokenReserves | u64 |
| 16 | virtualSolReserves | u64 |
| 24 | realTokenReserves | u64 |
| 32 | realSolReserves | u64 |
| 40 | tokenTotalSupply | u64 |
| 48 | complete | bool |
| 49 | creator | pubkey (**newer accounts only**) |

Parse defensively — read `creator` only when the account is ≥ 81 bytes. Older
accounts stop at 49.

Maths (constant product, 1% fee each side, 6 decimals):

```
price          = (vSol / 1e9) / (vTok / 1e6)
tokensOut(sol) = (solAfterFee * vTok) / (vSol + solAfterFee)
solOut(tokens) = ((tok * vSol) / (vTok + tok)) * 0.99
```

For the sequential simulation, update `vSol += in; vTok -= out` after each wallet.

`complete === true` means graduated → route to `pump-amm`, not the curve.

### 7.6 Metaplex metadata (for un-indexed tokens)

- Program: `metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s`
- PDA seeds: `["metadata", metadataProgramId, mint]`
- Layout: `key(1) + updateAuthority(32) + mint(32)`, then three borsh strings —
  name, symbol, uri. Each is a u32 LE length prefix followed by null-padded
  bytes; strip trailing `\0`.
- Follow `uri` to the off-chain JSON for `image` and `description`. It is usually
  IPFS: use a short timeout and fail silently.

### 7.7 Other

- Multicall3 is at `0xcA11bde05977b3631167028862bE2a173976CA11` on every
  supported EVM chain and exposes `getEthBalance(address)` — use it to batch
  native balance reads, with a per-address fallback.
- CoinGecko `simple/price` for EVM native coin USD prices. Cache ~60s.

---

## 8. Environment

```bash
BOT_TOKEN=                  # @BotFather
OWNER_IDS=                  # @userinfobot, comma-separated
SOLANA_RPC_URL=             # private endpoint — see §9
SOLANA_SEND_RPC_URL=        # optional low-latency sender
ETHEREUM_RPC_URL=           # blank disables the chain
BASE_RPC_URL=
ARBITRUM_RPC_URL=
BSC_RPC_URL=
POLYGON_RPC_URL=
OPTIMISM_RPC_URL=
VAULT_PASSPHRASE=           # leave empty; set only for unattended restart
VAULT_AUTOLOCK_MINUTES=30
DEFAULT_SLIPPAGE_PERCENT=15
DEFAULT_PRIORITY_FEE_SOL=0.00005
DEFAULT_EXECUTION_MODE=parallel
EXECUTION_CONCURRENCY=5
JITO_TIP_SOL=0.0001
MAX_BUY_SOL_PER_WALLET=5
REQUIRE_CONFIRMATION=true
DATA_DIR=./data
```

`.gitignore` must cover `.env`, `data/`, and any `*.vault.json` / `*.keystore.json`.

---

## 9. Known environment trap

The public Solana RPC (`api.mainnet-beta.solana.com`) **rejects
`getTokenLargestAccounts` outright** under load. Holder distribution disappears,
and batch operations across more than a handful of wallets fail.

Two consequences for the build:

1. Warn loudly at startup when the public endpoint is configured.
2. Never let that failure render as an empty holders section — it must say
   "unavailable". See §2.3.

---

## 10. Verification requirements

Ship three layers, wired to `npm run check`.

**`typecheck`** — TypeScript strict mode, zero errors.

**`smoke`** — offline, no network, no Telegram. Must assert at least:

- Vault: seal/open round-trip; two seals of identical plaintext differ (fresh
  IV); a flipped ciphertext byte throws; lock blocks decryption; wrong passphrase
  rejected; re-unlock restores access
- Passphrase rotation: all addresses unchanged, new passphrase works, old one
  fails
- Wallets: keypair reconstructs to the stored address; duplicate import rejected;
  HD derivation yields distinct sequential indices; group filter selects only
  tagged wallets; disabled wallets excluded; exactly one main wallet per kind
- Curve: spot price sane; a buy fills below spot-implied (slippage); a round trip
  returns less than it cost but is not catastrophic; sequential simulation yields
  fewer tokens than N × single quote and moves the price up; the price-move
  figure measures final against *starting* price; the average fill sits between
  spot and the final price; the first wallet fills better than the last; a
  one-wallet batch reduces exactly to the plain quote
- Funding: a flat send gives every wallet the full amount; a top-up funds only
  the shortfall and reports already-funded wallets as skipped rather than failed;
  transfers pack into the expected number of transactions and cost per
  transaction, not per wallet; a plan exceeding the source balance throws before
  anything is signed; a zero amount is rejected
- Token accounts: the balance is read from the right offset, and an empty or
  truncated account reads as zero rather than throwing
- Parsing: bare mint, mint in a sentence, mint in a pump.fun URL, EVM address;
  and rejection of a 44-char string that is not valid base58
- `pMap` preserves input order under concurrency; `retry` backs off then succeeds
- Logger redacts base58 and hex private keys but leaves public addresses readable

**`netcheck`** — live, **read-only**. Hits Solana RPC, DexScreener, Jupiter,
PumpPortal and the pump.fun program to confirm every contract in §7 still holds.

It must **never sign or broadcast**. Build unsigned transactions against a
throwaway generated public key purely to confirm the request shape, then discard
them.

It must **discover a live pump.fun token dynamically** (e.g. from DexScreener's
`token-profiles/latest/v1`, filtering for solana mints ending in `pump`). Testing
PumpPortal against a blue-chip like BONK returns 400 and tells you nothing — that
mistake wastes real debugging time.

Include a negative test asserting a non-pump mint surfaces as a clean error
rather than a malformed transaction.

---

## 11. Build order

1. `config`, `types`, `util`, `logger`
2. `store/vault` — get the crypto right and unit-test it before anything else
   depends on it
3. `store/db`, `store/wallets`
4. `chains/solana`, `chains/evm`
5. `trade/curve` (quotes + simulation), then `pumpportal`, `jito`, `jupiter`
6. `trade/engine`
7. `services/prices`, `metadata`, `tokeninfo`, `portfolio`
8. `bot/` — session, ui, handlers, router
9. `scripts/smoke`, `scripts/netcheck`
10. README

Run `netcheck` **before** wiring the UI. Discovering that a price endpoint moved
is cheap at step 9 and expensive after the UI is built on top of it.

---

## 12. Publishing to GitHub

```bash
git init
git add -A
git commit -m "Multi-wallet Telegram command center for Solana + EVM"
gh repo create <name> --private --source=. --push
```

**Keep it private, or verify `.gitignore` first.** `data/vault.json` plus
`data/wallets.json` together are your wallets. Committing them once is
unrecoverable — treat any key that touches a public repo as burned, and move the
funds.

---

## 13. Definition of done

- `npm run check` passes all three layers
- The bot boots, warns about a public RPC, and creates a vault on first `/start`
- Pasting a token address returns a card with logo, market data, holder
  distribution and working buy/sell buttons
- A batch buy shows the simulated average fill **and the price move** before the
  confirm tap
- One tap funds every wallet from the main wallet, in batched transactions, and
  refuses outright if the main wallet cannot cover the plan
- A sell reaches tokens that never launched on pump.fun, and reports wallets
  holding none of it as skipped rather than failed
- A sweep moves funds to the main wallet and skips dust wallets without
  reporting them as failures
- Non-owner Telegram IDs receive no response of any kind
- No private key appears in any log line
