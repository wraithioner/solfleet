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

**Copy trading**
- Follow any Solana wallet. Three settings per wallet, each one tap:
- **Size** — a fixed SOL amount per wallet (`0.05`), or a share of their trade
  (`5%`). Percent sizing reads the SOL that actually left their wallet, so a
  10 SOL conviction buy and a 0.5 SOL nibble are copied at different sizes
  instead of being flattened to one number. `5%` means the whole batch is 5% of
  their trade — not 5% multiplied by however many wallets you have running, and
  the per-wallet safety cap still binds
- **Entries** — *first buy only*, or *follow their DCA* up to 3, 5 or 10 entries.
  A trader scaling in over twenty transactions must not be able to decide how
  much of your money goes into a token, so following in is always bounded
- **Follow them out** — *mirror the share they sell* (they trim 10%, you trim
  10%), *exit fully on any sell* (a trader trimming is often on the way out, and
  being seconds behind makes a partial follow the worst of both), or *ignore
  their sells* entirely
- **Your own exits** — a take-profit (+50/100/200/500%) and a stop-loss
  (-30/50/70%), armed automatically on every position the wallet opens for you
  and measured from what *you* paid. This is the exit that does not depend on
  their timing: following someone out means selling seconds after they did, at
  whatever the price has become by then. The take-profit sells half and lets the
  rest run; the stop exits completely
- **Every copied buy is screened first.** Copy trading is the only buy in this
  bot with no human in the loop — every other one is a deliberate tap on a
  screen already listing the warnings. Before money moves, a copied token is
  refused if the top 10 hold over 20% of supply, the launch wallet holds over
  1%, the mint or freeze authority is still live, or the pool is under $3,000.
  All four are adjustable under **Copy trading → 🛡 Safety**
- **These defaults are strict on purpose, and strict has a cost.** Sampled
  against 14 tokens people were actively trading: 2 passed. Every rejection but
  one was concentration — top 10 at 21%, 25%, 29%, 42%, 51%, 78%. Raising the
  top-10 limit to 40% is the single tap that changes this most
- **A live freeze authority is the Solana honeypot.** There is no sell tax or
  blacklist function here as there is on an EVM chain — a deployer who wants to
  trap holders freezes their token accounts, and a frozen account cannot
  transfer, so it cannot sell, and no chart shows it coming
- **Unknown counts as unsafe.** A holder query the RPC rate-limited returns no
  concentration figure, and reading that as "concentration is fine" is how an
  unattended buyer walks into exactly the token the check exists to avoid. A
  token that could not be read is refused
- **A token is entered once and never again.** Not after they sell it, not if
  they buy back in a week. `copiedMints` records that this wallet already got
  you into that token and nothing clears it
- Following a wallet records where it is and starts from there. Their existing
  positions are never retroactively bought
- **The honest limitation:** the bot polls every 20 seconds, so your copy lands
  seconds behind theirs, and on a memecoin those seconds are often the move.
  This follows a trader; it does not race one, and nothing on an interval timer
  could

**Speed**
- Every RPC request is cut off at 12 seconds and a timeout is never retried, so
  a stalled endpoint produces a readable error instead of a screen that never
  arrives
- The holder-concentration query has a tighter 4-second deadline of its own.
  Providers throttle that index query harder than anything else a token card
  needs, and it is the one section the card can render without — the price,
  market cap and safety checks should not wait behind it

**Fees and rent, so a position can always be closed**
- A wallet is only sent into a buy if it can afford the *round trip*. The
  requirement is the trade, its signature and priority fees, the ~0.00204 SOL
  rent that opening the token account costs, a bundle tip where one applies, and
  a reserve for the sell — two sells' worth, so one failed attempt does not strand
  the position. A 0.05 SOL buy therefore needs **0.0522 SOL** in the wallet
- **A graduated token costs one more rent-exempt account.** Past the bonding
  curve every venue is an SPL pool, so the buy has to wrap SOL: open a WSOL
  account, fund it, swap, close it again. The close refunds the rent, but the
  wallet still has to put it up — so a buy on PumpSwap or Raydium asks for
  **0.0543 SOL**, not 0.0522
- This is the mistake the check exists to prevent: fund fifty wallets with
  exactly 0.05 and buy 0.05, and every one of them either fails outright on the
  rent or fills and is then left holding a token it has no SOL left to sell
- The funding screen states the real per-wallet figure, and the buy screen states
  it again alongside how many wallets fall short

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
- **Limit orders** — buy the dip or sell into strength at a fixed price. Set as a
  percentage off the current price and stored as an absolute target, so it cannot
  drift with the market afterwards
- **DCA** — average in with "0.05 30 6": 0.05 SOL per wallet, every 30 minutes,
  six rounds. Plans carry their remaining rounds and stop on their own; a failed
  round advances the schedule rather than bunching the buys together
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

**4. Open it**

Send `/start` in Telegram. There is nothing to set up: the vault is created on
first boot and opens itself on every boot after that.

### The RPC endpoint is not optional

Without `SOLANA_RPC_URL` the bot falls back to `api.mainnet-beta.solana.com`,
and that endpoint does not work for this. It answers `getHealth` in ~40ms and
then **never replies at all** to `getMultipleAccounts` — the call behind every
balance, portfolio and position screen. Measured from a Railway container:

```
getHealth            41ms   ok
getMultipleAccounts  hangs  (aborted at 15s, three times running)
```

So the bot guards against it rather than trusting it: RPC requests are cut off
at 12 seconds, a timeout is never retried, and the home screen says so in plain
text while no private endpoint is set. You get an error you can read instead of
a screen that never arrives — but you still get no data. Set the variable to a
[Helius](https://helius.dev), QuickNode or Triton endpoint; the free tiers are
enough to run this.

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

Once deployed, open your bot in Telegram and send `/start`. Nothing to unlock —
the vault comes up with the container.

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
| Master key | Random 32 bytes in `data/vault.key` at 0600, held in one closure, zeroed on shutdown |
| Secrets in chat | Private keys and seed phrases are deleted from the chat on receipt; exports self-destruct after 60s |
| Logs | A redaction filter strips anything shaped like a private key before it's written |
| Access | Non-owner updates are dropped without a reply |
| Destructive actions | Every write operation requires a second confirming tap |

**What this does not protect against: anyone who can read the data directory.**
The key that decrypts the wallets sits in it, so a copy of the volume is a copy
of the wallets. This is a deliberate trade — a passphrase that had to be re-typed
after every container restart was worse than useless, and a bot that cannot open
its own vault cannot run a stop-loss while you sleep. Encryption at rest here
defends a leaked `wallets.json`, a backup that went somewhere it shouldn't, and
nothing beyond that. Run it somewhere you control, and don't put more in these
wallets than you are trading.

**Back up `data/vault.json`, `data/wallets.json` and `data/vault.key` together.**
Any one of them is useless without the others, and there is no recovery path if
the key file is lost.

### Starting over

**Settings → 🧨 Factory reset** deletes the vault, every private key, the seed
phrase, every label and group, and the trade history — then drops back to the
first-run state so `/start` builds a new vault from scratch.

Before it does anything it shows you what you are about to destroy, including
**the live SOL balance held across those wallets**, because that is the one fact
that should stop a reset that is about to burn real money. Sweep or export first.
Confirming means typing `RESET EVERYTHING` exactly — a button is too easy to
press by accident.

A reset creates the replacement vault immediately, so the bot is usable again
the moment it finishes — there is nothing to set up and nothing to remember.

### Wallets from the multi-chain version

This bot handled EVM chains before it became Solana-only, and a `wallets.json`
written back then still carries those records. They are **kept, not deleted** —
the addresses may still hold funds. Nothing here can sign with one, so they are
hidden from every screen except **Settings → 📦 Export legacy keys**, which only
appears when there are any. From there you can download the private keys as a
file, import them wherever they belong, and then delete them for good.

A factory reset takes them too, and says so before it does.

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
- `smoke` — 144 offline assertions: vault crypto (round-trip, unique IVs, tamper
  rejection, dropping a passphrase without losing a key, a key file that is
  wrong or missing being refused loudly, and a vault that opens itself at boot),
  wallet
  derivation, group and main-wallet invariants, bonding curve maths and batch
  simulation, funding arithmetic (shortfall-only top-ups, transaction packing,
  refusing a plan the main wallet can't afford, skipping wallets that cannot
  cover a buy), token account parsing, P&L arithmetic (banked profit, a position
  worth zero, and no divide-by-zero without a cost basis), factory reset (files
  removed from disk, fresh setup possible afterwards), legacy wallet records
  (hidden from trading, preserved across unrelated writes, exportable, deleted
  only on request), copy-trade sizing and the screens that configure it (driven
  through a stub context, so a screen that throws while building its text is
  caught here rather than in Telegram), a check that every button the keyboards
  emit reaches a route — a dead button looks exactly like a slow one — address
  parsing, concurrency helpers, log redaction
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
| `/portfolio` | Balances across every wallet |
| `/positions` | Open positions and P&L |
| `/wallets` | Wallet management |
| `/copy` | Copy trading |
| `/funds` | Fund wallets or sweep back |
| `/settings` | Slippage, fees, presets |
| `/history` | Recent batch operations |
| `/help` | Command list |

Every command also appears behind the **Menu** button beside the message box —
Telegram builds that from the bot's registered command list.

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
    copytrade.ts       mirroring another wallet's entries and exits
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
