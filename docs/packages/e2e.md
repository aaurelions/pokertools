# @pokertools/e2e

End-to-end suites that exercise the full stack. The package holds two independent
paths with separate Vitest configs:

- **Docker E2E** (`vitest.config.ts`, `tests/docker-e2e.test.ts`) — a single-chain
  SQLite smoke run over the Docker Compose stack.
- **Finance/custody acceptance** (`vitest.finance.config.ts`, `tests/finance/*`)
  — two isolated Anvil chains, a disposable PostgreSQL + Redis pair, the real API
  and the real custody `WithdrawalWorkflow` over durable Prisma ports.

## Docker E2E

```bash
# from the repo root (builds types, SDK and Foundry fixtures first)
npm run e2e:docker
```

This brings up `docker-compose.e2e.yml` with the API, BullMQ workers, Redis,
and a local Anvil chain, then runs `tests/docker-e2e.test.ts`. It covers health
and docs routes, SIWE login, deposits claimed by exact log identity, a multiplayer
table (buy-ins, actions, stand), a reserved EIP-712 withdrawal driven through the
custody workflow, and WebSocket observation delivery.

| Concern          | Detail                                                            |
| :--------------- | :---------------------------------------------------------------- |
| Database         | SQLite bind-mounted from `POKERTOOLS_E2E_RUNTIME`                 |
| Chain            | Standalone Anvil on `127.0.0.1:8545`; no external RPC keys        |
| Contract fixture | `MockUSDC` (direct-treasury deposits do not use a batch contract) |
| Secrets          | Deterministic local-only values, never production                 |

## Finance / custody acceptance

```bash
# from the repo root
npm run e2e:finance
```

The runner builds the Foundry fixtures and launches the suite; the suite's global
setup starts two distinct Anvil chains (31337/31338) and fresh
`postgres:18-alpine` + `redis:8-alpine` containers on ephemeral ports, then runs
`tests/finance/*`. Balances under assertion come from real on-chain transfers and
balanced journal postings.

| File                                          | Covers                                                                                                                               |
| :-------------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------- |
| `harness-smoke.test.ts`                       | Two-chain topology, 6/18-decimal assets, exact ERC-20 log identity, snapshot/revert, quorum proxies                                  |
| `quorum-disagreement.acceptance.test.ts`      | ChainRegistry quorum: distinct endpoints, duplicate/chain-mismatch rejection, disagreement + freeze                                  |
| `deposit-claim.acceptance.test.ts`            | Exact-log deposit verification: wrong chain/token/sender/recipient, depth, frozen asset                                              |
| `deposit-ledger.acceptance.test.ts`           | Deposit credits the exact on-chain amount once and is idempotent                                                                     |
| `api-routes.acceptance.test.ts`               | Real Fastify + SIWE: assets, balances, deposit claim, withdrawal intents, bad signature, 404s                                        |
| `withdrawal-custody.acceptance.test.ts`       | Persist-before-broadcast, broadcast, quorum finality, restart from PostgreSQL, exact-byte recovery, gas starvation, reorg obligation |
| `reconciliation-incidents.acceptance.test.ts` | Real shortfall incident + freeze, matched reconciliation, operator resolution, quorum fail-closed                                    |

Helpers live in `tests/finance/helpers/`: `anvil-two-chain.ts`, `quorum-proxy.ts`,
`fresh-infra.ts`, `custody-harness.ts`, `prisma-accounting.ts`, `eip712.ts`,
`finance-fixtures.ts`, `finance-api-harness.ts`, `setup-env.ts`, `infra.ts`.
`tests/finance/helpers/fresh-infra.ts` generates a private PostgreSQL Prisma
client and applies the reviewed migrations from `packages/api/prisma/postgres`;
`vitest.finance.config.ts` redirects the workspace `generated/prisma` import to it,
so the shared SQLite client is never modified.

The Foundry fixture `packages/custody/contracts/test/acceptance/MockAssetToken.sol`
is test-only and never ships as custody code.

## Relation to unit/integration tests

| Layer        | Where                        | What                                                  |
| :----------- | :--------------------------- | :---------------------------------------------------- |
| Engine rules | `packages/engine/tests`      | Reducer correctness, invariants, security             |
| Evaluator    | `packages/evaluator/tests`   | Scores, frequencies, validation                       |
| API + DB     | `packages/api/tests`         | Routes, workers, ledger integrity, canonical protocol |
| Custody      | `packages/custody/tests`     | Withdrawal workflow, signing config, startup gate     |
| Contracts    | `packages/custody/contracts` | Foundry unit tests against Anvil                      |
| **Stack**    | **`packages/e2e`**           | **Everything wired together**                         |

::: warning
Docker E2E and the finance acceptance suite require Docker, Foundry and separate
infrastructure; they are not part of the default unit test run.
:::
