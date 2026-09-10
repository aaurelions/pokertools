# Getting Started

Welcome to the PokerTools monorepo — an enterprise-grade Texas Hold'em stack split into small, independently publishable packages.

## Requirements

| Tool                        | Minimum     | Notes                                                                 |
| :-------------------------- | :---------- | :-------------------------------------------------------------------- |
| Node.js                     | `>= 24.0.0` | LTS recommended; CI runs `24.x`                                       |
| npm                         | `>= 10.0.0` | Workspaces + `allowScripts` support                                   |
| Redis `>= 7`                | required    | Table state, BullMQ queues, locks (CI uses `redis:8-alpine`)          |
| SQLite `>= 3` or PostgreSQL | required    | Prisma persistence (SQLite for local/test, PostgreSQL for production) |
| Solidity toolchain          | optional    | Foundry (`forge`) only for the admin contract suite                   |
| Python/build tools          | optional    | Only if native modules (`better-sqlite3`) need compiling              |

## Repository layout

| Path                 | Package                 | Description                                              |
| :------------------- | :---------------------- | :------------------------------------------------------- |
| `packages/types`     | `@pokertools/types`     | Domain state, actions, pots, configs, DTOs, Zod schemas  |
| `packages/evaluator` | `@pokertools/evaluator` | 5/6/7-card hand evaluation — pure integer score tables   |
| `packages/engine`    | `@pokertools/engine`    | Immutable game state machine (reducer + rules)           |
| `packages/sdk`       | `@pokertools/sdk`       | HTTP client, WebSocket transport, React hooks            |
| `packages/api`       | `@pokertools/api`       | Fastify REST/WS API, Redis state, BullMQ workers, Prisma |
| `packages/admin`     | `@pokertools/admin`     | Blockchain sweeps, withdrawals, gas monitoring           |
| `packages/bench`     | `@pokertools/bench`     | Evaluator + API/worker/socket benchmarks                 |
| `packages/e2e`       | `@pokertools/e2e`       | Docker/Anvil end-to-end scenarios                        |

## Install

```bash
git clone https://github.com/aaurelions/pokertools.git
cd pokertools
npm install        # runs prepare: hooks, Prisma client generation, tsc build
```

:: tip
The repository pins npm lifecycle scripts through the `allowScripts` field — only approved
native packages (Prisma, `better-sqlite3`, esbuild, SWC, …) may run install scripts.
:::

## Verify the setup

```bash
npm run typecheck      # tsc -b across workspaces
npm run build          # build all packages
npm test               # run every workspace test suite
npm run validate       # format check + lint + tests
```

## Common scripts

| Script                      | Purpose                                           |
| :-------------------------- | :------------------------------------------------ |
| `npm run dev:api`           | Start the API in watch mode                       |
| `npm run dev:workers`       | Start BullMQ workers in watch mode                |
| `npm run start:api`         | Run the built API                                 |
| `npm run bench`             | Run evaluator/API benchmark suite                 |
| `npm run test:quick`        | Engine, evaluator, types and SDK tests only       |
| `npm run lint` / `lint:fix` | ESLint across `.ts` sources                       |
| `npm run format:check`      | Prettier check (part of `validate` / `precommit`) |
| `npm run db:migrate`        | Prisma migration (API)                            |
| `npm run db:seed`           | Seed the database                                 |
| `npm run e2e:docker`        | Docker Compose + Anvil end-to-end suite           |
| `npm run deploy:prod`       | Compose production deployment                     |
| `npm run db:backup`         | Trigger the backup container inside compose       |

## First steps per package

| Goal                         | Jump to                                      |
| :--------------------------- | :------------------------------------------- |
| Score a poker hand           | [Evaluator Quick Start](/packages/evaluator) |
| Simulate a full hand         | [Engine Quick Start](/packages/engine)       |
| Call the API from TypeScript | [SDK Quick Start](/packages/sdk)             |
| Run the full-stack API       | [API setup](/packages/api)                   |
| Deploy the stack             | [Deployment guide](/deployment)              |

## Pre-commit hooks

The repository enables its own hooks directory during `npm install`:

```bash
git config core.hooksPath   # => .githooks
```

The pre-commit hook runs `format:check`, `lint` and the quick test suite, so committing
is safe even without a local CI run.

## Troubleshooting

| Symptom                                               | Cause & fix                                                                                                                                                                                                                    |
| :---------------------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ECONNREFUSED` at `127.0.0.1:6379`                    | Redis isn't running. Run `npm run infra:up -w @pokertools/api` (starts a local daemon in `.runtime/`) or start your own. API tests auto-start Redis via `pretest`.                                                             |
| `Could not locate the bindings file` (better-sqlite3) | Native module postinstall was blocked or skipped. `npm rebuild better-sqlite3` after confirming the version is listed in the root `allowScripts` (both `12.11.1` — pinned by `@prisma/adapter-better-sqlite3` — and `13.0.3`). |
| `Version mismatch` errors from workers                | Expected: a stale scheduled job raced a player action. The job is retried by BullMQ; if it persists, check that only one worker process per queue is running.                                                                  |
| `npm install` reports blocked install scripts         | New native packages must be added to `allowScripts` in the root `package.json`, then re-run `npm install`.                                                                                                                     |
| `prisma db push` fails with NOT NULL drift            | In test env the schema is force-reset automatically; for local dev run `npm run db:migrate` or `db:reset`.                                                                                                                     |
| SDK requests hang                                     | Check `timeout` config (default 10 s) and that `baseUrl` is reachable; mutation replays only happen with an `idempotencyKey`.                                                                                                  |
| Forge tests fail to compile                           | Run `npm run contracts:build -w @pokertools/admin` to pull dependencies, or install Foundry via `foundryup`.                                                                                                                   |
