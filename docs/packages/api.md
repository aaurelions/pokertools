# @pokertools/api

Scalable REST & WebSocket API built with Fastify, Redis, BullMQ and Prisma — SQLite by
default for local development, PostgreSQL for production.

## Running locally

```bash
# from the repo root
npm install
npm run dev:api        # Fastify server on :8080 (watch mode)
npm run dev:workers    # BullMQ workers in watch mode
npm run db:migrate     # Prisma migrations (SQLite by default)
npm run db:seed        # optional seed data
```

Redis must be reachable at `REDIS_URL` (the API can auto-start a local Redis with
`npm run infra:up`).

## Architecture at a glance

| Layer       | Technology                         | Responsibility                                                |
| :---------- | :--------------------------------- | :------------------------------------------------------------ |
| HTTP        | Fastify 5                          | REST endpoints, SIWE auth, rate limiting, OpenAPI (`/docs`)   |
| Realtime    | `@fastify/websocket`               | State updates pushed to `pubsub:table:{tableId}`              |
| Table state | Redis (JSON snapshot + `_version`) | Hot state with optimistic versioning                          |
| Locks       | Redlock                            | Serialize actions per table                                   |
| Persistence | Prisma 7                           | Accounts, ledger, payments, tournaments, tables, hand history |
| Jobs        | BullMQ 6                           | Settlement, archiving, auto-dealing, timeouts, blinds         |
| Validation  | Zod 4                              | Request/response schemas (shared with `@pokertools/types`)    |

## REST endpoints

| Area        | Method & path                          | Purpose                      |
| :---------- | :------------------------------------- | :--------------------------- |
| Auth        | `POST /auth/nonce`                     | SIWE nonce                   |
| Auth        | `POST /auth/login`                     | SIWE session login           |
| Auth        | `POST /auth/logout`                    | End session                  |
| User        | `GET /user/me`                         | Profile                      |
| Tables      | `GET /tables`                          | List visible tables          |
| Tables      | `POST /tables`                         | Create a table               |
| Tables      | `GET /tables/:id/state?since=`         | Masked state (delta-aware)   |
| Tables      | `POST /tables/:id/action`              | Submit a client action       |
| Tables      | `POST /tables/:id/buy-in`              | Cash buy-in                  |
| Tables      | `POST /tables/:id/add-chips`           | Top up                       |
| Tables      | `POST /tables/:id/stand`               | Leave table                  |
| Tournaments | `GET /tournaments`                     | List                         |
| Tournaments | `POST /tournaments`                    | Create                       |
| Tournaments | `POST /tournaments/:id/register`       | Enter                        |
| Tournaments | `POST /tournaments/:id/start`          | Kick off                     |
| Tournaments | `POST /tournaments/:id/reconcile`      | Escrow/prize reconciliation  |
| Tournaments | `POST /tournaments/:id/advance-blinds` | Manual level advance         |
| Finance     | `GET /finance/chains`                  | Supported chains/tokens      |
| Finance     | `POST /finance/deposit/start`          | Deposit session + address    |
| Finance     | `GET /finance/deposit/address`         | Reuse deposit address        |
| Finance     | `GET /finance/deposits`                | Deposit history              |
| Finance     | `POST /finance/withdraw`               | Signed withdrawal request    |
| Finance     | `GET /finance/withdrawals`             | Withdrawal history           |
| Notes       | `GET/POST/PUT/DELETE /notes`           | Player notes (max 500 chars) |
| Docs        | `GET /docs`                            | Swagger UI (OpenAPI)         |

::: tip Idempotency
Mutating endpoints accept an `Idempotency-Key` header (or body key). Combined with the
SDK's retry policy, this makes replaying requests safe.
:::

## Workers & queues

| Queue               | Worker                           | Effect                                                                                      |
| :------------------ | :------------------------------- | :------------------------------------------------------------------------------------------ |
| `settle-hand`       | prisma ledger settlement         | Applies awards − investments per player; **rejects unbalanced batches** (deltas + rake ≠ 0) |
| `archive-hand`      | prisma `handHistory.upsert`      | Persists `HandHistory` — stable `jobId` and upsert tolerate retries                         |
| `next-hand`         | engine DEAL via `GameManager`    | Auto-deals the next hand with a version check under the table lock                          |
| `persist-snapshot`  | redis → prisma                   | Database fallback for table state                                                           |
| `player-timeout`    | engine TIMEOUT via `GameManager` | Folds/checks timed-out players; stale versions are rejected                                 |
| `tournament-blinds` | blind scheduler                  | Advances blind levels for running tournaments                                               |

Scheduled actions (timeout, auto-deal, blinds) run through the **same**
`GameManager.processAction` path as player actions: table lock → version check →
engine transition → persist → schedule effects → broadcast. Lock contention fails the job
so BullMQ retries it.

## Environment variables

| Variable                         | Default                  | Purpose                         |
| :------------------------------- | :----------------------- | :------------------------------ |
| `PORT`                           | `8080`                   | HTTP port                       |
| `NODE_ENV`                       | `development`            | `test` enables test routes      |
| `REDIS_URL`                      | `redis://localhost:6379` | Redis for state, queues, locks  |
| `DATABASE_URL`                   | `file:./prisma/dev.db`   | SQLite path or `postgresql://…` |
| `JWT_SECRET` / `COOKIE_SECRET`   | —                        | Session signing                 |
| `ALLOWED_SIWE_CHAIN_IDS`         | `1,31337`                | Accepted SIWE chains            |
| `DEFAULT_CURRENCY`               | `USDC`                   | Ledger currency                 |
| `MAX_WITHDRAWAL_AMOUNT_CENTS`    | `1000000`                | Withdrawal ceiling              |
| `TABLE_REDIS_TTL_SECONDS`        | `86400`                  | Hot-state expiry                |
| `TABLE_LOCK_TTL_MS`              | `10000`                  | Redlock TTL                     |
| `ACTION_TIMEOUT_SECONDS`         | `30`                     | Player action timer             |
| `RATE_LIMIT_MAX`                 | `100`                    | General rate limit              |
| `AUTH_NONCE_RATE_LIMIT_MAX`      | `5`                      | Nonce endpoint limit            |
| `AUTH_LOGIN_RATE_LIMIT_MAX`      | `10`                     | Login endpoint limit            |
| `DEPOSIT_MONITOR_INTERVAL_MS`    | `15000`                  | Deposit scan cadence            |
| `TOURNAMENT_BLIND_INTERVAL_MS`   | `900000`                 | Level duration                  |
| `WALLET_XPRIV_ENCRYPTION_SECRET` | —                        | HD wallet seed encryption       |

## WebSockets

Clients connect to `/ws` with a `token` query parameter or header, then subscribe to
tables. The server publishes:

```json
{
  "type": "STATE_UPDATE",
  "tableId": "table_abc",
  "version": 42,
  "timestamp": 1760000000000
}
```

The SDK reacts to `STATE_UPDATE` by refreshing the masked state for that version — private
cards never travel over the socket.

### Subscribing without the SDK

Wire protocol (defined in `@pokertools/types`): the client sends `JOIN` and receives a
full **SNAPSHOT**, then receives lightweight **STATE_UPDATE** notifications; `PING`/`PONG`
and `LEAVE` round out the client side.

```bash
# wscat
wscat -c "wss://api.example.com/ws?token=$SESSION_TOKEN" \
  -x '{"type":"JOIN","tableId":"table_abc","requestId":"r1"}'
```

```ts
// Node.js 22+ — native WebSocket client
const ws = new WebSocket(`wss://api.example.com/ws?token=${token}`);
const tableId = "table_abc";

ws.onopen = () => ws.send(JSON.stringify({ type: "JOIN", tableId, requestId: "r1" }));
ws.onmessage = (event) => {
  const frame = JSON.parse(event.data as string);
  if (frame.type === "SNAPSHOT") {
    console.log("joined", frame.tableId, "at version", frame.version);
  } else if (frame.type === "STATE_UPDATE") {
    // Fetch the masked state for frame.version via GET /tables/:id/state
  } else if (frame.type === "ERROR") {
    console.error(frame.code, frame.message);
  }
};

setInterval(
  () => ws.send(JSON.stringify({ type: "PING", requestId: crypto.randomUUID() })),
  15_000
);
```

## Calling the API with curl

```bash
# 1. Get a SIWE nonce
curl -s http://localhost:8080/auth/nonce | jq

# 2. Login (message + signature from the SDK's createSiweMessage / wallet)
curl -s -X POST http://localhost:8080/auth/login \
  -H "Content-Type: application/json" \
  -d '{"message":"...siwe message...","signature":"0x..."}' \
  | jq -r '.token' > /tmp/token

# 3. Act on a table (mutation — send an idempotency key so retries are safe)
curl -s -X POST http://localhost:8080/tables/table_abc/action \
  -H "Authorization: Bearer $(cat /tmp/token)" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"type":"RAISE","amount":60,"playerId":"your-user-id"}' \
  | jq '.street, .actionTo'
```

## Testing the API

```bash
npm run test -w @pokertools/api    # prisma db push + Redis auto-start + vitest
```

The suite covers routes, ledger integrity, worker jobs, locking/version guards,
scheduled-action regressions and broadcast refunds — all against a disposable SQLite
database and a loopback Redis instance. CI adds Foundry and a Postgres-compatible Redis
service on Ubuntu.

## Source layout

| Path                   | Contains                                                                    |
| :--------------------- | :-------------------------------------------------------------------------- |
| `src/routes/*`         | Fastify route plugins (auth, tables, tournaments, finance, notes, user, ws) |
| `src/services/*`       | GameManager, tournament manager, notes manager, blockchain service          |
| `src/workers/*`        | BullMQ workers (settle, archive, next-hand, timeout, persist, blinds)       |
| `src/plugins/*`        | Fastify plugins (queues, redis, auth, rate limits, swagger)                 |
| `prisma/schema.prisma` | Database schema                                                             |
| `tests/`               | Vitest integration + unit suites                                            |

## Database

- **SQLite** — default for local dev and the test suite (`.runtime/test.db`)
- **PostgreSQL** — production; required by `docker-compose.prod.yml`

Prisma schema lives in `packages/api/prisma/schema.prisma`. Key models: `User`,
`Account` (`MAIN`, `IN_PLAY`, `PENDING_WITHDRAWAL`, `HOUSE_RESERVE`), `LedgerEntry`,
`PaymentTransaction`, `Table`, `Tournament`, `HandHistory`, `PlayerNote`.
