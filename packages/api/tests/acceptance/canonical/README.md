# Canonical acceptance harness (PostgreSQL + Redis loopback)

Owned new test surface for the canonical gameplay/recovery protocol. It does not
modify any route, service, model, SDK or shared config file.

## Run

From `packages/api`:

```bash
npx vitest run --config tests/acceptance/canonical/vitest.acceptance.config.ts
```

The suite provisions its own real infrastructure:

- **PostgreSQL**: a disposable `postgres:18-alpine` container on a random port.
- **Redis**: a dedicated `redis-server` on a random port (or `redis:8-alpine`).
- **Schema**: synced from `prisma/schema.prisma` through `prisma.config.ts`,
  which switches the datasource provider to PostgreSQL from `DATABASE_URL`.
  Because this Prisma/Vitest version does not apply `resolve.alias` to the API's
  workspace-relative `generated/prisma` import, the global setup regenerates the
  PostgreSQL client into the normal `generated/prisma` build output (gitignored)
  and restores the SQLite client in teardown. No shared source is edited.

Files:

- `infra.ts` — PostgreSQL/Redis provisioning, schema sync, Redis kill/restart.
- `global-setup.ts` / `setup-env.ts` — lifecycle and per-file environment.
- `harness.ts` — app boot, SIWE wallet login, operator bootstrap, SERVICE
  credential minting, chip-grant funding fixture, canonical HTTP client.
- `schemas.ts` — test-side observation schema that tolerates a null `turnId`.
- `harness-smoke.acceptance.test.ts` — proves the harness itself.
- `canonical-gameplay.acceptance.test.ts` — SERVICE-only, mixed, 10-seat,
  ownership, idempotency/stale, masking, reconnect, chip conservation.
- `canonical-recovery.acceptance.test.ts` — Redis FLUSHALL / kill / API restart
  with no lost version, duplicate action or reordered event.
- `canonical-race.acceptance.test.ts` — client action races the scheduled
  timeout worker in a separate OS process.
- `timeout-worker-main.ts` — standalone timeout worker entry point.

## Hard rules honoured

- Gameplay is submitted only through the public canonical protocol:
  `GET /tables/:id/observation` and
  `POST /tables/:id/action` `{requestId,turnId,expectedVersion,actionId,amount?}`.
- No direct DB mutation of actions, seats, stacks or eliminations. Seats are
  claimed through the public `buy-in` route.
- Direct DB/service access is limited to declared fixtures: SIWE/operator auth
  setup, chip-grant funding (`financialManager.grantChips`) and read-only event
  inspection. Funding fixtures are explicitly **not** financial acceptance.
- SERVICE principals never receive a fabricated wallet address.
- Unexpected HTTP statuses fail the test; nothing is swallowed.

## Interface dependencies discovered

Executed status against the current in-flight tree
(`npx vitest run --config tests/acceptance/canonical/vitest.acceptance.config.ts`,
from `packages/api`): **16/16 tests green**.

- **All gameplay/recovery/race green:** SERVICE credential minting; SERVICE
  seating and two-SERVICE / mixed 2-wallet-2-SERVICE hands; ten-seat seating
  with per-viewer masking; ownership rejection; duplicate `requestId` replay
  with no second version; stale `expectedVersion` conflict; reconnect version
  stability; table-restriction denial; Redis FLUSHALL and kill/restart recovery
  with no lost version, no duplicate action and no reordered sealed event chain;
  API process restart recovery; timeout/action race with a real worker in a
  separate OS process (real `GameManager` CAS); readiness never 500s.
- **Fail-hard protocol/consistency assertions (no fallback, nothing swallowed):**
  - every accepted action response is the canonical `{ receipt, observation }`;
    the receipt must identify the submitted `requestId`/`actionId` and submitted
    `tableId`/`turnId`, and its `version`/`eventSeq` must equal the resulting
    observation's counters with `version` strictly advancing
    (`harness.actOrThrow`);
  - a second deal after settlement continues the monotonic table-global
    `version`/`eventSeq` (a new hand never fake-resets the counters) and advances
    `handId`;
  - the WebSocket delivers a strict canonical `OBSERVATION` on `JOIN` and a
    fresh full `OBSERVATION` (same authoritative boundary the HTTP action
    returned) after an accepted action — never a notification-only frame.
- **Recently resolved (was red):** the hand-boundary observation used to return
  `500 INVALID_SERVER_RESPONSE`; the authority now derives a non-null boundary
  `turnId` and offers `DEAL`, so `SeatObservationSchema` validates at every
  observed turn. `GET /ready` used to return `500`; it now evaluates platform
  readiness and returns a conforming `503`/`200` body.
- **Resolved earlier:** SERVICE principals were initially denied on `/buy-in`
  and `/observation`; SERVICE seating is now scoped, and the action response is
  the canonical `{ receipt, observation }`.
- **PostgreSQL schema sync vs raw SQL migrations.** `prisma db push` from
  `schema.prisma` (used here) and the raw `prisma/postgres/*.sql` migrations
  define different shapes (Prisma enums vs `TEXT`). This is an accepted interim:
  the supervisor registers the converged PostgreSQL files in
  `prisma/postgres/migrations.json` once all SQL is final, after which this
  suite must switch to those checksum-verified migrations (`scripts/migrate-postgres.mjs`)
  so the same source of truth provisions schema and migration integrity.

## Not covered here (separate ownership)

- Four-table MTT acceptance and the existing Docker network harness
  (`packages/e2e`) — must be migrated to the canonical protocol by its owner;
  this harness intentionally does not touch it.
- Service-credential `POST/GET/revoke` route-level tests —
  `tests/integration/service-auth.test.ts` (separate owner).
- Finance/custody/chain acceptance — separate owner.
