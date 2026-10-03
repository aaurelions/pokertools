# @pokertools/e2e

End-to-end suites for the full stack. The package runs two independent paths with
separate Vitest configs:

| Suite                      | Config                     | Scope                                                         |
| :------------------------- | :------------------------- | :------------------------------------------------------------ |
| Docker E2E                 | `vitest.config.ts`         | Single-chain SQLite smoke over the Docker Compose stack       |
| Finance/custody acceptance | `vitest.finance.config.ts` | Two Anvil chains + disposable PostgreSQL/Redis + real custody |

## Prerequisites

- Docker with Compose v2
- Foundry (`anvil`, `forge`) on `PATH`
- Node.js ^24.15.0 || >=26.0.0, npm >= 12.2.0

## Docker E2E

```bash
# from the repo root
npm run e2e:docker
```

The `pretest:docker` step builds `@pokertools/types`, `@pokertools/sdk` and the
Foundry fixtures. The run starts a host Anvil on port 8545, then brings up
`docker-compose.e2e.yml` (API + workers + Redis on SQLite) and runs
`tests/docker-e2e.test.ts`. It exercises health/docs routes, SIWE login, deposits
claimed by exact log identity, a multiplayer table (buy-ins, actions, stand), a
reserved EIP-712 withdrawal driven through the custody workflow, and WebSocket
observation delivery. Containers, volumes and temp files are cleaned up at the
end.

| Concern          | Detail                                                            |
| :--------------- | :---------------------------------------------------------------- |
| Database         | SQLite bind-mounted from `POKERTOOLS_E2E_RUNTIME`                 |
| Chain            | Standalone Anvil on `127.0.0.1:8545`; no external RPC keys        |
| Contract fixture | `MockUSDC` (direct-treasury deposits do not use a batch contract) |
| Redis            | Published on host port `6380`                                     |
| API              | Published on host port `3000`                                     |
| Secrets          | Deterministic local-only values, never production                 |

Manual usage:

```bash
npm run pretest:docker -w @pokertools/e2e
POKERTOOLS_E2E_RUNTIME=/tmp/pokertools-e2e docker compose -f docker-compose.e2e.yml up --build -d
npx vitest run --config packages/e2e/vitest.config.ts
POKERTOOLS_E2E_RUNTIME=/tmp/pokertools-e2e docker compose -f docker-compose.e2e.yml down -v
```

## Finance / custody acceptance

```bash
# from the repo root
npm run e2e:finance
```

The runner builds the Foundry fixtures and launches the suite; the suite's global
setup starts two distinct Anvil chains (31337/31338) and fresh
`postgres:18-alpine` + `redis:8-alpine` containers on ephemeral ports, then runs
`tests/finance/*`. Balances under assertion come from real on-chain transfers and
balanced journal postings. See
[`tests/finance/README.md`](tests/finance/README.md) for the file-by-file
coverage and the PostgreSQL/Prisma wiring.

## Related packages

| Package                           | Description                     |
| :-------------------------------- | :------------------------------ |
| [@pokertools/api](../api)         | REST/WebSocket API              |
| [@pokertools/sdk](../sdk)         | TypeScript SDK with React hooks |
| [@pokertools/custody](../custody) | Isolated withdrawal signer      |

## License

MIT © A.Aurelius
