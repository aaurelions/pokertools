# @pokertools/api

REST & WebSocket API built with Fastify, Redis, BullMQ and Prisma. PostgreSQL is
the authoritative deployment database; Redis is a non-authoritative cache,
queue and lock coordination layer. SQLite exists only as a disposable local test
adapter generated from the same Prisma model.

## Running locally

```bash
# from the repo root
npm install
npm run dev:api        # Fastify server (watch mode)
npm run dev:workers    # BullMQ workers in watch mode
npm run db:migrate     # reviewed PostgreSQL migrations (postgresql:// DATABASE_URL)
npm run db:seed        # optional seed data
```

The server binds `HOST`/`PORT` (default `0.0.0.0:3000`). Redis must be reachable
at `REDIS_URL` (required explicitly in production); `npm run infra:up -w
@pokertools/api` starts a local Redis. Unit tests prepare a disposable SQLite
adapter automatically. PostgreSQL is required in production and always migrated
through the reviewed manifest — never `prisma db push` or Prisma Migrate.

## Architecture at a glance

| Layer       | Technology                                  | Responsibility                                                          |
| :---------- | :------------------------------------------ | :---------------------------------------------------------------------- |
| HTTP        | Fastify 5                                   | REST endpoints, SIWE auth, rate limiting, OpenAPI (`/docs`)             |
| Realtime    | `@fastify/websocket`                        | Masked `OBSERVATION` frames to subscribed sockets                       |
| Table state | PostgreSQL (`Table.state` + `stateVersion`) | Authoritative snapshot; compare-and-set inside the mutation transaction |
| Cache       | Redis (TTL snapshot cache + pub/sub)        | Rebuildable read cache and socket fan-out; never the authority          |
| Locks       | Redlock                                     | Serialize actions per table                                             |
| Persistence | Prisma 7                                    | Accounts, atomic ledger, deposits, withdrawals, incidents               |
| Jobs        | BullMQ 6                                    | Settlement, archiving, auto-dealing, timeouts, blinds                   |
| Validation  | Zod 4                                       | Request/response schemas (shared with `@pokertools/types`)              |

Redis failures cannot undo or falsely reject a committed PostgreSQL mutation:
side-effect intents are written to a durable outbox in the same transaction and
dispatched best-effort afterwards.

Treasury signing is isolated in the separate `@pokertools/custody` executable.
The API reserves EIP-712 withdrawal intents and never loads signing material;
`src/safety.ts` refuses to start the public process if custody key/decryption
settings are present in its environment.

## REST endpoints

| Area        | Method & path                                         | Purpose                                     |
| :---------- | :---------------------------------------------------- | :------------------------------------------ |
| Auth        | `POST /auth/nonce`                                    | SIWE nonce                                  |
| Auth        | `POST /auth/login`                                    | SIWE session login                          |
| Auth        | `GET /auth/me`                                        | Current principal                           |
| Auth        | `POST /auth/logout`                                   | End session                                 |
| Auth        | `POST /auth/service-credentials`                      | Mint a scoped SERVICE credential (operator) |
| Auth        | `GET /auth/service-credentials`                       | List SERVICE credentials (operator)         |
| Auth        | `POST /auth/service-credentials/:id/revoke`           | Revoke a SERVICE credential (operator)      |
| Auth        | `POST /auth/service-credentials/:id/rotate`           | Rotate a SERVICE credential (operator)      |
| Auth        | `POST /auth/service-principals`                       | Provision a SERVICE principal (operator)    |
| Auth        | `POST /auth/service-principals/:id/delegation/revoke` | Revoke a principal's delegation (operator)  |
| User        | `GET /user/me`                                        | Profile                                     |
| User        | `GET /user/history`                                   | Hand history                                |
| Tables      | `GET /tables`                                         | List active tables (WALLET principals)      |
| Tables      | `POST /tables`                                        | Create a table                              |
| Tables      | `GET /tables/:id?since=`                              | Masked state (delta-aware)                  |
| Tables      | `POST /tables/:id/buy-in`                             | Cash buy-in                                 |
| Tables      | `GET /tables/:id/observation`                         | Per-seat observation + legal actions        |
| Tables      | `POST /tables/:id/action`                             | Submit a canonical action                   |
| Tables      | `GET`/`POST /tables/:id/chat`                         | Table chat                                  |
| Tables      | `GET /tables/:id/replay`                              | Hand replay                                 |
| Tables      | `POST /tables/:id/add-chips`                          | Top up                                      |
| Tables      | `POST /tables/:id/stand`                              | Leave table                                 |
| Tournaments | `GET /tournaments`                                    | List                                        |
| Tournaments | `POST /tournaments`                                   | Create                                      |
| Tournaments | `GET /tournaments/:id`                                | Detail                                      |
| Tournaments | `POST /tournaments/:id/register`                      | Enter                                       |
| Tournaments | `POST /tournaments/:id/start`                         | Kick off                                    |
| Tournaments | `POST /tournaments/:id/advance-blinds`                | Manual level advance                        |
| Tournaments | `POST /tournaments/:id/reconcile`                     | Escrow/prize reconciliation                 |
| Tournaments | `POST /tournaments/:id/settle`                        | Settle payouts                              |
| Finance     | `GET /finance/assets`                                 | Public asset registry                       |
| Finance     | `GET /finance/balances`                               | Canonical per-asset balances                |
| Finance     | `POST /finance/withdrawals/intents`                   | EIP-712 withdrawal submission               |
| Finance     | `GET /finance/withdrawals`                            | Withdrawal history                          |
| Finance     | `GET /finance/withdrawals/:id`                        | Withdrawal detail                           |
| Finance     | `POST /finance/deposits/claim`                        | Claim an exact on-chain deposit log         |
| Finance     | `GET /finance/deposits/:id`                           | Deposit claim detail                        |
| Finance     | `GET /finance/incidents`                              | List financial incidents (operator)         |
| Finance     | `POST /finance/incidents/:id/resolve`                 | Resolve an incident (operator)              |
| Finance     | `POST /finance/assets/:assetId/freeze`                | Freeze an asset route (operator)            |
| Chips       | `POST /chips/grant`                                   | Operator chip grant                         |
| Notes       | `POST /notes`                                         | Save/update a player note                   |
| Notes       | `GET /notes` · `GET /notes/:targetId`                 | Read notes                                  |
| Notes       | `DELETE /notes/:targetId`                             | Delete a note                               |
| Ops         | `GET /health` · `GET /ready` · `GET /metrics`         | Liveness, readiness, metrics                |
| Docs        | `GET /docs`                                           | Swagger UI (OpenAPI)                        |

The table collection (`GET /tables`) is a WALLET surface. A table-scoped
SERVICE credential is denied with `403 SERVICE_SCOPE_FORBIDDEN`: a bound
credential reaches only its own room through `GET /tables/:id` (with its
granted table scope), so the global listing can never leak other rooms.

::: tip Idempotency
Retry only operations with stable domain identity: gameplay uses `requestId`
plus turn/version/action identity, and finance uses deposit log or withdrawal
intent identity. An arbitrary header does not make every mutation retryable.
:::

### SERVICE principal delegation revocation

`POST /auth/service-principals/:id/delegation/revoke` (operator-only) durably
revokes an orchestration delegation. The body is a strict empty object and the
operation is naturally idempotent: repeating the call returns the original
`revokedAt` timestamp without a second transition. Revocation blocks the
delegate from rostering the principal into new competitions and from issuing
further agent credentials for it, but it deliberately does **not** revoke the
principal or any already-issued table credential — those keep working until
they expire or are explicitly revoked. Re-delegation/reassignment is not
supported: a different orchestration owner requires a newly provisioned
principal.

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

| Variable                       | Default                  | Purpose                                       |
| :----------------------------- | :----------------------- | :-------------------------------------------- |
| `PORT` / `HOST`                | `3000` / `0.0.0.0`       | HTTP bind                                     |
| `NODE_ENV`                     | `development`            | `test` + `ENABLE_TEST_ROUTES`                 |
| `REDIS_URL`                    | `redis://localhost:6379` | Redis for cache, queues, locks, pub/sub       |
| `DATABASE_URL`                 | — (required)             | Required; production must be `postgresql://…` |
| `JWT_SECRET` / `COOKIE_SECRET` | — (required)             | Session signing                               |
| `ALLOWED_SIWE_CHAIN_IDS`       | `1,31337`                | Accepted SIWE chains                          |
| `ENABLE_TEST_ROUTES`           | `false`                  | Opt in to test-only routes                    |
| `METRICS_TOKEN`                | `""`                     | Required for `/metrics` in prod               |
| `SESSION_TTL_SECONDS`          | `604800`                 | Session lifetime                              |
| `TABLE_REDIS_TTL_SECONDS`      | `86400`                  | Snapshot cache TTL (non-durable)              |
| `TABLE_LOCK_TTL_MS`            | `10000`                  | Redlock TTL                                   |
| `ACTION_TIMEOUT_SECONDS`       | `30`                     | Player action timer                           |
| `TOURNAMENT_BLIND_INTERVAL_MS` | `900000`                 | Level duration                                |
| `RECONCILIATION_INTERVAL_MS`   | `300000`                 | Reconciliation cadence                        |
| `RATE_LIMIT_MAX`               | `100`                    | General rate limit                            |

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

| Path                   | Contains                                                                                                        |
| :--------------------- | :-------------------------------------------------------------------------------------------------------------- |
| `src/routes/*`         | Fastify route plugins (auth, tables, tournaments, user, ws, finance, notes, chips)                              |
| `src/services/*`       | GameManager, ledger, financial intents/incidents, chain registry                                                |
| `src/workers/*`        | BullMQ workers (settle, archive, next-hand, timeout, blinds, reconciliation) plus the canonical deposit monitor |
| `src/plugins/*`        | Fastify plugins (queues, redis, auth, rate limits, swagger)                                                     |
| `prisma/schema.prisma` | Database schema                                                                                                 |
| `tests/`               | Vitest integration + unit suites and acceptance harnesses                                                       |

## Database

- **PostgreSQL** — authoritative deployment database. Production startup fails
  without a `postgresql://` URL; migrations always run through the reviewed
  SHA-256 manifest (`npm run db:migrate`). Acceptance harnesses use real
  PostgreSQL.
- **SQLite** — disposable local test adapter generated from the same Prisma
  model; no migration history and no proof of PostgreSQL financial/audit
  constraints.

Redis is non-authoritative and rebuildable: it holds a TTL snapshot cache,
BullMQ queues, Redlock coordination locks and pub/sub fan-out. A Redis failure
cannot undo or falsely reject a committed PostgreSQL mutation.

Prisma schema lives in `packages/api/prisma/schema.prisma`. Key models: `User`,
`Asset`, `AtomicAccount`, `JournalTransaction`/`JournalPosting`,
`DepositClaimRecord`, `WithdrawalIntentRecord`, `FinancialIncident`, `Table`,
`Tournament`, `HandHistory`, `PlayerNote`. Atomic account classes: `USER_AVAILABLE`,
`IN_PLAY_RESERVE`, `TOURNAMENT_RESERVE`, `PENDING_WITHDRAWAL`, `TREASURY_RESERVE`,
`OPERATOR`, `INCIDENT_OBLIGATION`.
