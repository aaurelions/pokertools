# @pokertools/e2e

End-to-end scenarios that exercise the complete stack through Docker Compose and a local
Anvil blockchain.

## Running

```bash
# prerequisites: Docker Desktop (or daemon) with Compose v2
npm run e2e:docker
```

This brings up (via `docker-compose.e2e.yml`):

| Service    | Role                                          |
| :--------- | :-------------------------------------------- |
| API        | Full Fastify stack                            |
| Workers    | BullMQ processing                             |
| Redis      | State + queues                                |
| PostgreSQL | Persistence                                   |
| Anvil      | Local EVM chain for deposits/withdrawals      |
| E2E runner | Executes the scenario suite against the stack |

The runner exits non-zero on the first failed scenario; `docker compose -f docker-compose.e2e.yml logs` shows per-service output for debugging.

### Troubleshooting

| Problem                    | Fix                                                                                                        |
| :------------------------- | :--------------------------------------------------------------------------------------------------------- |
| Port conflicts             | The stack publishes API (8080), Redis (6379) and Postgres (5432); stop local copies or change the mapping. |
| Anvil forked mainnet calls | Scenarios use a standalone Anvil with a pre-funded account; no external RPC keys are needed.               |
| Slow first run             | Image pull + Prisma push + Foundry setup take a few minutes; subsequent runs reuse the build cache.        |

## Covered scenarios

| Scenario             | Verifies                                                   |
| :------------------- | :--------------------------------------------------------- |
| Full lifecycle       | Buy-in → hand → settlement → withdrawal                    |
| Deposit              | On-chain deposit indexed into user accounts                |
| Withdrawal broadcast | Signed withdrawal mined on Anvil, confirmed by the monitor |
| Tournament           | Entry, blind progression, payout escrow                    |
| Reconnects           | Socket state resync after disconnect                       |
| Multi-table          | Concurrent tables under the same Redis/DB                  |

## Relation to unit/integration tests

| Layer        | Where                      | What                                                 |
| :----------- | :------------------------- | :--------------------------------------------------- |
| Engine rules | `packages/engine/tests`    | Reducer correctness, invariants, security            |
| Evaluator    | `packages/evaluator/tests` | Scores, frequencies, validation                      |
| API + DB     | `packages/api/tests`       | Routes, workers, ledger integrity, scheduled actions |
| Admin        | `packages/admin/tests`     | Wallets, sweepers, refunds                           |
| Contracts    | `packages/admin/contracts` | Foundry unit tests against Anvil                     |
| **Stack**    | **`packages/e2e`**         | **Everything wired together**                        |

::: warning
Docker e2e and production PostgreSQL validation require separate infrastructure and are
not covered by the local SQLite test suite — run them before a production deployment.
:::
