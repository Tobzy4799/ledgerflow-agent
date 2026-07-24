# Ledgerflow Agent

Backend scripts powering Ledgerflow's autonomous agents; the Guardian, price-keeper, Conditional Agents watcher, and Nanopayments seller endpoint.

Part of the [Ledgerflow](https://github.com/Tobzy4799/ledgerflow) project — built for the Arc Hackathon, **DeFi Track** and **Agentic Economy Track**.

## Scripts

| Script | Purpose |
|---|---|
| `guardian-loop.ts` | Watches every borrower's collateral ratio continuously; warns at 70% utilization, autonomously repays debt at 75% via a Circle Developer-Controlled Wallet, generates a plain-language AI explanation for each action, pays its own operating fee via Nanopayments |
| `price-keeper.ts` | Fetches live BTC/USD and EUR/USD rates and pushes them onchain whenever they drift meaningfully, keeping collateral valuation and swap pricing accurate |
| `conditional-agent-loop.ts` | Watches all active user-defined price-triggered trading rules; executes a swap via a dedicated Circle Developer-Controlled Wallet when a condition is met, waits for real on-chain confirmation, then deactivates (one-time "order" semantics, whether it succeeds or fails) |
| `seller.ts` | Express server exposing the paywalled endpoints the Executor and Guardian pay to use, via Circle's Gateway/Nanopayments |
| `conditional-agents-routes.ts` | AI parsing and CRUD routes for Conditional Agents, mounted into `seller.ts` |
| `registry.ts` | Supabase-backed borrower registry with live WebSocket event watching, used by the Guardian |
| `cctp-hook-burn.ts` / `cctp-hook-mint.ts` | Scripts used to manually verify real, live CCTP V2 burn → attestation → mint flows during development |
| `create-guardian-wallet.ts` / `create-conditional-agent-wallet.ts` | One-time setup scripts for creating the two separate Circle Developer-Controlled Wallets used by Guardian and Conditional Agents respectively (kept independent so neither can silently affect the other's spending limits) |

## Setup

```bash
npm install
```

Create a `.env` with (see individual scripts for the full list): Circle API credentials, Supabase credentials, OpenAI API key, RPC URLs, deployed contract addresses, and both wallet IDs/addresses.

Run whichever agent you need:
```bash
npx tsx --env-file=.env guardian-loop.ts
npx tsx --env-file=.env price-keeper.ts
npx tsx --env-file=.env conditional-agent-loop.ts
npx tsx --env-file=.env seller.ts
```

## Note on running these in production

These currently run as local scripts during development and testing — they've proven fully resilient (each wraps its per-cycle logic in error handling so one failed check never stops the loop), but for a real always-on deployment they'd need to run on persistent infrastructure (a cloud VM or managed service with auto-restart), not a local terminal.

## Why two separate agent wallets

Guardian and Conditional Agents each use their own dedicated Circle Developer-Controlled Wallet, with independent `AgentAuth` authorizations. Earlier testing found that sharing one wallet meant re-authorizing one agent could silently overwrite the other's spending limits — a real bug we caught and fixed by fully separating them.
