# Testing & Coverage

This page is the reference for how the monorepo runs tests and how coverage gates are
configured. Coverage is a **regression floor**, not a quality target: thresholds are set
close to the current baseline so a real regression fails CI while normal run-to-run
variance does not. Thresholds are tracked in the package configs and summarised below.

## Commands

| Command                                      | Scope                                         | Notes                                                              |
| :------------------------------------------- | :-------------------------------------------- | :----------------------------------------------------------------- |
| `npm test`                                   | Every workspace (`test` script)               | Full monorepo suite.                                               |
| `npm run test:quick`                         | engine, evaluator, types, sdk                 | Compact output; used by the pre-commit hook.                       |
| `npm run test:coverage`                      | Every workspace with a `test:coverage` script | Enforces all coverage gates. API/custody need Redis + test SQLite. |
| `npm run test:coverage -w @pokertools/<pkg>` | One package                                   | See the runner table for provider and config.                      |

Run a single package's suite with `npm test -w @pokertools/<pkg>`.

### Acceptance prerequisites

Some suites need infrastructure and are not part of `npm test`:

| Command                                               | Prerequisites                                                                               |
| :---------------------------------------------------- | :------------------------------------------------------------------------------------------ |
| `npm run test:canonical -w @pokertools/api`           | Built workspace; Docker provisions disposable PostgreSQL + Redis.                           |
| `npm run test:postgres:migrations -w @pokertools/api` | Docker — the test provisions its own disposable PostgreSQL container.                       |
| `npm run test:postgres:ledger -w @pokertools/api`     | Docker — provisions disposable PostgreSQL; missing Docker fails closed.                     |
| `npm run contracts:test -w @pokertools/custody`       | Foundry (`forge`) and git submodules (`forge-std`, `openzeppelin-contracts`).               |
| `npm run e2e:docker`                                  | Docker + built images.                                                                      |
| `npm run e2e:finance`                                 | Docker, Foundry and built workspace; disposable PostgreSQL/Redis and two real Anvil chains. |

CI checks out git submodules recursively so the custody contract tests can build.

## Test runners

| Package     | Runner             | Config                              | Coverage provider    |
| :---------- | :----------------- | :---------------------------------- | :------------------- |
| `types`     | Jest (`@swc/jest`) | `packages/types/jest.config.js`     | Babel (Jest default) |
| `evaluator` | Jest (`@swc/jest`) | `packages/evaluator/jest.config.js` | Babel (Jest default) |
| `engine`    | Jest (`@swc/jest`) | `packages/engine/jest.config.js`    | Babel (Jest default) |
| `sdk`       | Vitest (jsdom)     | `packages/sdk/vitest.config.ts`     | V8 (configured)      |
| `api`       | Vitest (node)      | `packages/api/vitest.config.ts`     | V8 (configured)      |
| `custody`   | Vitest (node)      | `packages/custody/vitest.config.ts` | V8 (configured)      |

Jest's default coverage provider is **Babel**; these configs do not override
`coverageProvider`. `@swc/jest` is only the transform. The Vitest packages set
`provider: "v8"` explicitly.

## Coverage gates

Thresholds are statements / branches / functions / lines.

| Package                 | Enforced thresholds | Risk tier |
| :---------------------- | :------------------ | :-------- |
| `@pokertools/engine`    | 90 / 82 / 95 / 91   | 1         |
| `@pokertools/evaluator` | 98 / 95 / 99 / 99   | 1         |
| `@pokertools/custody`   | 66 / 60 / 66 / 70   | 1         |
| `@pokertools/types`     | 77 / 69 / 65 / 85   | 2         |
| `@pokertools/sdk`       | 81 / 77 / 83 / 81   | 2         |
| `@pokertools/api`       | 75 / 65 / 77 / 77   | 2         |

### Why risk tiers

- **Tier 1 — money and correctness.** `engine` owns poker rules, pot construction, rake and
  chip conservation; `evaluator` owns hand ranking; `custody` owns withdrawal signing,
  nonce serialization and treasury reconciliation. These are deterministic and heavily
  unit-tested, so their gates are held close to the measured baseline.
- **Tier 2 — contracts, transport and orchestration.** `types` (schemas), `sdk` (HTTP/WS
  client, React hooks) and `api` (Fastify routes, BullMQ workers, Prisma stores) contain
  large integration surfaces exercised by the Docker/e2e suites rather than unit tests.
  Their gates are a few points lower so the gate still catches regressions without forcing
  unit tests for I/O-bound glue.

## Exclusions and known gaps

The atomic journal and custody withdrawal workflow also have explicit module
floors in their Vitest configurations. Their branches are held near their
measured unit/integration baseline, not an arbitrary 100% target. Live chain
fault/reorg acceptance remains required even when those floors pass.

Coverage is restricted to production sources; test infrastructure never counts:

- Vitest packages restrict `include` to `src/**` (`packages/sdk` also allows `src/**/*.tsx`),
  so test helpers such as `packages/custody/tests/core/fakes.ts` are never measured.
- Jest packages set `collectCoverageFrom: ["src/**/*.ts"]`.
- `node_modules/`, `dist/`, `generated/` (Prisma client), `coverage/`, `tests/` and
  `*.config.ts` are excluded everywhere.

Known low-coverage areas, kept counted on purpose so the number stays honest:

- **Process entrypoints** (`packages/api/src/server.ts`, `packages/api/src/workers.ts`,
  `packages/custody/src/index.ts`) are not imported by unit tests; they are covered by the
  Docker/e2e suites.
- **Live infrastructure adapters** (`packages/custody/src/core/viem-ports.ts`, Prisma
  adapters, on-chain workers).

## Intentional skips

Production admission uses a fresh private PostgreSQL/Redis Docker network and
the actual built runtime image (no application mocks):

```bash
npm run e2e:docker
npm run build:production:acceptance
npm run test:production -w @pokertools/api
node scripts/test-runtime-dependencies.mjs ghcr.io/aaurelions/pokertools:production-acceptance
```

`POKERTOOLS_PRODUCTION_IMAGE` selects another already-built image. The test
defaults to the production-acceptance PostgreSQL image, never the deliberately
SQLite-provider Docker E2E image. Use the same image for runtime inspection.
The test
verifies configuration rejection, fresh migrations/startup/readiness, no implicit
asset seed, live migration-drift blocking and liveness/readiness separation.
Funded assets, quorum, custody and reconciliation still require two-chain E2E.

- `packages/evaluator/tests/frequency.test.ts` skips the exhaustive 7-card frequency pass in
  ordinary local runs. CI enables it; run it locally when changing evaluator core logic:

  ```bash
  ENABLE_HEAVY_TESTS=true npm test -w @pokertools/evaluator
  ```

## CI wiring

`.github/workflows/ci.yml` checks out submodules recursively, audits production dependencies,
scans secrets and verifies scanner canaries, checks package boundaries and public publish
contents, then runs coverage (including exhaustive evaluator frequencies). PostgreSQL
migration/model parity, ledger acceptance, canonical PostgreSQL/Redis/HTTP acceptance and
real local-chain finance acceptance are separate required checks, not substitutes for unit
coverage. Benchmarks report performance; they do not prove behavioral correctness.

Coverage summary files (`coverage/coverage-summary.json`) are written per package and are
git-ignored. Vitest configs set `reportOnFailure: true` so a coverage report is still
emitted when a test fails; thresholds still fail the run.

## Conventions

- Add a regression test for every bug fix in the package that owns the logic.
- Use deterministic unit tests (fake clocks, fake timers, injected ports) to isolate financial
  branches. Money, persistence and concurrency guarantees also require real PostgreSQL,
  public HTTP/SDK and chain/custody acceptance at their actual boundaries.
- Do not run multiple API suites in parallel: they share one SQLite file and Redis DB. The
  API Vitest config pins `pool: "forks"`, `maxWorkers: 1` and `fileParallelism: false`.
- When a threshold is intentionally changed, update both the package config and the table
  above in the same change.
