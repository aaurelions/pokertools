# @pokertools/e2e — Docker End-to-End Tests

Docker-based integration tests that exercise the full PokerTools API + blockchain stack.

## Prerequisites

- **Docker** (with Docker Compose v2)
- **Foundry** (`anvil` available on PATH)
- **Node.js** >= 24, **npm** >= 10

## Quick Start

```bash
# From the monorepo root:
npm run e2e:docker
```

This will:

1. Build Solidity contracts (`forge build` in `packages/admin` if needed)
2. Start a local Anvil chain (port 8545)
3. Deploy MockUSDC and BatchSweeper contracts
4. Build the API Docker image and start the full stack (API + Redis + Worker)
5. Seed the SQLite database with blockchain/token/admin-wallet data
6. Run the full integration test suite
7. Clean up all containers, volumes, and temporary files

## What the Tests Cover

| Area                | Tests                                                                                                                                                                                                      |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Health & Docs**   | `GET /health`, `GET /docs`, `GET /finance/chains`                                                                                                                                                          |
| **Authentication**  | `POST /auth/nonce`, `POST /auth/login` (SIWE), `POST /auth/logout`                                                                                                                                         |
| **User**            | `GET /user/me`, `GET /user/history`                                                                                                                                                                        |
| **Deposits**        | `POST /finance/deposit/start`, `GET /finance/deposit/address`, `GET /finance/deposits`, real on-chain USDC transfer + deposit monitor                                                                      |
| **Table Lifecycle** | `POST /tables`, `GET /tables`, `GET /tables/:id`, three-player buy-ins, SDK-backed WebSocket sync, real `actionTo` gameplay, winnings verification, `POST /tables/:id/add-chips`, `POST /tables/:id/stand` |
| **Withdrawals**     | `POST /user/withdraw` (signed message), `GET /user/withdrawals`, DB outbox verification, on-chain transfer simulation                                                                                      |

## Architecture

```
Host                          Docker
────                          ──────
Anvil :8545  ←─────────────  API :3000  (RPC via host.docker.internal)
Test process                 Redis :6380
  │                          Worker (deposit monitor, game workers)
  ├─ HTTP calls ──────────→  API :3000
  ├─ viem (127.0.0.1:8545) → Anvil
  └─ SQLite (host bind-mount) ↔ /app/packages/api/.runtime/e2e.db
```

- The shared SQLite database is bind-mounted from a host temp directory (`POKERTOOLS_E2E_RUNTIME`).
- The API container uses `host.docker.internal:8545` to reach Anvil on the host.
- The test process uses `127.0.0.1:8545` directly.
- Redis is mapped to host port `6380` to avoid conflicts with local dev.
- All secrets are deterministic, local-only test values.

## Manual Usage

```bash
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
- **Wallet Encryption Secret:** `e2e-wallet-encryption-secret-for-tests-only`
- **Mnemonic:** `test test test test test test test test test test test junk` (standard Anvil test mnemonic)
