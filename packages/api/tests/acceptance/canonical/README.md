# Canonical acceptance harness (PostgreSQL + Redis loopback)

Acceptance tests for the canonical gameplay and recovery protocol. They drive the
public HTTP/WebSocket protocol and provision their own real infrastructure.

## Run

From `packages/api`:

```bash
npx vitest run --config tests/acceptance/canonical/vitest.acceptance.config.ts
# or
npm run test:canonical
```

The suite provisions:

- **PostgreSQL**: a disposable `postgres:18-alpine` container on a random port.
- **Redis**: a dedicated `redis-server` on a random port (or `redis:8-alpine`).
- **Schema**: synced from `prisma/schema.prisma` through `prisma.config.ts`,
  which switches the datasource provider to PostgreSQL from `DATABASE_URL`. The
  global setup generates the PostgreSQL client into the build output (gitignored)
  and restores the SQLite client in teardown, so concurrent SQLite suites are not
  disturbed.

## Files

- `infra.ts` — PostgreSQL/Redis provisioning, schema sync, Redis kill/restart.
- `global-setup.ts` / `setup-env.ts` — lifecycle and per-file environment.
- `harness.ts` — app boot, SIWE wallet login, operator bootstrap, SERVICE
  credential minting, chip-grant funding fixture, canonical HTTP client.
- `schemas.ts` — test-side observation schema.
- `harness-smoke.acceptance.test.ts` — health/readiness, SERVICE credential
  minting and observation delivery.
- `canonical-gameplay.acceptance.test.ts` — SERVICE-only, mixed, ten-seat,
  ownership, idempotency/stale, masking and reconnect.
- `canonical-recovery.acceptance.test.ts` — Redis FLUSHALL / kill / API restart
  recovery.
- `canonical-race.acceptance.test.ts` — a client action racing the scheduled
  timeout worker in a separate OS process.
- `timeout-ownership.acceptance.test.ts` — scheduled-timeout ownership epoch:
  original deadline across blind advances, stale leases (same actor, TIME_BANK
  renewal, hand/actor change), legacy strict version guard and stale recovery.
- `timeout-worker-main.ts` — standalone timeout worker entry point.

## Scope

- Gameplay is submitted only through the public canonical protocol:
  `GET /tables/:id/observation` and
  `POST /tables/:id/action` `{requestId,turnId,expectedVersion,actionId,amount?}`.
- No direct DB mutation of actions, seats, stacks or eliminations. Seats are
  claimed through the public `buy-in` route.
- Direct DB/service access is limited to declared fixtures: SIWE/operator auth
  setup, chip-grant funding (`financialManager.grantChips`) and read-only event
  inspection. Funding fixtures are not financial acceptance.
- SERVICE principals never receive a fabricated wallet address.
- Unexpected HTTP statuses fail the test.

Finance/custody/chain acceptance lives separately in `packages/e2e/tests/finance`.
