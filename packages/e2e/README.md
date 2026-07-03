# 🃏 @pokertools/e2e

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-≥24.0.0-339933?logo=node.js)](https://nodejs.org)

## Table of Contents

- [Overview](#-overview)
- [Prerequisites](#prerequisites)
- [Quick Start](#quick-start)
- [What the Tests Cover](#what-the-tests-cover)
- [Architecture](#architecture)
- [Manual Usage](#manual-usage)
- [Test Secrets](#test-secrets)
- [Environment Variables](#environment-variables)
- [Related Packages](#-related-packages)
- [License](#-license)

## 🎯 Overview

Docker-based end-to-end integration tests that exercise the full PokerTools stack: API, SDK, WebSocket real-time engine, and blockchain deposit/withdrawal lifecycle. The test suite spins up a local Anvil chain, deploys ERC-20 and BatchSweeper contracts, builds and runs the full Docker Compose stack (API + Redis + Worker), seeds the SQLite database, then runs a comprehensive suite covering authentication, deposits, game logic, tournaments, and withdrawals — all against real infrastructure with no mocks.

## Prerequisites

- **Docker** (with Docker Compose v2)
- **Foundry** (`anvil` available on PATH)
- **Node.js** >= 24.0.0, **npm** >= 10.0.0

## Quick Start

```bash
# From the monorepo root:
npm run e2e:docker
```

This will:

1. Build Solidity contracts (`forge build` in `packages/admin` if needed)
2. Build `@pokertools/types` and `@pokertools/sdk` TypeScript packages (via `pretest:docker`)
3. Start a local Anvil chain (port 8545)
4. Deploy MockUSDC and BatchSweeper contracts
5. Build the API Docker image and start the full stack (API + Redis + Worker)
6. Seed the SQLite database with blockchain/token/admin-wallet data
7. Run the full integration test suite
8. Clean up all containers, volumes, and temporary files

## What the Tests Cover

| Area                | Tests                                                                                                                                                                                                                                                                                  |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Health & Docs**   | `GET /health`, `GET /docs`, `GET /finance/chains`                                                                                                                                                                                                                                      |
| **Authentication**  | `POST /auth/nonce`, `POST /auth/login` (SIWE flow for 3 players), `POST /auth/logout`                                                                                                                                                                                                  |
| **User**            | `GET /user/me`, `GET /user/history`                                                                                                                                                                                                                                                    |
| **Deposits**        | `POST /finance/deposit/start`, `GET /finance/deposit/address`, `GET /finance/deposits`, real on-chain USDC transfer (mint → transfer → anvil mine → deposit monitor poll → credit verification)                                                                                        |
| **Tournaments**     | 30-player multi-table tournament: creation, registration, start with 8/8/7/7 table distribution, director reconciliation, elimination tracking, multi-step table merging, settlement with prize verification, and full ledger conservation check (260+ lines of test logic)            |
| **Table Lifecycle** | `POST /tables`, `GET /tables`, `GET /tables/:id`, three-player buy-ins, SDK-backed WebSocket sync (join, snapshot, stateUpdate via DEAL action), real `actionTo` deterministic gameplay (fold loop), stack change verification, `POST /tables/:id/add-chips`, `POST /tables/:id/stand` |
| **Withdrawals**     | `POST /user/withdraw` (signed message), `GET /user/withdrawals`, DB outbox verification (PaymentTransaction row), simulated admin approval via on-chain USDC transfer to destination address, and final PaymentTransaction status confirmation                                         |

## Architecture

```
Host                            Docker
────                            ──────
Anvil :8545  ←───────────────  API :3000  (RPC via host.docker.internal)
Test process (vitest)          Redis :6380 (mapped to host port)
    │                          Worker (deposit monitor, game workers)
    ├─ HTTP calls ──────────→  API :3000
    ├─ viem (127.0.0.1:8545) → Anvil
    ├─ WebSocket ────────────→ API :3000
    └─ SQLite (host bind-mount) ↔ /app/packages/api/.runtime/e2e.db
```

- The shared SQLite database is bind-mounted from a host temp directory (`POKERTOOLS_E2E_RUNTIME`, defaults to `./pokertools-e2e-runtime`).
- The API and Worker containers use `host.docker.internal:8545` to reach Anvil on the host.
- The test process uses `127.0.0.1:8545` directly.
- Redis is mapped to host port `6380` to avoid conflicts with local dev (default `6379`).
- All secrets are deterministic, local-only test values.

## Manual Usage

```bash
# Build prerequisites
npm run pretest:docker -w @pokertools/e2e

# Start the stack manually
POKERTOOLS_E2E_RUNTIME=/tmp/pokertools-e2e docker compose -f docker-compose.e2e.yml up --build -d

# Run only the tests (requires stack already running)
npx vitest run --config packages/e2e/vitest.config.ts

# Stop and clean up
POKERTOOLS_E2E_RUNTIME=/tmp/pokertools-e2e docker compose -f docker-compose.e2e.yml down -v
```

## Test Secrets

All secrets used in this E2E test are deterministic, local-only values never used in production:

- **JWT Secret:** `e2e-jwt-secret-not-for-production`
- **Cookie Secret:** `e2e-cookie-secret-not-for-production`
- **Wallet Encryption Secret:** `e2e-wallet-encryption-secret-for-tests-only`
- **Wallet Xpriv Encryption Secret:** `e2e-wallet-xpriv-encryption-secret-for-tests-only`
- **Mnemonic:** `test test test test test test test test test test test junk` (standard Anvil test mnemonic)

## Environment Variables

| Variable                 | Default                                | Description                                         |
| ------------------------ | -------------------------------------- | --------------------------------------------------- |
| `POKERTOOLS_E2E_RUNTIME` | `./pokertools-e2e-runtime`             | Host directory for the shared SQLite DB bind-mount. |
| `POKERTOOLS_API_BASE`    | `http://localhost:3000` (test process) | API base URL for HTTP requests.                     |
| `POKERTOOLS_TOKEN`       | —                                      | JWT for authenticated scenarios (optional).         |
| `POKERTOOLS_TABLE_ID`    | —                                      | Table ID for live gameplay scenarios (optional).    |

## 🔗 Related Packages

| Package                       | Description                       |
| ----------------------------- | --------------------------------- |
| [@pokertools/api](../api)     | REST/WebSocket API                |
| [@pokertools/sdk](../sdk)     | TypeScript SDK with React hooks   |
| [@pokertools/admin](../admin) | Blockchain administration service |

## 📄 License

MIT © A.Aurelius
