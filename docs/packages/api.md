# @pokertools/api

REST & WebSocket API built with Fastify, Redis, BullMQ and Prisma — SQLite by
default for local development, PostgreSQL for production.

## Running locally

```bash
# from the repo root
npm install
npm run dev:api        # Fastify server (watch mode)
npm run dev:workers    # BullMQ workers in watch mode
npm run db:migrate     # Prisma migrations
npm run db:seed        # optional seed data
```

The server binds `HOST`/`PORT` (default `0.0.0.0:3000`). Redis must be reachable
at `REDIS_URL`; `npm run infra:up -w @pokertools/api` starts a local Redis.

## Architecture at a glance

| Layer       | Technology                      | Responsibility                                              |
| :---------- | :------------------------------ | :---------------------------------------------------------- |
| HTTP        | Fastify 5                       | REST endpoints, SIWE auth, rate limiting, OpenAPI (`/docs`) |
| Realtime    | `@fastify/websocket`            | Masked `OBSERVATION` frames to subscribed sockets           |
| Table state | Redis (JSON snapshot + version) | Hot state with optimistic versioning                        |
| Locks       | Redlock                         | Serialize actions per table                                 |
| Persistence | Prisma 7                        | Accounts, atomic ledger, deposits, withdrawals, incidents   |
| Jobs        | BullMQ 6                        | Settlement, archiving, auto-dealing, timeouts, blinds       |
| Validation  | Zod 4                           | Request/response schemas (shared with `@pokertools/types`)  |

## REST endpoints

| Area        | Method & path                                 | Purpose                                     |
| :---------- | :-------------------------------------------- | :------------------------------------------ |
| Auth        | `POST /auth/nonce`                            | SIWE nonce                                  |
| Auth        | `POST /auth/login`                            | SIWE session login                          |
| Auth        | `GET /auth/me`                                | Current principal                           |
| Auth        | `POST /auth/logout`                           | End session                                 |
| Auth        | `POST /auth/service-credentials`              | Mint a scoped SERVICE credential (operator) |
| Auth        | `GET /auth/service-credentials`               | List SERVICE credentials (operator)         |
| Auth        | `POST /auth/service-credentials/:id/revoke`   | Revoke a SERVICE credential (operator)      |
| User        | `GET /user/me`                                | Profile                                     |
| User        | `GET /user/history`                           | Hand history                                |
| Tables      | `GET /tables`                                 | List visible tables                         |
| Tables      | `POST /tables`                                | Create a table                              |
| Tables      | `GET /tables/:id?since=`                      | Masked state (delta-aware)                  |
| Tables      | `POST /tables/:id/buy-in`                     | Cash buy-in                                 |
| Tables      | `GET /tables/:id/observation`                 | Per-seat observation + legal actions        |
| Tables      | `POST /tables/:id/action`                     | Submit a canonical action                   |
| Tables      | `GET`/`POST /tables/:id/chat`                 | Table chat                                  |
| Tables      | `GET /tables/:id/replay`                      | Hand replay                                 |
| Tables      | `POST /tables/:id/add-chips`                  | Top up                                      |
| Tables      | `POST /tables/:id/stand`                      | Leave table                                 |
| Tournaments | `GET /tournaments`                            | List                                        |
| Tournaments | `POST /tournaments`                           | Create                                      |
| Tournaments | `GET /tournaments/:id`                        | Detail                                      |
| Tournaments | `POST /tournaments/:id/register`              | Enter                                       |
| Tournaments | `POST /tournaments/:id/start`                 | Kick off                                    |
| Tournaments | `POST /tournaments/:id/advance-blinds`        | Manual level advance                        |
| Tournaments | `POST /tournaments/:id/reconcile`             | Escrow/prize reconciliation                 |
| Tournaments | `POST /tournaments/:id/settle`                | Settle payouts                              |
| Finance     | `GET /finance/assets`                         | Public asset registry                       |
| Finance     | `GET /finance/balances`                       | Canonical per-asset balances                |
| Finance     | `POST /finance/withdrawals/intents`           | EIP-712 withdrawal submission               |
| Finance     | `GET /finance/withdrawals`                    | Withdrawal history                          |
| Finance     | `GET /finance/withdrawals/:id`                | Withdrawal detail                           |
| Finance     | `POST /finance/deposits/claim`                | Claim an exact on-chain deposit log         |
| Finance     | `GET /finance/deposits/:id`                   | Deposit claim detail                        |
| Finance     | `GET /finance/incidents`                      | List financial incidents (operator)         |
| Finance     | `POST /finance/incidents/:id/resolve`         | Resolve an incident (operator)              |
| Finance     | `POST /finance/assets/:assetId/freeze`        | Freeze an asset route (operator)            |
| Chips       | `POST /chips/grant`                           | Operator chip grant                         |
| Notes       | `POST /notes`                                 | Save/update a player note                   |
| Notes       | `GET /notes` · `GET /notes/:targetId`         | Read notes                                  |
| Notes       | `DELETE /notes/:targetId`                     | Delete a note                               |
| Ops         | `GET /health` · `GET /ready` · `GET /metrics` | Liveness, readiness, metrics                |
| Docs        | `GET /docs`                                   | Swagger UI (OpenAPI)                        |

::: tip Idempotency
Retry only operations with stable domain identity: gameplay uses `requestId`
plus turn/version/action identity, and finance uses deposit log or withdrawal
intent identity. An arbitrary header does not make every mutation retryable.
:::

## Workers & queues

| Queue               | Worker                           | Effect                                                               |
| :------------------ | :------------------------------- | :------------------------------------------------------------------- |
| `settle-hand`       | prisma ledger settlement         | Applies awards − investments per player; rejects unbalanced batches  |
| `archive-hand`      | prisma `handHistory.upsert`      | Persists `HandHistory` — stable `jobId` + upsert tolerate retries    |
| `next-hand`         | engine DEAL via `GameManager`    | Auto-deals the next hand under the table lock                        |
| `player-timeout`    | engine TIMEOUT via `GameManager` | Folds/checks timed-out players; stale versions are rejected          |
| `tournament-blinds` | blind scheduler                  | Advances blind levels for running tournaments (repeatable scheduler) |
| `reconciliation`    | ledger reconciliation            | Periodic financial reconciliation (repeatable scheduler)             |

Two more maintenance loops run in the worker process: the game-outbox sweep
re-drives pending/failed side-effect intents from PostgreSQL, and the canonical
deposit monitor observes direct-treasury deposits. Both retry on transient
failures and fail closed.

Scheduled actions (timeout, auto-deal, blinds) run through the **same**
`GameManager.processAction` path as player actions: table lock → version check →
engine transition → persist → schedule effects → broadcast.

## Environment variables

| Variable                       | Default                  | Purpose                         |
| :----------------------------- | :----------------------- | :------------------------------ |
| `PORT` / `HOST`                | `3000` / `0.0.0.0`       | HTTP bind                       |
| `NODE_ENV`                     | `development`            | `test` + `ENABLE_TEST_ROUTES`   |
| `REDIS_URL`                    | `redis://localhost:6379` | Redis for state, queues, locks  |
| `DATABASE_URL`                 | — (required)             | SQLite path or `postgresql://…` |
| `JWT_SECRET` / `COOKIE_SECRET` | — (required)             | Session signing                 |
| `ALLOWED_SIWE_CHAIN_IDS`       | `1,31337`                | Accepted SIWE chains            |
| `ENABLE_TEST_ROUTES`           | `false`                  | Opt in to test-only routes      |
| `METRICS_TOKEN`                | `""`                     | Required for `/metrics` in prod |
| `SESSION_TTL_SECONDS`          | `604800`                 | Session lifetime                |
| `TABLE_REDIS_TTL_SECONDS`      | `86400`                  | Hot-state expiry                |
| `TABLE_LOCK_TTL_MS`            | `10000`                  | Redlock TTL                     |
| `ACTION_TIMEOUT_SECONDS`       | `30`                     | Player action timer             |
| `TOURNAMENT_BLIND_INTERVAL_MS` | `900000`                 | Level duration                  |
| `RECONCILIATION_INTERVAL_MS`   | `300000`                 | Reconciliation cadence          |
| `RATE_LIMIT_MAX`               | `100`                    | General rate limit              |

`CORS_ORIGIN`, `LOG_LEVEL` and the `RISK_*` scoring parameters are also
configurable; see `src/config.ts` for the full validated set.

## WebSockets

Clients connect to `/ws/play`. The session token is read from the `token` cookie
or the `sec-websocket-protocol: jwt.<token>` header. On every observation send the
credential is revalidated, so a revoked session or SERVICE credential stops
delivery immediately.

Client messages (defined in `@pokertools/types`):

| Message | Payload                   | Server response                     |
| :------ | :------------------------ | :---------------------------------- |
| `JOIN`  | `{ tableId, requestId? }` | full masked `OBSERVATION` (+ `ACK`) |
| `PING`  | `{ requestId }`           | `PONG`                              |
| `LEAVE` | `{ tableId, requestId? }` | `ACK`                               |

The `OBSERVATION` frame is the same authoritative, per-viewer masked boundary the
HTTP `GET /tables/:id/observation` route returns; private hole cards never travel
to another seat. Actions are submitted over HTTP `POST /tables/:id/action` with
`{ requestId, turnId, expectedVersion, actionId, amount? }`.

```ts
// Node.js 22+ — native WebSocket, native protocol
const ws = new WebSocket("wss://api.example.com/ws/play", ["jwt." + token]);
ws.onopen = () => ws.send(JSON.stringify({ type: "JOIN", tableId: "table_abc", requestId: "r1" }));
ws.onmessage = (event) => {
  const frame = JSON.parse(event.data as string);
  if (frame.type === "OBSERVATION") console.log("observation", frame.observation);
  else if (frame.type === "ERROR") console.error(frame.code, frame.message);
};
setInterval(
  () => ws.send(JSON.stringify({ type: "PING", requestId: crypto.randomUUID() })),
  15_000
);
```

## Calling the API with curl

```bash
# 1. Get a SIWE nonce
curl -s http://localhost:3000/auth/nonce | jq

# 2. Login (message + signature from the SDK's createSiweMessage / wallet)
curl -s -X POST http://localhost:3000/auth/login \
  -H "Content-Type: application/json" \
  -d '{"message":"...siwe message...","signature":"0x..."}' \
  | jq -r '.token' > /tmp/token

# 3. Observe a table, then act (mutation — send an idempotency key so retries are safe)
curl -s -X POST http://localhost:3000/tables/table_abc/action \
  -H "Authorization: Bearer $(cat /tmp/token)" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"requestId":"r1","turnId":"t1","expectedVersion":1,"actionId":"CALL"}' \
  | jq '.receipt, .observation'
```

## Testing the API

```bash
npm run test -w @pokertools/api    # ensure-db + Redis auto-start + vitest
```

The suite runs against a disposable SQLite database and a loopback Redis
instance, covering routes, ledger integrity, worker jobs, locking/version guards
and scheduled actions. The canonical gameplay/recovery acceptance harness runs
against real PostgreSQL + Redis with `npm run test:canonical -w @pokertools/api`.

## Source layout

| Path                   | Contains                                                                               |
| :--------------------- | :------------------------------------------------------------------------------------- |
| `src/routes/*`         | Fastify route plugins (auth, tables, tournaments, user, ws, finance, notes, chips)     |
| `src/services/*`       | GameManager, ledger, financial intents/incidents, chain registry                       |
| `src/workers/*`        | BullMQ workers (settle, archive, next-hand, timeout, persist, blinds, deposit monitor) |
| `src/plugins/*`        | Fastify plugins (queues, redis, auth, rate limits, swagger)                            |
| `prisma/schema.prisma` | Database schema                                                                        |
| `tests/`               | Vitest integration + unit suites and acceptance harnesses                              |

## Database

- **SQLite** — default for local dev and the unit suite
- **PostgreSQL** — production; also used by the acceptance harnesses

Prisma schema lives in `packages/api/prisma/schema.prisma`. Key models: `User`,
`Asset`, `AtomicAccount`, `JournalTransaction`/`JournalPosting`,
`DepositClaimRecord`, `WithdrawalIntentRecord`, `FinancialIncident`, `Table`,
`Tournament`, `HandHistory`, `PlayerNote`. Atomic account classes: `USER_AVAILABLE`,
`IN_PLAY_RESERVE`, `TOURNAMENT_RESERVE`, `PENDING_WITHDRAWAL`, `TREASURY_RESERVE`,
`OPERATOR`, `INCIDENT_OBLIGATION`.
