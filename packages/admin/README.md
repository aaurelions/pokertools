# @pokertools/admin

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0-blue.svg)](https://www.typescriptlang.org/)
[![Foundry](https://img.shields.io/badge/Foundry-0.2.0-orange.svg)](https://getfoundry.sh/)

The **Admin Service** is the financial backbone of the PokerTools platform. It handles off-chain fund aggregation ("sweeping"), processes user withdrawals with manual admin approval, and monitors blockchain health.

## 🏗️ Architecture

The service sits between the Blockchain, the Database, and the Admin (via Telegram).

```
┌──────────────────────────────────────────────────────────────────┐
│                      Blockchain (L1/L2)                          │
│                                                                  │
│   [User Wallets] ───> [BatchSweeper] ───> [Hot Wallet]           │
│    (Permit/Transfer)    (Batch Tx)                               │
└──────────▲──────────────────▲───────────────────▲────────────────┘
           │                  │                   │
           │                  │ Execute           │ Approve
           │                  │ Sweep             │ Withdrawal
┌──────────┼──────────────────┼───────────────────┼────────────────┐
│          │             Admin Service            │                │
│          │                  │                   │                │
│          │         ┌────────┴────────┐   ┌──────┴─────────┐      │
│          └──────── │ Sweeper Service │   │ Withdrawal Bot │      │
│                    └────────┬────────┘   └──────┬────┬────┘      │
│                             │                   │    │           │
│                             ▼                   │    │           │
│                      [(PostgreSQL)] ◄───────────┘    │           │
│                                                      │           │
│                                         [(Redis)] ◄──┘           │
│                                                                  │
│                       [Monitors] ──────────────────────┐         │
└────────────────────────────────────────────────────────┼─────────┘
                                                         │
                                                         ▼
                                               [Telegram Admin Chat]
```

## 🧩 Key Components

### 1. Sweeper Service (`SweeperService.ts`)

Automatically aggregates funds from thousands of temporary deposit addresses into the central **Hot Wallet**.

- **Gasless for Users**: Uses [EIP-2612 Permit](https://eips.ethereum.org/EIPS/eip-2612) signatures so the Hot Wallet pays all gas fees.
- **Batched Transactions**: Uses a custom `BatchSweeper` smart contract to aggregate up to 20 wallets in a single transaction, significantly reducing gas costs.
- **Wait-and-Sweep**: Only sweeps when gas prices are below a configured threshold (`MAX_GAS_PRICE_GWEI`).

### 2. Withdrawal Bot (`WithdrawalBot.ts`)

A Telegram bot that acts as a security gatekeeper for outgoing funds.

- **Workflow**:
  1. User requests withdrawal via API.
  2. Request is queued in Redis.
  3. Bot notifies the admin channel with details (User, Amount, Risk Score).
  4. Admin clicks **Approve** or **Reject** inline button.
  5. If approved, the bot triggers the Hot Wallet to send funds.
- **Security Checks**: Verifies nonce/timestamp withdrawal signatures, checks daily withdrawal limits, and processes the DB-backed withdrawal outbox created atomically by the API.

### 3. Monitors

- **GasMonitor**: Alerts admins if gas prices spike, potentially delaying sweeps.
- **TransactionMonitor**: Watches for stuck transactions and handles replacement/speed-ups.

## 📄 Smart Contracts

### `BatchSweeper.sol`

A specialized contract deployed on each supported chain.

- **Function**: `batchSweep(token, owners, amounts, deadlines, v, r, s)`
- **Logic**: Iterates through the provided arrays, calls `permit()` on the token for each user, and then `transferFrom()` to collect funds.
- **Safety**: Funds are hardcoded to be sent to `msg.sender` (the Hot Wallet caller) to prevent redirection attacks.

## 🛠️ Setup & Configuration

### Prerequisites

- Node.js v20+
- Foundry (for contract compilation)
- PostgreSQL & Redis
- Telegram Bot Token

### Environment Variables

Ensure these are set in your `.env`:

```bash
# Infrastructure
DATABASE_URL="postgresql://..."
REDIS_URL="redis://..."

# Blockchain
MAINNET_RPC_URL="https://..."
POLYGON_RPC_URL="https://..."
MASTER_MNEMONIC="word1 word2 ..."
HOT_WALLET_DERIVATION_PATH="m/44'/60'/0'/0"

# Bot
TELEGRAM_BOT_TOKEN="123456:ABC-..."
TELEGRAM_ADMIN_CHAT_ID="-100..."

# Configuration
MAX_GAS_PRICE_GWEI=50
MAX_SINGLE_WITHDRAWAL_USD=1000
MAX_DAILY_WITHDRAWAL_USD=10000
```

### Installation

```bash
# Install dependencies
npm install

# Build TypeScript
npm run build

# Compile Contracts
npm run contracts:build
```

## 🚀 Usage

### Development

Start the service in watch mode:

```bash
npm run dev
```

### Production

Build and run the compiled output:

```bash
npm run build
npm start
```

### Testing

Run the comprehensive End-to-End (E2E) test suite. This spins up a local Anvil chain, deploys contracts, simulates user deposits, plays a game, sweeps funds, and processes a withdrawal.

```bash
npm test
```

## 🔒 Security

- **Cold Storage**: The Hot Wallet should only hold enough funds for daily withdrawals. The Sweeper can be configured to forward excess funds to a Cold Wallet (Multisig).
- **Rate Limiting**: The Withdrawal Bot enforces strict daily and per-transaction limits.
- **Signature Verification**: All withdrawals require a valid signature from the user's wallet to prevent replay or impersonation attacks.
- **Separated Secrets**: Set `WALLET_ENCRYPTION_SECRET` separately from `JWT_SECRET`; wallet encryption must never reuse auth signing secrets.
- **Sweeping Coverage**: Wallet sweeping paginates through all user wallets instead of only a fixed first page.

---

Made with ♥ for the Poker Community.
