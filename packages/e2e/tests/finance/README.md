# Finance / custody acceptance suite

Real, non-skipping acceptance for the canonical multi-asset finance and private
custody boundaries. Two isolated local Anvil chains (31337/31338), a disposable
PostgreSQL + Redis pair, the actual API, and the actual custody `WithdrawalWorkflow`
over durable Prisma ports. Balances under assertion always come from real
on-chain transfers and real balanced journal postings — never a DB credit
shortcut.

## Run

```sh
# from repo root (builds Foundry fixtures, then runs the suite)
scripts/run-finance-acceptance.sh

# or directly
npm run contracts:build -w @pokertools/custody
cd packages/e2e
npx vitest run --config vitest.finance.config.ts
```

Requirements: Foundry (`anvil`, `forge`), Docker (cached `postgres:18-alpine`,
`redis:8-alpine`), Node >= 24. The suite runs with `maxWorkers: 1`,
`fileParallelism: false` and `isolate: true`; it must not run concurrently with
other SQLite Prisma suites.

## How PostgreSQL + Prisma are wired

`tests/finance/global-setup.ts` starts one fresh PostgreSQL and Redis, then
`helpers/fresh-infra.ts`:

1. writes a PostgreSQL-provider copy of `packages/api/prisma/schema.prisma` into
   a private runtime directory and runs `prisma generate` to a **private** client
   at `packages/e2e/.runtime/finance-generated/prisma`;
2. applies the reviewed SQL files in `packages/api/prisma/postgres/*.sql` in
   lexical order;
3. if the reviewed SQL is not yet Prisma-compatible (see known gaps), falls back
   to a clean Prisma-generated PostgreSQL schema so application acceptance can
   execute, logging the exact incompatibility.

`vitest.finance.config.ts` redirects the workspace `generated/prisma/index.js`
import used by both API and custody source to the private client, so the shared
SQLite build output is never regenerated or clobbered.

## Coverage

| File                                          | Tests | Covers                                                                                                                                                                                                                                                                                                                                                   |
| --------------------------------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `harness-smoke.test.ts`                       | 8     | two-chain topology, 6/18-decimal assets, real transfers, exact ERC-20 log identity, multi-log tx, snapshot/revert, configurable quorum proxies, canonical EIP-712 domain/fields                                                                                                                                                                          |
| `quorum-disagreement.acceptance.test.ts`      | 7     | real `ChainRegistry`: distinct same-chain proxies, duplicate URL rejection, chain mismatch, quorum liveness, disagreement + freeze, minimum participants                                                                                                                                                                                                 |
| `deposit-claim.acceptance.test.ts`            | 9     | real `createCanonicalDepositVerifier` + exact-log identity: direct wallet -> treasury credit, multi-log tx, wrong chain/token/sender/recipient, missing log, confirmation depth, frozen asset                                                                                                                                                            |
| `deposit-ledger.acceptance.test.ts`           | 3     | real `CanonicalDepositService` + real verifier on fresh PG: wallet -> treasury exact log, balanced journal credit, idempotent duplicate, unverified rejection, independent logs                                                                                                                                                                          |
| `api-routes.acceptance.test.ts`               | 8     | real Fastify app + real SIWE session: `/finance/assets`, `/finance/balances`, `/finance/deposits/claim` + `/:id`, `/finance/withdrawals/intents` + `/:id`, bad signature, 404s                                                                                                                                                                           |
| `withdrawal-custody.acceptance.test.ts`       | 4     | EIP-712 intent via public API -> PG reservation -> `PrismaWithdrawalStore` persist-before-broadcast -> broadcast -> quorum finality -> `AtomicLedger` completion; true restart reading only PG; ambiguous accepted-then-dropped exact-byte reuse with a single transfer; gas starvation + replenish; genuine missing-receipt withdrawal reorg obligation |
| `reconciliation-incidents.acceptance.test.ts` | 3     | real shortfall -> `TREASURY_SHORTFALL` + freeze; restore -> matched reconciliation; operator resolution through the public API with ledger/gas health rechecks; RPC disagreement fails closed                                                                                                                                                            |

Helpers: `anvil-two-chain.ts`, `quorum-proxy.ts`, `fresh-infra.ts`,
`custody-harness.ts` (Prisma stores + real viem ports + fault decorators),
`prisma-accounting.ts` (real `AtomicLedger`-backed `TreasuryAccounting`),
`eip712.ts`, `finance-fixtures.ts`, `finance-api-harness.ts` (real SIWE),
`setup-env.ts`, `infra.ts`.

Foundry test fixture: `packages/custody/contracts/test/acceptance/MockAssetToken.sol`
(configurable-decimals mintable ERC-20). Test-only; never ships as custody code.

## Known source gaps (reported, not skipped)

1. **Reviewed SQL vs Prisma enums.** `001..008` model enum-typed columns as
   `TEXT` + `CHECK` domains, but `prisma/schema.prisma` declares PostgreSQL enum
   types (`Role`, `PrincipalKind`, `AssetStatus`, `AtomicAccountClass`,
   `DepositClaimStatus`, `DepositProvenance`, `WithdrawalIntentState`,
   `IncidentKind`, `IncidentSeverity`, `IncidentStatus`, `ReconciliationStatus`,
   ...). The reviewed runner therefore fails Prisma writes with SQLSTATE 42704
   (`type "public.Role" does not exist`). The harness reports this and uses the
   Prisma-generated schema for interim acceptance. The migration manifest also
   lists only `001`/`002`; `003..008` must be registered once the DDL is aligned.
2. **Confirmation-depth convention.** `ChainRegistry.getCanonicalReceipt`
   computes `head - receiptBlock` while `WithdrawalWorkflow.monitorRecord` uses
   `head - receiptBlock + 1`. The chosen convention is inclusion-inclusive
   (`+1`); the registry implementation must be aligned. Acceptance tests mine an
   extra block so they pass under either convention pending that fix.
3. **`financialReadinessCheck` is read but never set.** The finance route reads
   `fastify.financialReadinessCheck`; the application does not wire it, so
   operator resolution would fail closed. The reconciliation acceptance injects a
   real ledger + native-gas readiness check into the real route so the public
   operator path is exercised end to end.
4. **`@pokertools/api/finance-core` has no `TreasuryAccounting` adapter yet.**
   Its barrel re-exports `AtomicLedger`/`FinancialIntentService`/
   `FinancialIncidentService`. The acceptance harness supplies the port binding
   in `prisma-accounting.ts` (post journal only, leaving the CONFIRMED ->
   FINALIZED transition to custody) until the owned integration lands.
