# @pokertools/admin

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-≥24.0.0-339933?logo=node.js)](https://nodejs.org)
[![npm](https://img.shields.io/badge/npm-≥10.0.0-CB3837?logo=npm)](https://www.npmjs.com/)

The **Admin Service** is the financial backbone of the PokerTools platform. It handles off-chain fund aggregation ("sweeping"), processes user withdrawals with admin approval via Telegram, and monitors blockchain health.

## 🏗️ Architecture

The service sits between the Blockchain, the Database, and the Admin (via Telegram).

```
┌──────────────────────────────────────────────────────────────────┐
│                      Blockchain (L1/L2)                          │
│                                                                  │
│   [User Wallets] ───> [BatchSweeper Contract] ───> [Hot Wallet]  │
│    (Permit/Transfer)    (Batch Tx)                               │
└──────────▲──────────────────▲───────────────────▲────────────────┘
           │                  │                   │
           │                  │ Execute           │ Broadcast
           │                  │ Sweep             │ Withdrawal Tx
┌──────────┼──────────────────┼───────────────────┼────────────────┐
│          │             Admin Service            │                │
│          │                                      │                │
│          │   ┌───────────────┐   ┌──────────────┴──────────┐     │
│          └───│   Sweeper     │   │    Withdrawal Bot       │     │
│              │   Service     │   │  (Telegram callback)    │     │
│              └───────┬───────┘   └──────┬────────┬────────┘     │
│                      │                  │        │               │
│              ┌───────┴───────┐          │        │               │
│              │BlockchainSvc  │          │        │               │
│              │(HD wallet,    │          │        │               │
│              │ nonce coord)  │          │        │               │
│              └───────────────┘          │        │               │
│                                         ▼        ▼               │
│                              ┌──────────────┐ ┌──────────┐       │
│                              │  PostgreSQL  │ │  Redis   │       │
│                              │  / SQLite    │ │          │       │
│                              └──────────────┘ └──────────┘       │
│                                                                  │
│   ┌──────────┐  ┌──────────────────┐                             │
│   │  Gas     │  │  Transaction     │──── Telegram Admin Chat ────│─>
│   │  Monitor │  │  Monitor         │                             │
│   └──────────┘  └──────────────────┘                             │
└──────────────────────────────────────────────────────────────────┘
```

## 🧩 Key Components

### 1. Sweeper Service (`SweeperService.ts`)

Automatically aggregates funds from thousands of temporary deposit addresses into the central **Hot Wallet**.

- **Gasless for Users**: Uses [EIP-2612 Permit](https://eips.ethereum.org/EIPS/eip-2612) signatures so the Hot Wallet pays all gas fees.
- **Batched Transactions**: Uses a custom `BatchSweeper` smart contract to aggregate up to 20 wallets in a single transaction, significantly reducing gas costs.
- **Wait-and-Sweep**: Only sweeps when gas prices are below a configured threshold (`MAX_GAS_PRICE_GWEI`). Runs every 10 minutes.
- **Paginated**: Scans all user wallets in cursor-based pages, not just a fixed prefix.

### 2. Withdrawal Bot (`WithdrawalBot.ts`)

A Telegram bot that acts as a security gatekeeper for outgoing funds.

- **Workflow**:
  1. User requests withdrawal via the API (`POST /user/withdraw`).
  2. The API debits the user's MAIN account and creates a `PaymentTransaction` in `AWAITING_BROADCAST` state in a single DB transaction.
  3. The withdrawal bot polls the database for withdrawals in `AWAITING_BROADCAST` state (using `prisma.paymentTransaction.findFirst`) and sends a Telegram approval request to admins with inline **Approve** / **Reject** buttons.
  4. On approval, the bot broadcasts the ERC-20 transfer from the hot wallet.
- **Security Checks**: Verifies nonce/timestamp withdrawal signatures at both queue time and approval time, checks daily withdrawal limits, uses Redis `SET NX EX` to prevent double-approval, and employs a circuit breaker for RPC resilience.
- **Broadcast Safety**: Hot-wallet sends use coordinated nonces via Redis with bounded retry/backoff and circuit-breaker protection so withdrawals and sweeps do not race each other during RPC instability.

### 3. Blockchain Service (`BlockchainService.ts`)

Provides Viem wallet clients, HD-wallet derivation, hot-wallet nonce coordination via Redis, and explorer link generation. Used by all other services.

### 4. Monitors

- **GasMonitor**: Periodically checks gas prices and alerts admins via Telegram when gas crosses `LOW_GAS_THRESHOLD_ETH`.
- **TransactionMonitor**: Watches for stuck transactions and handles replacement/speed-ups.

## 📄 Smart Contracts

### `BatchSweeper.sol`

A specialized contract deployed on each supported chain.

- **Function**: `batchSweep(token, owners, amounts, deadlines, v, r, s)`
- **Logic**: Iterates through the provided arrays, calls `permit()` on the token for each user, and then `transferFrom()` to collect funds.
- **Safety**: Funds are hardcoded to be sent to `msg.sender` (the Hot Wallet caller) to prevent redirection attacks.

## 🛠️ Setup & Configuration

### Prerequisites

- Node.js ≥ 24.0.0, npm ≥ 10.0.0
- Redis server
- PostgreSQL (production) or SQLite (development) — shares the same database as `@pokertools/api`
- Foundry (for smart-contract compilation)
- A Telegram bot token and admin chat ID
- A BIP-39 mnemonic for the HD hot wallet

### Environment Variables

The service validates configuration at startup with `envalid`. Required secrets are rejected immediately.

```bash
# ── Environment ──────────────────────────────────────
NODE_ENV=production                       # development | production | test
LOG_LEVEL=info                            # debug | info | warn | error

# ── Infrastructure ───────────────────────────────────
DATABASE_URL="postgresql://user:pass@localhost:5432/poker"
# Or for local SQLite: DATABASE_URL="file:../.runtime/app.db"
REDIS_URL="redis://localhost:6379"

# ── Wallet / Keys ────────────────────────────────────
MASTER_MNEMONIC="word1 word2 … word12"   # BIP-39 mnemonic for HD wallet
HOT_WALLET_DERIVATION_PATH="m/44'/60'/0'/0/0"  # default: m/44'/60'/0'/0/0

# ── Smart Contracts (deployed addresses per chain) ───
BATCH_SWEEPER_ADDRESS_MAINNET="0x…"
BATCH_SWEEPER_ADDRESS_POLYGON="0x…"
BATCH_SWEEPER_ADDRESS_LOCAL="0x…"       # for local Anvil/E2E tests

# ── Telegram ─────────────────────────────────────────
TELEGRAM_BOT_TOKEN="123456:ABC-…"       # required
TELEGRAM_ADMIN_CHAT_ID="-100…"          # required

# ── Operational Thresholds ───────────────────────────
MAX_GAS_PRICE_GWEI=50                   # skip sweeps above this price
MIN_SWEEP_VALUE_RAW_UNITS=10            # smallest balance to sweep
LOW_GAS_THRESHOLD_ETH=0.1               # alert threshold for gas monitor

# ── RPC Resilience ───────────────────────────────────
RPC_RETRY_COUNT=3                       # default: 3
RPC_RETRY_DELAY_MS=1000                 # default: 1000
RPC_TIMEOUT_MS=10000                    # default: 10_000
CIRCUIT_BREAKER_FAILURE_THRESHOLD=5     # default: 5
CIRCUIT_BREAKER_OPEN_MS=30000           # default: 30_000
WITHDRAWAL_SIGNATURE_MAX_AGE_MS=300000  # default: 5 minutes

# ── Security ─────────────────────────────────────────
JWT_SECRET="…"                          # required
WALLET_ENCRYPTION_SECRET="…"            # required; MUST differ from JWT_SECRET

# ── Velocity / Risk Limits ───────────────────────────
MAX_SINGLE_WITHDRAWAL_USD=5000          # default: 5000
MAX_DAILY_WITHDRAWAL_USD=50000          # default: 50000
```

> The admin service shares the Prisma schema and generated client with `@pokertools/api`. It reads blockchain metadata (RPC URLs, contract addresses, confirmation requirements) from the `Blockchain` / `Token` database tables — these are **not** configured via environment variables.

### Installation

```bash
# From the monorepo root
npm install

# Or from the admin package
cd packages/admin && npm install

# Compile Solidity contracts
npm run contracts:build

# Generate Prisma client (shares schema with @pokertools/api)
npm run db:prepare
```

## 🚀 Usage

### Development

Start the service in watch mode:

```bash
npm run dev
```

### Production

Build and run the compiled output (single process runs sweeper cron, withdrawal bot, gas monitor, and transaction monitor):

```bash
npm run build
npm start
```

### Scripts

| Script                    | Description                                     |
| ------------------------- | ----------------------------------------------- |
| `npm run dev`             | Watch-mode TypeScript via tsx                   |
| `npm run build`           | TypeScript compilation                          |
| `npm start`               | Run compiled entrypoint                         |
| `npm run contracts:build` | Compile Solidity with Foundry                   |
| `npm run contracts:test`  | Run Foundry unit tests                          |
| `npm test`                | Full E2E test (Anvil + game + sweep + withdraw) |
| `npm run typecheck`       | TypeScript type checking (no emit)              |
| `npm run lint`            | ESLint                                          |

### Testing

The E2E test suite spins up a local Anvil chain, deploys contracts, simulates user deposits, plays a complete game, sweeps funds, and processes a withdrawal.

```bash
npm test
```

For standalone testing (spins up its own Redis):

```bash
npm run test:stand-alone
```

## 🔒 Security

> See also the root [SECURITY.md](../../SECURITY.md) for the complete security policy, deployment checklist, and cryptographic guidance.

### Resilience

The admin service uses a **circuit breaker** (configurable via `CIRCUIT_BREAKER_FAILURE_THRESHOLD` and `CIRCUIT_BREAKER_OPEN_MS`) to protect against cascading failures during RPC instability. Both the sweeper and withdrawal bot run blockchain writes through `withRetry()`, which backs off exponentially and respects the open-circuit state.

```typescript
import { CircuitBreaker, withRetry } from "./utils/resilience.js";

const breaker = new CircuitBreaker("sweep-broadcast");
const hash = await withRetry(() => client.writeContract(…), breaker);
```

### Key Security Practices

- **Signature nonce/timestamp**: Withdrawals require a wallet-signed message containing a unique nonce and a recent timestamp (validated at request time by the API and again at approval time by the bot). Messages older than `WITHDRAWAL_SIGNATURE_MAX_AGE_MS` are rejected.
- **Nonce Coordination**: Hot-wallet transaction nonces are obtained through Redis to prevent races between sweeps and withdrawals within a single-chain process.
- **Distributed Button Lock**: Telegram callback processing uses Redis `SET NX EX` to prevent double-approval from rapid clicking.
- **Failure Reconciliation**: Reverted withdrawal transactions are marked `FAILED` and refunded via an auditable `REFUND` ledger entry (created atomically within a database transaction).
- **Separated Secrets**: `WALLET_ENCRYPTION_SECRET` must be set independently from `JWT_SECRET`. Wallet encryption must never reuse auth-signing secrets.
- **Sweeping Coverage**: The sweeper paginates through all user wallets in cursor-based pages of 100, processing every wallet — not just a fixed first page.
- **Gas Awareness**: Sweeps are skipped when `getGasPrice()` exceeds `MAX_GAS_PRICE_GWEI`. The `GasMonitor` alerts the admin chat when gas crosses `LOW_GAS_THRESHOLD_ETH`.

### Operational Notes

- The admin service connects to the **same database** as `@pokertools/api` and shares its Prisma client (imported from `packages/api/generated/prisma`). Both services must run against the same database instance.
- Blockchain RPC URLs are managed in the `Blockchain` database table (seeded), not as environment variables.
- The `MASTER_MNEMONIC` may also be loaded from a Docker secret file via `MASTER_MNEMONIC_FILE`.
- The `BATCH_SWEEPER_ADDRESS_LOCAL` variable serves the chain ID `31337` (Anvil) and is only needed for E2E testing.

---

Made with ♥ for the Poker Community.
