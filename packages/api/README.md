# 🃏 @pokertools/api

> Production-ready REST/WebSocket API for real-time poker games with blockchain payments

[![Node.js](https://img.shields.io/badge/Node.js-≥24.0.0-339933?logo=node.js)](https://nodejs.org)
[![Fastify](https://img.shields.io/badge/Fastify-5.x-000000?logo=fastify)](https://fastify.dev)
[![Redis](https://img.shields.io/badge/Redis-ioredis-DC382D?logo=redis)](https://redis.io)
[![License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

## 📋 Table of Contents

- [Overview](#-overview)
- [Architecture](#-architecture)
- [Quick Start](#-quick-start)
- [Configuration](#-configuration)
- [API Reference](#-api-reference)
- [WebSocket Protocol](#-websocket-protocol)
- [Services](#-services)
- [Background Workers](#-background-workers)
- [Database Schema](#-database-schema)
- [Authentication](#-authentication)
- [Financial System](#-financial-system)
- [Blockchain Integration](#-blockchain-integration)
- [Error Handling](#-error-handling)
- [Testing](#-testing)
- [Deployment](#-deployment)

---

## 🎯 Overview

`@pokertools/api` is a complete backend solution for running real-time poker games. It wraps `@pokertools/engine` with a production-grade infrastructure layer.

### ✨ Key Features

| Feature                    | Description                                   |
| -------------------------- | --------------------------------------------- |
| 🔐 **SIWE Auth**           | Sign-In with Ethereum for Web3 authentication |
| ⚡ **Real-time**           | WebSocket state updates with Redis Pub/Sub    |
| 💰 **Double-Entry Ledger** | GAAP-compliant financial tracking             |
| 🔒 **Distributed Locks**   | Redlock for multi-instance safety             |
| 📊 **Job Queues**          | BullMQ for async processing                   |
| 🔗 **Blockchain**          | HD wallet deposits & withdrawals              |
| 📜 **Hand History**        | Full audit trail of all games                 |
| 🩺 **Observability**       | Health checks, Prometheus metrics, audit logs |
| 🛡️ **Risk Controls**       | Velocity checks and durable idempotency       |

---

## 🏗 Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                            CLIENT LAYER                                 │
│                                                                         │
│   ┌─────────────┐    ┌─────────────┐    ┌─────────────────────────┐     │
│   │   Web App   │    │  Mobile App │    │   Third-Party Clients   │     │
│   └──────┬──────┘    └──────┬──────┘    └───────────┬─────────────┘     │
│          │                  │                       │                   │
└──────────┼──────────────────┼───────────────────────┼───────────────────┘
           │                  │                       │
           ▼                  ▼                       ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                          FASTIFY SERVER                                 │
│                                                                         │
│   ┌────────────────────────────────────────────────────────────────┐    │
│   │                         ROUTES                                 │    │
│   │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐           │    │
│   │  │  /auth   │ │ /tables  │ │  /user   │ │/finance  │           │    │
│   │  └────┬─────┘ └────┬─────┘ └────┬─────┘ └────┬─────┘           │    │
│   │       │            │            │            │                 │    │
│   │  ┌────┴────────────┴────────────┴────────────┴────┐            │    │
│   │  │                WebSocket /ws                   │            │    │
│   │  └─────────────────────┬──────────────────────────┘            │    │
│   └────────────────────────┼───────────────────────────────────────┘    │
│                            │                                            │
│   ┌────────────────────────┼───────────────────────────────────────┐    │
│   │                     SERVICES                                   │    │
│   │  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐               │    │
│   │  │ GameManager │ │  Financial  │ │  Socket     │               │    │
│   │  │             │ │  Manager    │ │  Manager    │               │    │
│   │  └──────┬──────┘ └──────┬──────┘ └──────┬──────┘               │    │
│   │         │               │               │                      │    │
│   │  ┌──────┴───────────────┴───────────────┴──────┐               │    │
│   │  │              @pokertools/engine             │               │    │
│   │  └─────────────────────────────────────────────┘               │    │
│   └────────────────────────────────────────────────────────────────┘    │
│                                                                         │
└──────────┬──────────────────┬───────────────────────┬───────────────────┘
           │                  │                       │
           ▼                  ▼                       ▼
┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐
│      Redis       │  │    PostgreSQL    │  │    BullMQ        │
│  ┌────────────┐  │  │  ┌────────────┐  │  │  ┌────────────┐  │
│  │ Hot State  │  │  │  │   Users    │  │  │  │ settle-hand│  │
│  │ (TTL 24h)  │  │  │  │   Ledger   │  │  │  │ archive    │  │
│  ├────────────┤  │  │  │   Tables   │  │  │  │ timeout    │  │
│  │  Pub/Sub   │  │  │  │   History  │  │  │  │ next-hand  │  │
│  ├────────────┤  │  │  │   Payments │  │  │  │ deposit    │  │
│  │   Locks    │  │  │  └────────────┘  │  │  └────────────┘  │
│  └────────────┘  │  │                  │  │                  │
└──────────────────┘  └──────────────────┘  └──────────────────┘
```

---

## 🚀 Quick Start

### Prerequisites

- Node.js ≥ 24.0.0
- Redis server
- PostgreSQL (production) or SQLite (development)

### Installation

```bash
# Clone and install
git clone https://github.com/aaurelions/pokertools.git
cd pokertools
npm install

# Navigate to API package
cd packages/api
```

### Environment Setup

Create `.env` file:

```bash
# Server
NODE_ENV=development
PORT=3000
HOST=0.0.0.0

# Database
DATABASE_URL="postgresql://user:pass@localhost:5432/poker"
# Or for development: DATABASE_URL="file:./.runtime/dev.db"

# Redis
REDIS_URL="redis://localhost:6379"

# Security
JWT_SECRET="your-256-bit-secret-key-here"
COOKIE_SECRET="your-cookie-secret-here"
WALLET_ENCRYPTION_SECRET="separate-256-bit-wallet-encryption-secret"
CORS_ORIGIN="https://your-poker-room.example"

# Logging
LOG_LEVEL="info"

# Blockchain (optional)
RPC_RETRY_COUNT=3
RPC_RETRY_DELAY=1000
RPC_TIMEOUT=10000
```

### Database Setup

```bash
# Generate Prisma client. The Prisma config derives the provider from
# DATABASE_URL and emits a runtime schema under .runtime/schema.<provider>.prisma.
npm run db:generate

# Run migrations (development)
npm run db:migrate

# Seed database (creates HOUSE user)
npm run db:seed
```

When `DATABASE_URL` starts with `postgresql://` or `postgres://`, the API uses `@prisma/adapter-pg`; `file:` URLs use the SQLite adapter for local tests. Generate/build with the same datasource family you deploy with so the Prisma client provider matches the runtime adapter. For PostgreSQL production deployments, run `prisma migrate deploy` after ensuring migration history is complete.

WebSocket clients authenticate without URL query tokens. Browser SDK clients send the JWT as the `jwt.<token>` WebSocket subprotocol; server-side clients may also rely on the `token` cookie.

### Start Server

```bash
# Development (with hot reload)
npm run dev

# Production
npm run build
npm start

# With workers (separate process)
npm run workers
```

**Server Output:**

```
🃏 @pokertools/api v1.0.12
-------------------------
🌍 Server: http://0.0.0.0:3000
📚 Docs:   http://0.0.0.0:3000/docs
🔌 Redis:  redis://localhost:6379
🐘 DB:     Connected
🎮 Ready to play poker!
```

---

## ⚙️ Configuration

### Environment Variables

| Variable                   | Type     | Default                  | Description                                                                             |
| -------------------------- | -------- | ------------------------ | --------------------------------------------------------------------------------------- |
| `NODE_ENV`                 | `string` | `development`            | Environment mode (`development`, `production`, `test`)                                  |
| `PORT`                     | `number` | `3000`                   | HTTP server port                                                                        |
| `HOST`                     | `string` | `0.0.0.0`                | Bind address                                                                            |
| `DATABASE_URL`             | `string` | **required**             | Prisma database URL (`file:` for SQLite, `postgresql://` for PostgreSQL)                |
| `REDIS_URL`                | `string` | `redis://localhost:6379` | Redis connection                                                                        |
| `JWT_SECRET`               | `string` | **required**             | JWT signing key                                                                         |
| `COOKIE_SECRET`            | `string` | **required**             | Cookie signing key                                                                      |
| `WALLET_ENCRYPTION_SECRET` | `string` | **required**             | Separate key for encrypted wallet material                                              |
| `CORS_ORIGIN`              | `string` | `""`                     | CORS origin; must be set in production (empty = deny cross-origin). Dev/test allow all. |
| `LOG_LEVEL`                | `string` | `info`                   | Pino log level (`debug`, `info`, `warn`, `error`)                                       |
| `RPC_RETRY_COUNT`          | `number` | `3`                      | Blockchain RPC retries                                                                  |
| `RPC_RETRY_DELAY`          | `number` | `1000`                   | Retry delay (ms)                                                                        |
| `RPC_TIMEOUT`              | `number` | `10000`                  | RPC timeout (ms)                                                                        |

### Validation

Configuration is validated at startup using `envalid`:

```typescript
import { cleanEnv, str, num } from "envalid";

export const config = cleanEnv(process.env, {
  NODE_ENV: str({ choices: ["development", "production", "test"] }),
  PORT: num({ default: 3000 }),
  DATABASE_URL: str(),
  REDIS_URL: str({ default: "redis://localhost:6379" }),
  JWT_SECRET: str(),
  COOKIE_SECRET: str(),
  WALLET_ENCRYPTION_SECRET: str(),
  CORS_ORIGIN: str({ default: "" }),
  LOG_LEVEL: str({ default: "info", choices: ["debug", "info", "warn", "error"] }),
});
```

---

## 📡 API Reference

### Authentication

#### `POST /auth/nonce`

Generate SIWE nonce for authentication.

```bash
curl -X POST http://localhost:3000/auth/nonce
```

**Response:**

```json
{
  "nonce": "abc123def456..."
}
```

#### `POST /auth/login`

Authenticate with SIWE signature.

```bash
curl -X POST http://localhost:3000/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "message": "poker.example.com wants you to sign in with your Ethereum account...",
    "signature": "0x..."
  }'
```

**Response:**

```json
{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "user": {
    "id": "clx123abc",
    "username": "player_a1b2c3"
  }
}
```

#### `POST /auth/logout`

Revoke current session.

```bash
curl -X POST http://localhost:3000/auth/logout \
  -H "Authorization: Bearer <token>"
```

---

### Tables

#### `GET /tables`

List active tables.

```bash
curl http://localhost:3000/tables
```

**Response:**

```json
{
  "tables": [
    {
      "id": "clx456def",
      "name": "High Stakes NL Hold'em",
      "config": {
        "smallBlind": 25,
        "bigBlind": 50,
        "maxPlayers": 6
      },
      "status": "ACTIVE"
    }
  ]
}
```

#### `POST /tables`

Create a new table.

```bash
curl -X POST http://localhost:3000/tables \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "My Table",
    "mode": "CASH",
    "smallBlind": 5,
    "bigBlind": 10,
    "maxPlayers": 6,
    "minBuyIn": 200,
    "maxBuyIn": 1000
  }'
```

**Response:**

```json
{
  "tableId": "clx789ghi"
}
```

#### `GET /tables/:id`

Get table state (masked for viewer).

```bash
curl http://localhost:3000/tables/clx789ghi \
  -H "Authorization: Bearer <token>"
```

**Query Parameters:**

- `since` - Version number for conditional fetch (returns 304 if unchanged)

**Response:**

```json
{
  "state": {
    "phase": "PLAYING",
    "street": "FLOP",
    "pot": 150,
    "board": ["Ah", "Kd", "7c"],
    "players": [
      {
        "id": "player1",
        "name": "Alice",
        "stack": 950,
        "bet": 50,
        "cards": ["As", "Ac"] // Only visible to player1
      },
      {
        "id": "player2",
        "name": "Bob",
        "stack": 900,
        "bet": 50,
        "cards": null // Hidden from other players
      }
    ],
    "actionTo": 0,
    "version": 42
  }
}
```

#### `POST /tables/:id/buy-in`

Buy into a table seat.

```bash
curl -X POST http://localhost:3000/tables/clx789ghi/buy-in \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "amount": 500,
    "seat": 3,
    "idempotencyKey": "uuid-123-abc"
  }'
```

**Response:**

```json
{
  "success": true
}
```

#### `POST /tables/:id/action`

Execute a gameplay action.

```bash
curl -X POST http://localhost:3000/tables/clx789ghi/action \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "RAISE",
    "amount": 100
  }'
```

**Allowed Actions:**
| Action | Description | Amount Required |
|--------|-------------|-----------------|
| `BET` | Open betting | ✅ |
| `RAISE` | Raise current bet | ✅ |
| `CALL` | Match current bet | ❌ |
| `CHECK` | Pass action | ❌ |
| `FOLD` | Surrender hand | ❌ |
| `DEAL` | Start new hand | ❌ |
| `SHOW` | Show cards at showdown | ❌ |
| `MUCK` | Hide cards at showdown | ❌ |
| `TIME_BANK` | Use time bank | ❌ |

**Response:**

```json
{
  "state": {
    /* updated game state */
  }
}
```

#### `POST /tables/:id/add-chips`

Add chips to stack (rebuy/top-up).

```bash
curl -X POST http://localhost:3000/tables/clx789ghi/add-chips \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "amount": 200,
    "idempotencyKey": "uuid-456-def"
  }'
```

#### `POST /tables/:id/stand`

Leave the table and cash out.

```bash
curl -X POST http://localhost:3000/tables/clx789ghi/stand \
  -H "Authorization: Bearer <token>"
```

---

### User

#### `GET /user/me`

Get profile and balances.

```bash
curl http://localhost:3000/user/me \
  -H "Authorization: Bearer <token>"
```

**Response:**

```json
{
  "id": "clx123abc",
  "username": "player_a1b2c3",
  "address": "0x742d35cc6634c0532925a3b844bc454e4438f44e",
  "role": "PLAYER",
  "createdAt": "2024-01-15T10:30:00Z",
  "balances": {
    "main": 10000,
    "inPlay": 500
  }
}
```

#### `GET /user/history`

Get hand history (wins/losses).

```bash
curl http://localhost:3000/user/history \
  -H "Authorization: Bearer <token>"
```

**Response:**

```json
{
  "history": [
    {
      "id": "entry1",
      "amount": 150,
      "type": "HAND_WIN",
      "referenceId": "hand-uuid",
      "createdAt": "2024-01-15T12:00:00Z"
    }
  ]
}
```

#### `POST /user/withdraw`

Request withdrawal with a wallet signature. Withdrawal messages must include a unique nonce and recent timestamp; replayable legacy messages are rejected.

```bash
curl -X POST http://localhost:3000/user/withdraw \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "amount": 100,
    "blockchainId": "clx-chain-id",
    "tokenId": "clx-token-id",
    "address": "0x...",
    "message": "Withdraw 100 USD to 0x...\nNonce: withdrawal-uuid\nTimestamp: 1782400000000",
    "signature": "0x...",
    "idempotencyKey": "withdrawal-uuid"
  }'
```

#### `GET /user/withdrawals`

Get withdrawal history.

---

### Finance

#### `GET /finance/chains`

List supported blockchains and tokens.

```bash
curl http://localhost:3000/finance/chains
```

**Response:**

```json
[
  {
    "id": "clx-eth",
    "name": "Ethereum",
    "chainId": 1,
    "tokens": [
      {
        "id": "clx-usdc",
        "symbol": "USDC",
        "name": "USD Coin",
        "decimals": 6,
        "minDeposit": "10000000"
      }
    ]
  }
]
```

#### `POST /finance/deposit/start`

Start a deposit monitoring session.

```bash
curl -X POST http://localhost:3000/finance/deposit/start \
  -H "Authorization: Bearer <token>"
```

**Response:**

```json
{
  "address": "0x...",
  "expiresAt": "2024-01-15T11:00:00Z",
  "message": "Deposit tracking active for 30 minutes."
}
```

#### `GET /finance/deposit/address`

Get user's deposit address.

#### `GET /finance/deposits`

Get deposit history.

---

### Notes

#### `POST /notes`

Save/update a player note.

```bash
curl -X POST http://localhost:3000/notes \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "targetId": "player-id",
    "content": "Tight player, bluffs on river",
    "label": "TAG"
  }'
```

#### `GET /notes/:targetId`

Get note for specific player.

#### `GET /notes`

Get all notes by authenticated user.

#### `DELETE /notes/:targetId`

Delete note for specific player.

---

### Health

#### `GET /health`

Health check endpoint with per-dependency status.

```bash
curl http://localhost:3000/health
```

**Response (healthy):**

```json
{
  "status": "ok",
  "timestamp": 1705316400000,
  "uptimeSeconds": 3600,
  "checks": {
    "db": { "status": "ok", "latencyMs": 5 },
    "redis": { "status": "ok", "latencyMs": 1 },
    "queue": { "status": "ok", "latencyMs": 3 }
  },
  "queues": {
    "gameEvents": { "waiting": 0, "delayed": 0, "failed": 0 }
  }
}
```

Returns `503` when overall status is `"down"`, `200` when `"degraded"` or `"ok"`.

#### `GET /metrics`

Prometheus-format metrics endpoint for scraping by monitoring systems.

```bash
curl http://localhost:3000/metrics
```

Exposes counters: `pokertools_http_requests_total`, `pokertools_game_actions_total`, `pokertools_risk_denials_total`, `pokertools_idempotency_hits_total`, `pokertools_audit_log_failures_total`, plus process uptime gauge.

---

## 🔌 WebSocket Protocol

Connect to `/ws/play` for real-time game updates.

### Connection

The server authenticates WebSocket clients via the `token` cookie or the `jwt.<token>` WebSocket subprotocol (no query-string tokens).

```javascript
// Browser: the httpOnly cookie is attached automatically during the upgrade handshake
const ws = new WebSocket("ws://localhost:3000/ws/play");

// Programmatic / non-browser: supply the JWT via the Sec-WebSocket-Protocol header
const ws = new WebSocket("ws://localhost:3000/ws/play", "jwt.eyJhbGciOi...");
```

### Client → Server Messages

#### Join Table

```json
{
  "type": "JOIN",
  "tableId": "clx789ghi",
  "requestId": "req-123"
}
```

#### Leave Table

```json
{
  "type": "LEAVE",
  "tableId": "clx789ghi",
  "requestId": "req-456"
}
```

#### Ping (Keep-alive)

```json
{
  "type": "PING",
  "requestId": "req-789"
}
```

### Server → Client Messages

#### Snapshot (Initial State)

```json
{
  "type": "SNAPSHOT",
  "tableId": "clx789ghi",
  "state": {
    /* full game state */
  },
  "version": 42,
  "timestamp": 1705316400000
}
```

#### State Update

```json
{
  "type": "STATE_UPDATE",
  "tableId": "clx789ghi",
  "version": 42,
  "timestamp": 1705316400000
}
```

`STATE_UPDATE` is intentionally lightweight. Clients should use the version metadata to decide whether to fetch fresh table state via REST, or rely on an existing cached snapshot.

#### Acknowledgment

```json
{
  "type": "ACK",
  "requestId": "req-123",
  "message": "Joined table successfully"
}
```

#### Pong

```json
{
  "type": "PONG",
  "requestId": "req-789",
  "timestamp": 1705316400000
}
```

#### Error

```json
{
  "type": "ERROR",
  "code": "INVALID_MESSAGE",
  "message": "Invalid message format",
  "context": {
    /* additional details */
  }
}
```

### Connection Flow

```
Client                                Server
   │                                     │
   │─────── WebSocket Connect ──────────▶│
   │◀────── Connection Accepted ─────────│
   │                                     │
   │─────── JOIN { tableId } ───────────▶│
   │◀────── SNAPSHOT { state } ──────────│
   │◀────── ACK { requestId } ───────────│
   │                                     │
   │◀───── STATE_UPDATE { version } ─────│ (action occurred)
   │◀───── STATE_UPDATE { version } ─────│ (another action)
   │                                     │
   │─────── PING { requestId } ─────────▶│
   │◀────── PONG { timestamp } ──────────│
   │                                     │
   │─────── LEAVE { tableId } ──────────▶│
   │◀────── ACK { requestId } ───────────│
   │                                     │
```

---

## 🔧 Services

### GameManager

Orchestrates game logic with distributed locking and state persistence.

```typescript
class GameManager {
  // Process action with lock and version control
  async processAction(tableId: string, action: Action, userId: string): Promise<PublicState>;

  // Create new table
  async createTable(config: TableConfig): Promise<string>;

  // Get state with view masking
  async getState(tableId: string, userId?: string): Promise<PublicState>;
}
```

**State Flow:**

```
┌─────────────────────────────────────────────────────────────────┐
│                     processAction(tableId, action, userId)      │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
              ┌───────────────────────────────┐
              │    1. Acquire Redlock         │
              │    (lock:table:{tableId})     │
              └───────────────┬───────────────┘
                              │
                              ▼
              ┌───────────────────────────────┐
              │    2. Load State from Redis   │
              │    (table:{tableId})          │
              └───────────────┬───────────────┘
                              │
                              ▼
              ┌───────────────────────────────┐
              │    3. Restore PokerEngine     │
              │    from snapshot              │
              └───────────────┬───────────────┘
                              │
                              ▼
              ┌───────────────────────────────┐
              │    4. Validate Identity       │
              │    (playerId === userId)      │
              └───────────────┬───────────────┘
                              │
                              ▼
              ┌───────────────────────────────┐
              │    5. Execute engine.act()    │
              │    (game logic validation)    │
              └───────────────┬───────────────┘
                              │
                              ▼
              ┌───────────────────────────────┐
              │    6. Save to Redis (Lua)     │
              │    with optimistic locking    │
              └───────────────┬───────────────┘
                              │
                              ▼
              ┌───────────────────────────────┐
              │    7. Queue persist-snapshot  │
              │    (async cold storage)       │
              └───────────────┬───────────────┘
                              │
                              ▼
              ┌───────────────────────────────┐
              │    8. Handle Side Effects     │
              │    - Hand completion          │
              │    - Schedule timeout         │
              └───────────────┬───────────────┘
                              │
                              ▼
              ┌───────────────────────────────┐
              │    9. Publish STATE_UPDATE    │
              │    (Redis Pub/Sub)            │
              └───────────────┬───────────────┘
                              │
                              ▼
              ┌───────────────────────────────┐
              │    10. Release Lock           │
              │    Return masked view         │
              └───────────────────────────────┘
```

### FinancialManager

Double-entry ledger for chip accounting.

```typescript
class FinancialManager {
  // Buy-in: MAIN → IN_PLAY
  async buyIn(userId: string, tableId: string, amount: number): Promise<void>;

  // Cash-out: IN_PLAY → MAIN
  async cashOut(userId: string, tableId: string, amount: number): Promise<void>;

  // Get balances
  async getBalances(userId: string): Promise<{ main: number; inPlay: number }>;

  // Ensure accounts exist
  async ensureAccounts(userId: string): Promise<void>;
}
```

### SocketManager

WebSocket connection multiplexing with single Redis subscriber.

```typescript
class SocketManager {
  // Join table subscription
  joinTable(tableId: string, socket: WebSocket, userId: string): void;

  // Leave table subscription
  leaveTable(tableId: string, socket: WebSocket): void;
}
```

### BlockchainManager

HD wallet management and blockchain interactions.

```typescript
class BlockchainManager {
  // Get Viem client for chain
  async getClient(blockchainId: string): Promise<PublicClient>;

  // Get/generate deposit address
  async getUserDepositAddress(userId: string): Promise<string>;

  // Start deposit monitoring
  async startDepositSession(
    userId: string,
    durationMinutes?: number
  ): Promise<{ address: string; expiresAt: Date }>;
}
```

### NotesManager

Player notes system.

```typescript
class NotesManager {
  async upsertNote(
    authorId: string,
    targetId: string,
    content: string,
    label?: string
  ): Promise<PlayerNote>;

  async getNote(authorId: string, targetId: string): Promise<PlayerNote | null>;

  async getAllNotes(authorId: string): Promise<PlayerNote[]>;

  async deleteNote(authorId: string, targetId: string): Promise<void>;
}
```

### RiskManager

Per-user/IP velocity controls using Redis sorted sets for sliding-window rate limiting.

```typescript
class RiskManager {
  async assertAllowed(input: {
    userId: string;
    endpoint: string;
    request: FastifyRequest;
    amountCents?: number;
  }): Promise<{ score: number }>;
}
```

Throws `RiskDeniedError` (HTTP 429) when per-endpoint thresholds are exceeded or the combined risk score reaches the configured ceiling.

### IdempotencyManager

Durable idempotency using the `IdempotencyRecord` database table for buy-ins, add-chips, and gameplay actions.

```typescript
class IdempotencyManager {
  hash(payload: unknown): string;

  async run<T extends Record<string, unknown>>(input: {
    key: string;
    scope: string;
    userId: string;
    requestHash: string;
    ttlSeconds?: number;
    handler: () => Promise<T>;
  }): Promise<{ replayed: boolean; response: T }>;
}
```

Conflicting keys (different user or hash) throw `IdempotencyConflictError` (409). In-progress keys throw `IdempotencyInProgressError` (409).

### AuditManager

Structured `AuditLog` writes for every financial and gameplay event. Failures increment a Prometheus counter but never block the response.

```typescript
class AuditManager {
  async record(input: {
    actorId?: string;
    action: string;
    resource: string;
    request?: FastifyRequest;
    riskScore?: number;
    metadata?: Record<string, unknown>;
  }): Promise<void>;
}
```

### ObservabilityManager

In-process Prometheus metrics and structured health checks.

```typescript
class ObservabilityManager {
  increment(name: string, labels?: Record<string, string>, value?: number): void;
  async health(): Promise<HealthResponse>;
  metrics(): string;
  attachHttpMetrics(): void;
}
```

---

## ⚙️ Background Workers

Workers run in a separate process using BullMQ.

### settle-hand

Processes financial settlement after hand completion.

```typescript
// Job data
interface SettleHandJob {
  tableId: string;
  handId: string;
  playerNetChanges: Record<string, string>; // playerId → netChange
  rakeTotal: string;
}
```

**Actions:**

1. Credit House account with rake
2. Update player IN_PLAY balances
3. Create ledger entries (HAND_WIN/HAND_LOSS)

### archive-hand

Archives hand history to database.

```typescript
// Job data
interface ArchiveHandJob {
  tableId: string;
  handId: string;
  snapshot: Snapshot;
}
```

### persist-snapshot

Writes Redis state to PostgreSQL for crash recovery.

```typescript
// Job data
interface PersistSnapshotJob {
  tableId: string;
  snapshot: Snapshot;
}
```

### next-hand

Auto-deals next hand after delay.

```typescript
// Job data
interface NextHandJob {
  tableId: string;
}
```

### player-timeout

Handles player timeouts with version checking.

```typescript
// Job data
interface TimeoutJob {
  tableId: string;
  playerId: string;
  expectedVersion: number;
}
```

### deposit-monitor

Scans blockchain for incoming deposits.

```typescript
// Repeatable job (every 15 seconds)
// No job data - scans all active sessions
```

**Flow:**

```
┌─────────────────────────────────────────────────────────────────┐
│                    deposit-monitor (every 15s)                  │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
              ┌───────────────────────────────┐
              │  1. Get active deposit        │
              │     sessions                  │
              └───────────────┬───────────────┘
                              │
                              ▼
              ┌───────────────────────────────┐
              │  2. For each blockchain:      │
              │     - Get lastScannedBlock    │
              │     - Scan Transfer events    │
              └───────────────┬───────────────┘
                              │
                              ▼
              ┌───────────────────────────────┐
              │  3. Filter logs where         │
              │     'to' is active wallet     │
              └───────────────┬───────────────┘
                              │
                              ▼
              ┌───────────────────────────────┐
              │  4. Check confirmations       │
              │     - PENDING if < required   │
              │     - CONFIRMED if >= required│
              └───────────────┬───────────────┘
                              │
                              ▼
              ┌───────────────────────────────┐
              │  5. If CONFIRMED:             │
              │     - Credit MAIN account     │
              │     - Create ledger entry     │
              └───────────────┬───────────────┘
                              │
                              ▼
              ┌───────────────────────────────┐
              │  6. Update lastScannedBlock   │
              └───────────────────────────────┘
```

### Running Workers

```bash
# Start all workers (separate process)
node dist/workers.js

# Or use tsx in development
tsx src/workers.ts
```

---

## 🗄️ Database Schema

> The diagrams below show the core entities and relationships. Additional operational models (`Session`, `IdempotencyRecord`, `AuditLog`, `AdminWallet`, `UserWallet`, `DepositSession`) exist in the schema for session management, durable idempotency, audit trails, and HD-wallet deposit tracking.

### Entity Relationship Diagram

```
┌─────────────────────────────────────────────────────────────────────────┐
│                               USER                                      │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │ id        │ username │ address        │ role    │ createdAt     │    │
│  │ (cuid)    │ unique   │ 0x... unique   │ PLAYER  │               │    │
│  └─────────────────────────────────────────────────────────────────┘    │
│       │                                                                 │
│       │ 1:N                                                             │
│       ▼                                                                 │
│  ┌──────────────────────────────────────┐                               │
│  │            ACCOUNT                   │                               │
│  │  id │ userId │ currency │ type │ bal │                               │
│  │     │        │  "USDC"  │ MAIN │     │                               │
│  │     │        │          │IN_PLAY│    │                               │
│  └──────────────────┬───────────────────┘                               │
│                     │                                                   │
│                     │ 1:N                                               │
│                     ▼                                                   │
│  ┌────────────────────────────────────────────────────────────────┐     │
│  │                       LEDGER_ENTRY                             │     │
│  │  id │ accountId │ amount │ type      │ referenceId │ metadata  │     │
│  │     │           │  +150  │ HAND_WIN  │ hand-uuid   │           │     │
│  │     │           │  -100  │ BUY_IN    │ table-id    │           │     │
│  │     │           │   +50  │ DEPOSIT   │ txHash      │           │     │
│  └────────────────────────────────────────────────────────────────┘     │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────┐
│                               TABLE                                     │
│  ┌────────────────────────────────────────────────────────────────┐     │
│  │  id   │ name     │ mode  │ status  │ config (JSON) │ state     │     │
│  │ cuid │          │ CASH  │ ACTIVE  │ {blinds,...}  │ snapshot   │     │
│  └──────────────────────────────┬─────────────────────────────────┘     │
│                                 │                                       │
│                                 │ 1:N                                   │
│                                 ▼                                       │
│  ┌────────────────────────────────────────────────────────────────┐     │
│  │                      HAND_HISTORY                              │     │
│  │  id │ tableId │ data (JSON - full hand export) │ timestamp     │     │
│  └────────────────────────────────────────────────────────────────┘     │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────┐
│                           BLOCKCHAIN                                    │
│  ┌────────────────────────────────────────────────────────────────┐     │
│  │  id │ name │ chainId │ rpcUrl │ confirmations │ lastScanned    │     │
│  └──────────────────────────┬─────────────────────────────────────┘     │
│                             │                                           │
│                             │ 1:N                                       │
│                             ▼                                           │
│  ┌────────────────────────────────────────────────────────────────┐     │
│  │                         TOKEN                                  │     │
│  │  id │ blockchainId │ address │ symbol │ decimals │ minDeposit  │     │
│  └────────────────────────────────────────────────────────────────┘     │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────┐
│                       PAYMENT_TRANSACTION                               │
│  ┌────────────────────────────────────────────────────────────────┐     │
│  │  id │ userId │ type │ blockchainId │ tokenId │ txHash │ status │     │
│  │     │        │DEPOSIT│            │         │        │CONFIRMED│     │
│  │     │        │WITHDRAW│           │         │        │PENDING  │     │
│  └────────────────────────────────────────────────────────────────┘     │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### Transaction Types

| Type           | Description              | Account Effect    |
| -------------- | ------------------------ | ----------------- |
| `DEPOSIT`      | Crypto deposit confirmed | +MAIN             |
| `WITHDRAWAL`   | Crypto withdrawal        | -MAIN             |
| `BUY_IN`       | Join table               | -MAIN, +IN_PLAY   |
| `CASH_OUT`     | Leave table              | -IN_PLAY, +MAIN   |
| `RAKE`         | House rake               | +HOUSE MAIN       |
| `REFUND`       | Rejected withdrawal      | +MAIN             |
| `HAND_WIN`     | Won a pot                | +IN_PLAY          |
| `HAND_LOSS`    | Lost chips               | -IN_PLAY          |
| `UNCALLED_BET` | Returned uncalled bet    | +IN_PLAY          |
| `SWEEP`        | Admin swept deposit      | — (metadata only) |

---

## 🔐 Authentication

> See also the root [SECURITY.md](../../SECURITY.md) for cryptographic RNG guidance, view masking, chip-conservation auditing, and the full security deployment checklist.

### SIWE (Sign-In with Ethereum)

```
┌──────────────────────────────────────────────────────────────────┐
│                        SIWE Auth Flow                            │
└──────────────────────────────────────────────────────────────────┘
           │
           ▼
┌──────────────────────────────────────────────────────────────────┐
│  1. Client requests nonce: POST /auth/nonce                      │
│     Response: { nonce: "abc123..." }                             │
│     (nonce stored in Redis with 5min TTL)                        │
└──────────────────────────────────────────────────────────────────┘
           │
           ▼
┌──────────────────────────────────────────────────────────────────┐
│  2. Client constructs SIWE message:                              │
│     "poker.example.com wants you to sign in with your Ethereum   │
│      account: 0x742d35cc6634c0532925a3b844bc454e4438f44e         │
│      Nonce: abc123...                                            │
│      Issued At: 2024-01-15T10:30:00.000Z"                        │
└──────────────────────────────────────────────────────────────────┘
           │
           ▼
┌──────────────────────────────────────────────────────────────────┐
│  3. User signs message with wallet (MetaMask, etc.)              │
│     Signature: 0x...                                             │
└──────────────────────────────────────────────────────────────────┘
           │
           ▼
┌──────────────────────────────────────────────────────────────────┐
│  4. Client submits: POST /auth/login                             │
│     Body: { message, signature }                                 │
└──────────────────────────────────────────────────────────────────┘
           │
           ▼
┌──────────────────────────────────────────────────────────────────┐
│  5. Server verifies:                                             │
│     - Nonce exists in Redis                                      │
│     - Signature matches address                                  │
│     - Nonce is burned (one-time use)                             │
└──────────────────────────────────────────────────────────────────┘
           │
           ▼
┌──────────────────────────────────────────────────────────────────┐
│  6. Server creates/upserts user, session, and JWT                │
│     Response: { token: "eyJ...", user: {...} }                   │
│     Cookie: token=eyJ... (httpOnly, secure, sameSite)            │
└──────────────────────────────────────────────────────────────────┘
```

### JWT Payload

```typescript
interface JWTPayload {
  userId: string; // Database user ID
  address: string; // Ethereum address
  jti: string; // JWT ID (for session revocation)
}
```

### Session Revocation

Sessions can be revoked by setting `session.revoked = true` in the database. The `authenticate` hook checks this on every request.

---

## 💰 Financial System

### Double-Entry Ledger

Every money movement creates two entries that balance to zero:

```
┌────────────────────────────────────────────────────────────────────┐
│                          BUY-IN EXAMPLE                            │
│                                                                    │
│  Player buys in for $5.00 (500 cents):                             │
│                                                                    │
│  ┌────────────────────────────────────────────────────────────┐    │
│  │  Entry 1: MAIN Account                                     │    │
│  │    amount: -500                                            │    │
│  │    type: BUY_IN                                            │    │
│  │    referenceId: tableId                                    │    │
│  └────────────────────────────────────────────────────────────┘    │
│                                                                    │
│  ┌────────────────────────────────────────────────────────────┐    │
│  │  Entry 2: IN_PLAY Account                                  │    │
│  │    amount: +500                                            │    │
│  │    type: BUY_IN                                            │    │
│  │    referenceId: tableId                                    │    │
│  └────────────────────────────────────────────────────────────┘    │
│                                                                    │
│  Net change: -500 + 500 = 0 ✓                                      │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘
```

### Money Flow

```
                           DEPOSIT
                              │
                              ▼
┌──────────────────────────────────────────────────────────────────┐
│                         MAIN ACCOUNT                             │
│                    (Available for withdrawal)                    │
└──────────────────────────┬───────────────────────────────────────┘
                           │
              ┌────────────┴─────────────┐
              │ BUY_IN                   │ CASH_OUT
              ▼                          │
┌──────────────────────────────────────┐ │
│                                      │ │
│           IN_PLAY ACCOUNT            │◀┘
│          (Locked on tables)          │
│                                      │
│    ┌──────────────────────────┐      │
│    │  HAND_WIN / HAND_LOSS    │      │
│    │  (Engine state → Ledger) │      │
│    └──────────────────────────┘      │
│                                      │
└──────────────────────────────────────┘
                           │
                           │ RAKE
                           ▼
┌──────────────────────────────────────────────────────────────────┐
│                      HOUSE MAIN ACCOUNT                          │
│                     (Operator revenue)                           │
└──────────────────────────────────────────────────────────────────┘
```

### Chip Units

All amounts are stored in **cents** (1 chip = 1 cent = $0.01):

| Display | Storage |
| ------- | ------- |
| $1.00   | 100     |
| $10.50  | 1050    |
| $100.00 | 10000   |

---

## 🔗 Blockchain Integration

### HD Wallet Derivation

```
┌──────────────────────────────────────────────────────────────────┐
│                      Admin Wallet (xpriv)                        │
│                    m/44'/60'/0'/0                                │
└──────────────────────────┬───────────────────────────────────────┘
                           │
           ┌───────────────┼───────────────┐
           │               │               │
           ▼               ▼               ▼
      ┌────────┐      ┌────────┐      ┌────────┐
      │ /0     │      │ /1     │      │ /2     │
      │ User A │      │ User B │      │ User C │
      │ 0x123  │      │ 0x456  │      │ 0x789  │
      └────────┘      └────────┘      └────────┘
```

Each user gets a unique deterministic address derived from public HD wallet material. The API supports xpub-only derivation and does not need private keys to assign deposit addresses; private-key-capable material must remain isolated to the admin/sweeper environment. The derivation index is atomically incremented to prevent collisions.

### Deposit Detection

1. User calls `/finance/deposit/start`
2. Returns unique deposit address
3. `deposit-monitor` worker scans ERC20 Transfer events
4. Matches `to` address against active sessions
5. Ignores zero-address mint events and deposits below `Token.minDeposit`
6. Credits MAIN account after confirmations

### Withdrawal Flow

1. User constructs message: `"Withdraw 100 USD to 0x...\nNonce: <unique-id>\nTimestamp: <unix-ms>"`
2. Signs with wallet
3. Server verifies signature matches user's address
4. Server rejects expired timestamps and duplicate idempotency keys
5. Deducts from MAIN account and creates `PaymentTransaction` in the same DB transaction
6. Queues the DB-backed outbox row for admin approval

---

## ⚠️ Error Handling

### Custom Error Classes

```typescript
// Base error
class AppError extends Error {
  constructor(
    message: string,
    public statusCode = 500,
    public code?: string
  ) {}
}

// Specific errors
class AuthenticationError extends AppError {} // 401
class AuthorizationError extends AppError {} // 403
class NotFoundError extends AppError {} // 404
class ValidationError extends AppError {} // 400
class ConflictError extends AppError {} // 409
class InsufficientFundsError extends AppError {} // 400
```

### API Error Response

```json
{
  "error": "INSUFFICIENT_FUNDS",
  "message": "Insufficient balance. Has: 100, Needs: 500"
}
```

### Engine Error Mapping

Game engine errors are mapped to HTTP 400:

```typescript
if (err.code && err.message) {
  return reply.code(err.statusCode).send({
    error: err.code,
    message: err.message,
  });
}
```

---

## 🧪 Testing

### Run Tests

```bash
# Run all tests
npm test

# Run with coverage
npm test -- --coverage

# Run specific test file
npm test -- tests/integration/cash-game-lifecycle.test.ts

# Watch mode
npm test -- --watch
```

### Test Setup

Tests use:

- SQLite in-memory database
- Local Redis (test database)
- Vitest with sequential execution

```typescript
// tests/helpers/test-utils.ts
export async function initTestContext(
  userCount = 2,
  initialBalance = 10000
): Promise<TestContext> {
  const app = await buildApp();
  await app.ready();

  const users: TestUser[] = [];
  for (let i = 0; i < userCount; i++) {
    const user = await createTestUser(app, `player${i + 1}`, initialBalance);
    users.push(user);
  }

  return { app, users, cleanup: [...] };
}
```

### Test Coverage

```
 Test Files  23 passed (23)
      Tests  100+ passed
   Duration  30-45s

Coverage:
  - Integration tests for all routes (auth, tables, user, finance, notes, WS)
  - Financial integrity tests (double-entry, chip conservation)
  - WebSocket real-time tests (join/leave, limits, concurrency)
  - Worker job processing tests (settle, archive, deposit-monitor, timeout)
  - Timeout / Redlock interaction tests
  - Security tests (rate-limiting, withdrawal signatures, deposit replay)
  - Tournament lifecycle and production-readiness tests
```

---

## 🚀 Deployment

### Docker Compose

The repository root includes a production-ready [`docker-compose.yml`](../../docker-compose.yml) that starts the API alongside a Redis service. It uses the monorepo [`Dockerfile`](../../Dockerfile) (two-stage build: `node:24-slim`, `prisma generate`, `tsc`, then a minimal production image running as a non-root `pokertools` user).

```bash
# From the monorepo root
docker compose up --build
```

Key compose behaviours:

- **Image**: tagged as `ghcr.io/aaurelions/pokertools:latest`.
- **Database**: SQLite (`file:.runtime/app.db`) persisted to a named `sqlite_data` volume.
- **Migrations**: the container entrypoint (`packages/api/scripts/docker-entrypoint.sh`) applies `npx prisma db push --accept-data-loss` at startup, synchronising the Prisma schema without requiring a full migration history.
- **Healthcheck**: `curl -fsS http://localhost:3000/health` every 30 s.
- **Secrets**: `JWT_SECRET`, `COOKIE_SECRET`, and `WALLET_ENCRYPTION_SECRET` are read from the host environment or fall back to dev-only defaults (never use those defaults in production).

To run the API with PostgreSQL instead of SQLite, set `DATABASE_URL` to a PostgreSQL connection string and ensure an appropriate Prisma datasource configuration.

### Production Checklist

- [ ] Use PostgreSQL (not SQLite)
- [ ] Set strong `JWT_SECRET` and `COOKIE_SECRET`
- [ ] Enable HTTPS (reverse proxy or load balancer)
- [ ] Configure rate limiting appropriately
- [ ] Set up Redis persistence (AOF recommended)
- [ ] Run workers as separate processes
- [ ] Configure log aggregation
- [ ] Set up monitoring and alerting
- [ ] Enable database backups
- [ ] Use multi-node Redlock for HA

### Scaling

```
┌─────────────────────────────────────────────────────────────────────┐
│                           LOAD BALANCER                             │
│                      (Sticky sessions for WS)                       │
└─────────────────────────────────────────────────────────────────────┘
                           │
         ┌─────────────────┼─────────────────┐
         │                 │                 │
         ▼                 ▼                 ▼
    ┌─────────┐       ┌─────────┐       ┌─────────┐
    │  API 1  │       │  API 2  │       │  API 3  │
    └────┬────┘       └────┬────┘       └────┬────┘
         │                 │                 │
         └─────────────────┼─────────────────┘
                           │
         ┌─────────────────┼─────────────────┐
         │                 │                 │
         ▼                 ▼                 ▼
    ┌─────────┐       ┌─────────┐       ┌─────────┐
    │ Redis 1 │───────│ Redis 2 │───────│ Redis 3 │
    │(Primary)│       │(Replica)│       │(Replica)│
    └─────────┘       └─────────┘       └─────────┘
                           │
                           ▼
                    ┌─────────────┐
                    │ PostgreSQL  │
                    │  (Primary)  │
                    └─────────────┘
```

---

## 📜 License

MIT © [A.Aurelius](https://github.com/aaurelions)

---

## 🔗 Related Packages

| Package                               | Description                   |
| ------------------------------------- | ----------------------------- |
| [@pokertools/types](../types)         | Shared TypeScript definitions |
| [@pokertools/engine](../engine)       | Core game logic               |
| [@pokertools/evaluator](../evaluator) | Hand evaluation               |
