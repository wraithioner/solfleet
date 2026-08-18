# Multi-Wallet Command Center

A Telegram bot that drives many Solana wallets at once. Fund every wallet from
one tap, paste a token address to get a full breakdown, buy or sell it across
every wallet at once — and pull everything back to a main wallet when you're
done.

Single-operator by design: only the Telegram user IDs in `OWNER_IDS` are answered
at all. Everyone else gets silence, not an error.

---

## What it does

**Portfolio**
- SOL + SPL token balances for every wallet, with USD valuation and a grand total
- **Profit and loss per position**, in SOL: what went in, what came back, what is
  still held. Buys record what the batch spent; sell proceeds are *measured* from
  the wallets' balances before and after, so the figure is what actually arrived,
  fees already deducted — not a quote taken before the fill
- A designated **main wallet**, shown separately at the top
- Open positions aggregated across all wallets, largest first

**Token research — paste any contract address**
- Logo, name, price, 1h/24h change
- Market cap, FDV, liquidity, 24h volume, buy/sell counts
- **Top holder distribution** with the bonding curve and your own wallets labelled
- pump.fun curve progress bar and graduation status
- **Who launched it and what they still hold** — the pump.fun bonding curve names
  the creator wallet, so the card shows the dev's remaining stake and warns when
  it is over 5% of supply
- **Mint and freeze authority**, stated either way on every card. An active
  freeze authority means the deployer can freeze your token account and stop you
  selling — no chart shows that coming. An active mint authority means supply can
  be created and sold into the pool. Both read straight off the mint account
- Automatic risk warnings: holder concentration, thin liquidity, brand-new pairs,
  volume that looks like wash trading
- Pasting a non-Solana address still returns a research card, labelled with the
  chain and venue it trades on — read-only, since the bot trades Solana
- Works on tokens minutes old, before any indexer knows them, by reading Metaplex
  metadata and the bonding curve directly

**Automation**
- **Take profit, stop loss and trailing stops** per position, checked every 20
  seconds by a watcher that survives restarts — rules live on disk, so a
  redeploy cannot silently drop the stop you were relying on
- A trailing stop tracks the high-water mark rather than your entry, so it works
  on a token you did not buy through the bot
- Three rules the design turns on: an **unreadable price never fires a rule**
  (an RPC hiccup is not a price of zero), a rule **fires once** (marked before
  the sell is attempted, so a crash cannot replay it), and a **locked vault
  pauses rather than fails** — you get one message, not a stream of errors
- Fresh pump.fun tokens are priced off the **bonding curve**, not an aggregator,
  so a stop-loss works from launch rather than from whenever an indexer catches up

**Trading**
- Buy a preset or custom SOL amount **from every wallet at once**
- Sell 25 / 50 / 75 / 100% **from every wallet at once**
- **Sell Everything** — discovers every token held across every wallet and dumps
  it all
- Routing is automatic: the bonding curve while it's live, the AMM once
  graduated, and Jupiter for anything pump.fun can't route at all — so a plain
  SPL token, an airdrop or a Raydium-only coin sells like everything else
- Wallets holding none of the token are skipped, not failed — and neither are
  wallets that can't cover a buy. The confirmation screen says how many of them
  there are *before* you tap, rather than showing you a column of identical
  failures afterwards
- Before you confirm a buy, it simulates the wallets buying *in sequence* and
  shows the true average fill, how far the batch moves the price, and what the
  first and last wallet each get for the same spend

**Moving funds**
- **Fund every wallet from the main wallet** — send the same amount to each, or
  top every wallet up to a target and skip the ones already there. Transfers are
  packed into batched transactions, so 50 wallets cost 4 fees rather than 50
- Sweep all SOL from every wallet into the main wallet, one tap
- Sweep any SPL token, closing the emptied token accounts to reclaim their rent

**Wallet management**
- Generate, import, or derive HD sets from one seed phrase (Phantom's standard
  path, so the wallets import cleanly elsewhere)
- Label wallets, tag them into groups, and point batch operations at one group
- Buy and sell buttons are editable in Settings, so the amounts on screen are
  the sizes you actually trade
- Disable individual wallets to exclude them from batches
- Export addresses as a file; export individual keys as self-destructing messages

---

## Setup

**1. Install**

```bash
npm install
```

**2. Configure**

```bash
cp .env.example .env
```

Fill in three things at minimum:

| Variable | Where it comes from |
| --- | --- |
| `BOT_TOKEN` | [@BotFather](https://t.me/BotFather) → `/newbot` |
| `OWNER_IDS` | [@userinfobot](https://t.me/userinfobot) → your numeric ID |
| `SOLANA_RPC_URL` | Helius, QuickNode, or Triton — see the warning below |

**3. Run**

```bash
npm start
```

**4. Create your vault**

Send `/start` in Telegram. The first message you send becomes your vault
passphrase; your message is deleted the instant it's read. Every private key is
encrypted under it before touching disk.

---

## Deploying to Railway

The bot is a worker, not a web service — it long-polls Telegram and never
listens on a port. Railway runs it fine, but three settings are not optional.

**1. Nothing to configure for the build.** `package.json` sits at the repo root,
so Railway detects a Node app and runs `npm start` on its own. (It previously
lived in a `tg bot/` subdirectory, which made Railpack fail with "could not
determine how to build the app" — that is why the layout is flat.)

**2. A volume — do this before you create any wallets.** Container storage is
erased on every redeploy. The encrypted vault is the *only* copy of your private
keys, so losing it makes every wallet permanently unspendable.

- Add a **Volume** to the service, mount path `/data`
- Set `DATA_DIR=/data` in Variables

The bot checks this at boot and prints a loud warning if the wallet files are
sitting on disposable storage, but it cannot recover keys already lost.

**3. One replica.** Telegram allows a single polling connection per bot token;
two replicas fight over it and the bot flaps with 409 errors. `railway.json`
pins `numReplicas: 1` — leave it there, and leave app sleeping **off**, since a
sleeping bot stops receiving messages.

**Variables to set**

| Variable | Value |
| --- | --- |
| `BOT_TOKEN` | from [@BotFather](https://t.me/BotFather) |
| `OWNER_IDS` | your numeric ID from [@userinfobot](https://t.me/userinfobot) |
| `SOLANA_RPC_URL` | your Helius / QuickNode endpoint |
| `DATA_DIR` | `/data` — must match the volume mount path |
| `VAULT_PASSPHRASE` | leave unset; see below |

**On `VAULT_PASSPHRASE`.** Leave it empty and the vault locks on every restart,
so you send `/unlock <passphrase>` after each redeploy — the key then exists only
in memory. Set it, and the bot unlocks itself unattended, but anyone who can read
your Railway variables owns every wallet. Start without it.

Once deployed, open your bot in Telegram and send `/start`. The first message you
send after that becomes your vault passphrase.

---

## ⚠️ Use a private Solana RPC

The public endpoint (`api.mainnet-beta.solana.com`) rate-limits aggressively.
During testing it rejected `getTokenLargestAccounts` outright, so **holder
distribution silently disappears** — the bot flags this as "unknown" rather than
implying a token is safe, but you're flying blind. Batch operations across more
than a handful of wallets will also fail.

A free Helius or QuickNode key fixes it. This is the single highest-impact thing
you can configure.

---

## Security model

| Concern | How it's handled |
| --- | --- |
| Keys at rest | AES-256-GCM, one random IV per secret. Tampering fails loudly. |
| Passphrase | scrypt, N=2¹⁷ — roughly a second per guess, so offline brute force is impractical |
| Keys in memory | Master key lives in one closure, zeroed on `/lock` and on shutdown |
| Auto-lock | Locks itself after `VAULT_AUTOLOCK_MINUTES` idle (default 30) |
| Secrets in chat | Passphrases, private keys and seed phrases are deleted from the chat on receipt; exports self-destruct after 60s |
| Logs | A redaction filter strips anything shaped like a private key before it's written |
| Access | Non-owner updates are dropped without a reply |
| Destructive actions | Every write operation requires a second confirming tap |

**What this does not protect against:** anyone with read access to your machine
while the vault is unlocked. The keys are in memory by definition — that's what
lets the bot sign. Run it somewhere you control.

Setting `VAULT_PASSPHRASE` in `.env` trades security for unattended restarts:
anyone who can read that file owns every wallet. Leave it empty unless you
specifically need it.

**Back up `data/vault.json` and `data/wallets.json` together.** One is useless
without the other, and there is no recovery path for a lost passphrase.

### Starting over

**Settings → 🧨 Factory reset** deletes the vault, every private key, the seed
phrase, every label and group, and the trade history — then drops back to the
first-run state so `/start` builds a new vault from scratch.

Before it does anything it shows you what you are about to destroy, including
**the live SOL balance held across those wallets**, because that is the one fact
that should stop a reset that is about to burn real money. Sweep or export first.
Confirming means typing `RESET EVERYTHING` exactly — a button is too easy to
press by accident.

It works **while the vault is locked**, on purpose: forgetting the passphrase is
the most likely reason to need it, and the keys are already unreachable at that
point. Anything those wallets still hold is gone for good.

---

## Safety rails

Set in `.env`:

- `MAX_BUY_SOL_PER_WALLET` — hard ceiling on any single buy, per wallet.
  Multiplied across 50 wallets, a fat-fingered amount gets expensive fast.
- `REQUIRE_CONFIRMATION` — second tap before anything that spends or moves funds.
- `sweepReserveSol` (in Settings) — SOL left behind in each wallet so it can
  still pay fees after a sweep. The main wallet keeps the same amount back when
  funding, so a distribution can't drain it to the point where it cannot pay for
  its own next transaction.

Funding refuses outright if the main wallet cannot cover the whole plan, rather
than half-funding the set and leaving you to work out which wallets missed.

---

## Execution modes

**`parallel`** (default) — each wallet's transaction is sent independently with
bounded concurrency. One wallet failing costs you nothing on the others. Fills
land over a few seconds at slightly different prices.

**`bundle`** — wallets are grouped 5 at a time into Jito bundles. Each group is
atomic: all five land in the same block, or none do. Use this when entry price
matters. Costs a Jito tip per bundle, and a bundle that doesn't get picked up
fails as a unit.

Toggle it in Settings, or set `DEFAULT_EXECUTION_MODE`.

### Priority fees

A fixed priority fee is wrong twice over: too low when the chain is busy, which
is exactly when an entry is worth landing, and wasteful when it is quiet.

In **auto** mode (the default) the bot samples what recent blocks actually paid
to touch the pump.fun program and bids the 75th percentile of that, times 1.25.
The median gets outbid in the moments that matter; the maximum is one desperate
bidder rather than the going rate.

Your configured `priorityFeeSol` becomes the **floor** — auto mode only ever
raises the bid — and `priorityFeeCeilingSol` caps it so a congestion spike cannot
run away with the balance. If the fee market cannot be sampled, your configured
value stands.

Measured while building this: the network wanted **838,139 microLamports/CU** for
the pump.fun program, which is **0.00026 SOL** — over 5× the old fixed default of
0.00005. Trades at the fixed rate were bidding well under the going rate.

---

## A note on batch buying

Buying the same token from many wallets walks the bonding curve. The tenth wallet
does not get the first wallet's price.

The bot simulates this before you confirm and shows the real aggregate: 10
wallets × 0.5 SOL into a fresh curve moves the price **+35.7%**, the average fill
lands **+17.7%** above the price on screen, and the first wallet receives
17.4M tokens where the last receives 13.2M for the identical 0.5 SOL. Those
numbers are on the confirmation screen for a reason — read them before tapping.
Past +25% the screen says so in bold.

---

## Verification

```bash
npm run check
```

Runs three layers:

- `typecheck` — full TypeScript strict-mode pass
- `smoke` — 73 offline assertions: vault crypto (round-trip, unique IVs, tamper
  rejection, lock/unlock, passphrase rotation re-sealing every key), wallet
  derivation, group and main-wallet invariants, bonding curve maths and batch
  simulation, funding arithmetic (shortfall-only top-ups, transaction packing,
  refusing a plan the main wallet can't afford, skipping wallets that cannot
  cover a buy), token account parsing, P&L arithmetic (banked profit, a position
  worth zero, and no divide-by-zero without a cost basis), factory reset (files
  removed from disk, fresh setup possible afterwards), address parsing,
  concurrency helpers, log redaction
- `netcheck` — 19 live read-only checks against Solana RPC, DexScreener, Jupiter,
  PumpPortal and the pump.fun program

`netcheck` never signs or broadcasts anything. It builds unsigned transactions
for a throwaway public key purely to confirm the request shape still matches, and
throws them away.

Run `netcheck` after any upstream outage or unexpected trade failure — it will
tell you which dependency moved.

---

## Commands

| Command | Effect |
| --- | --- |
| `/start` | Main menu |
| `/unlock <passphrase>` | Unlock the vault (your message is deleted) |
| `/lock` | Wipe keys from memory |
| `/portfolio` | Balances across every wallet |
| `/wallets` | Wallet management |
| `/history` | Recent batch operations |
| `/help` | Command list |

Everything else is inline buttons. Pasting a token address is the main entry
point.

---

## Layout

```
src/
  config.ts            env parsing, endpoints
  chains/
    solana.ts          balances, transfers, sweeps, confirmation polling
  store/
    vault.ts           scrypt + AES-256-GCM keystore
    wallets.ts         registry, HD derivation, the encryption boundary
    db.ts              atomic JSON persistence
  trade/
    pumpportal.ts      builds pump.fun transactions, signs them locally
    jito.ts            bundle submission and status polling
    curve.ts           bonding curve reads, quotes, batch simulation
    jupiter.ts         aggregator swaps for graduated and general SPL
    fund.ts            distribution: main wallet → every trading wallet
    engine.ts          batch execution across wallets
  services/
    tokeninfo.ts       the token card: market data, holders, warnings
    metadata.ts        Metaplex metadata for un-indexed tokens
    portfolio.ts       cross-wallet, cross-chain aggregation
    prices.ts          cached USD pricing
    pnl.ts             cost basis and profit/loss, denominated in SOL
    price.ts           price in SOL: bonding curve first, aggregator second
    watcher.ts         the loop behind take-profit, stop-loss and trailing stops
    mintauth.ts        mint + freeze authority, the two Solana rug vectors
  bot/                 Telegram layer: routing, screens, session state
```

### On pump.fun execution

Transactions are built by PumpPortal's *local* API and signed here, with keys
that never leave the process. No third party can move your funds. The upside over
hand-rolling the instructions is that pump.fun changes its program layout without
notice — account ordering, the creator-vault PDA — and that stays their problem
rather than becoming a wave of failed transactions on your side.

Quoting is done independently by reading the bonding curve directly, so the price
on screen is the real on-chain price rather than whatever an API reports.
