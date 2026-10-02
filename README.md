# PokerTools

Texas Hold'em engine, room API, browser/Node SDK and isolated treasury custody
worker. PostgreSQL owns durable gameplay and accounting; Redis provides
disposable coordination, queues and delivery.

## Workspaces

| Package                         | Responsibility                                                                                 |
| ------------------------------- | ---------------------------------------------------------------------------------------------- |
| [types](packages/types)         | Environment-independent domain types and strict public protocol schemas                        |
| [evaluator](packages/evaluator) | Fast deterministic 5-, 6- and 7-card hand ranking                                              |
| [engine](packages/engine)       | Poker rules, chip conservation, snapshots and masked views                                     |
| [api](packages/api)             | Authentication, seat authority, durable game commits, journal and read-only chain verification |
| [sdk](packages/sdk)             | REST/WS clients, SIWE helpers and optional React hooks at `/react`                             |
| [custody](packages/custody)     | Private signing, serialized treasury nonces and withdrawal recovery                            |
| [bench](packages/bench)         | Evaluator comparisons and public-protocol load/soak tools                                      |
| [e2e](packages/e2e)             | Real-infrastructure gameplay and multi-chain financial acceptance                              |

## Development

Requires Node.js 24+, npm 10+ and Redis. Docker and Foundry are required for
infrastructure acceptance and Solidity tests.

```sh
git clone --recurse-submodules https://github.com/aaurelions/pokertools.git
cd pokertools
npm ci
npm run build
cp packages/api/.env.example packages/api/.env
npm run dev:api
# In another terminal:
npm run dev:workers
```

`npm test` prepares disposable SQLite for fast local API tests. SQLite is not a
deployment database or proof of PostgreSQL constraints. Never target operator data.

```sh
npm run typecheck
npm run lint
npm test
npm run test:coverage
npm run check:boundaries
npm run test:postgres:migrations -w @pokertools/api
npm run test:postgres:ledger -w @pokertools/api
npm run test:canonical -w @pokertools/api
npm run test:loopback -w @pokertools/api
npm run test:browser -w @pokertools/api
npm run e2e:finance
npm run e2e:docker
```

See [testing](docs/guide/testing.md) for prerequisites and coverage gates.
`npm run bench` runs evaluator comparisons; load tests require an isolated API
and explicit credentials/table IDs.

## Operations

`docker compose up --build` runs a disposable development stack. Production uses
[docker-compose.prod.yml](docker-compose.prod.yml) and the
[deployment runbook](deploy/README.md), not development secrets or test assets.
`/health` is liveness only. `/ready` evaluates current schema, ledger, quorum,
custody, reconciliation and incident state; missing evidence fails closed.
Historical test certificates never grant runtime admission.

Read [architecture](docs/guide/architecture.md),
[configuration](docs/guide/configuration.md), [security](SECURITY.md) and
[contributing](CONTRIBUTING.md). Documentation: <https://aaurelions.github.io/pokertools/>.
License: [MIT](LICENSE).
