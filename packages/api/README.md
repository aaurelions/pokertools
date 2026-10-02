# @pokertools/api

Fastify room API and background workers. Owns authentication, principal/seat
authorization, PostgreSQL game commits/outbox, tournaments, chip economy,
atomic-asset journals, read-only chain verification and readiness. Treasury
signing belongs only to custody.

```sh
# From repository root
cp packages/api/.env.example packages/api/.env
npm ci
npm run build
npm run dev:api
npm run dev:workers # separate terminal
npm test -w @pokertools/api
```

Local tests prepare disposable SQLite/Redis. PostgreSQL always uses
`npm run db:migrate -w @pokertools/api`, never `prisma db push` or Prisma Migrate.
See [migration policy](prisma/postgres/README.md).

## Public protocol

Use the SDK and `@pokertools/types` schemas; OpenAPI is at `/docs`.

- `/auth`: SIWE nonce/login/session lifecycle and scoped SERVICE credentials.
- `/tables`: creation/seating, observation, action, chat and replay. Submit
  server-issued actions with turn/version/request correlation, never actor/raw reducer input.
- `/tournaments`: registration, lifecycle and ordered public events.
- `/chips`: operator chip grants, explicitly separate from financial assets.
- `/finance`: assets, balances, direct treasury claims, EIP-712 withdrawal intents,
  operator incidents and reconciliation.
- `/user`, `/notes`: profile/history and private notes.
- `/ws/play`: masked observations/events/chat and request correlation; cookie or
  bearer subprotocol authentication, never query-string tokens.
- `/health`: liveness. `/ready`: live fail-closed readiness. `/metrics` is
  production bearer-protected and disabled without its token.

Authorization precedes replay. Shared schemas, not historical examples, define
wire contracts. Private snapshots and accounting internals never cross transports.

## Private integration surfaces

`@pokertools/api/finance-core` exports key-free accounting/chain-reading adapters
for custody. `@pokertools/api/database` exports the generated persistence client.
Neither is a browser API; the public runtime cannot depend on signing code.

See [architecture](../../docs/guide/architecture.md),
[configuration](../../docs/guide/configuration.md), [testing](../../docs/guide/testing.md),
[security](../../SECURITY.md) and [deployment](../../deploy/README.md).
