# Architecture convergence execution report

## Baseline (recorded before implementation)

- Starting commit: `6aa742bdd5a673699c1d9ff390566f52c7914208`.
- Working tree initially clean. Node `24.18.0`, npm `12.1.0`, Docker server `29.8.1`, Anvil `1.5.1-stable`.
- Read-only source/test/deployment audit performed before implementation; source takes precedence over README claims.
- `npm ci --ignore-scripts`: succeeded (852 packages).
- Initial `npm run test:quick`: failed because workspace build artifacts were absent (engine: 41 failed suites, 1 passing suite, 15 passing tests).
- After building types/evaluator, `npm run test:quick`: engine 42 suites / 397 tests passed; evaluator 4 suites / 94 passed, 1 skipped; types 2 suites / 150 tests passed; SDK 8 files / 179 tests passed.
- E2E uses shared SQLite, a single Anvil chain and derived deposit addresses. Its withdrawal acceptance simulates approval rather than exercising custody's persist-before-broadcast workflow. Its tournament acceptance includes direct DB operations. These are not proof of the requested production invariants.
- Public API currently uses wallet `User`/session identity, Redis game state, cents-based accounting, hand-built withdrawal messages and primary/backup RPC configuration. No universal scoped service-principal protocol or settlement quorum exists.
- PostgreSQL migrations are custom reviewed SQL with a manifest; SQLite remains the Prisma schema provider. System-account migration delegates to seeding. Production startup does not run that seed.
- The privileged private admin package combines signing, sweeping, recovery and Telegram operations. It shares generated Prisma types with the API. SDK carries parallel API-domain contracts and client legality helpers.
- Existing tests protect engine behavior, but do not demonstrate the requested next-major architecture.

## Delivered changes (partial convergence, not production approval)

- Renamed the private package and its directory/submodules/build/deployment/docs/E2E references to `@pokertools/custody`. No package alias remains. Historical changelog/review references are retained as history. Fixed its emitted entrypoint to match `dist/index.js`.
- Removed public API xpriv encryption/decryption exports and the private-wallet creation CLI. Public startup rejects custody decryption keys, treasury keys, mnemonic material and known secret-file settings. Custody continues to own signing; its persisted `AdminWallet` model is not yet replaced.
- API, room-worker and custody configuration fail on `NODE_ENV=production` before infrastructure/signing initialization. Docker API startup also refuses production. **No environment override exists.** Development/test configurations are not permission to use valuable assets.
- `/health` now asserts liveness only. `/ready` always returns schema-validated 503 while migration and financial readiness remain unverified; Caddy uses `/ready`. API and SDK consume the same types-package liveness schema.
- Suppressed raw internal exception/driver objects from public 500 responses/request-error logs and dependency-health error logs. Removed Redis URL printing and SDK debug payload/response dumping.
- Gameplay route validates the shared strict request schema, rejects caller-selected `playerId`, requires bounded safe integer BET/RAISE amounts and incorporates SHOW card indices in the idempotency payload. This is **not** the required new turn/version protocol.
- PostgreSQL migrator checks manifest/file/database hashes, unknown migration names and history gaps; serializes concurrent runners; records each hash atomically with migration application. It refuses unhashed historical state without automatically stamping it. Existing SQL files were not rewritten.
- SDK sends JSON content type only for JSON bodies (real SIWE nonce HTTP requests previously failed), serializes retry bodies once, ignores stale socket callbacks/messages, rejects cancelled connection attempts, clears intentional-disconnect private caches and rejects pending socket requests on connection loss.
- Added independently executable real PostgreSQL migration acceptance and loopback HTTP/SDK/WebSocket wallet-hand verification. Existing correct engine behavior remains protected.

## Package responsibility map

| Package   | Intended authority                                                                 | Current limitation                                                                                                                                            |
| --------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| types     | Environment-independent wire types/runtime schemas                                 | Existing state/finance contracts are not fully runtime-schema-backed; only operational/action boundaries converged here.                                      |
| engine    | Deterministic Hold'em state, chip legality, payouts, masking                       | Preserved rules; exported enums are runtime enums to support isolated-module consumers.                                                                       |
| evaluator | Deterministic hand evaluation                                                      | Preserved and tested.                                                                                                                                         |
| API       | Authenticated seat authority, DB commits/outbox, assets/ledger, chain verification | Still wallet User/session-based; Redis hot-state authority and old cents workflows remain. Production blocked.                                                |
| SDK       | Browser/Node client protocol and optional React subpath                            | Transport/reconnect defects fixed; service credentials, authoritative turns, finance contract unification and maintained SIWE/EIP-712 helper redesign remain. |
| custody   | Private executable signing/workflow boundary                                       | Renamed and blocked in production; Telegram coupling and unsafe legacy broadcast/settlement semantics remain.                                                 |
| E2E       | Real infrastructure acceptance                                                     | Legacy single-chain SQLite suite passed once; final rerun fails tournament merging and does not satisfy next-major acceptance.                                |
| bench     | Benchmarks/load generation                                                         | Existing baseline tooling retained; no authoritative protocol duplicated here by this change.                                                                 |

## Dependency refresh and exceptions

Registry metadata was queried for every external dependency/devDependency in root, all workspaces and docs. Manifests and both lockfiles were refreshed, followed by transitive updates. Broad overrides were removed. No forced installation, legacy-peer-deps or ignored audit failure was used. Prisma client was regenerated with stable 7.10.0.

Important migrations: dotenv 17 → 18; latest SWC/Jest/Vitest/ESLint/typescript-eslint/ws/viem/BullMQ/pg patches; stable Redlock 4.2.0 replaces prerelease 5 beta (lock/unlock/clientError APIs, obsolete automatic-extension configuration removed); stable VitePress 1.6.4 replaces 2 alpha; markdown-it 14 → 15. Root build now runs in dependency order. Prisma's SQLite adapter keeps its supported native 12.11.1 dependency rather than overriding it to 13; native build scripts are explicitly approved/rebuilt and Docker includes build-only native tooling.

Concrete exceptions, not backward-compatibility pins:

| Package              | Selected | Newest considered       | Reason / coverage                                                                                                                                                                                                                     |
| -------------------- | -------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| typescript           | 6.0.3    | stable 7.0.2            | Native TS7 has no supported JS compiler API for stable tsup DTS/ts-node; typescript-eslint 8.71.0 explicitly peers `<6.1.0`. Build, DTS, typecheck and lint exercised at 6.0.3. No force/alias/disabled checking used to install TS7. |
| prisma               | 7.10.0   | latest tag 8.0.0-rc.19  | RC is not stable; 7.10.0 is newest stable. Client regeneration and real migration tests run.                                                                                                                                          |
| redlock              | 4.2.0    | latest tag 5.0.0-beta.2 | Beta is not stable; 4.2.0 is newest stable. Actual Redis locking/concurrency tests run. The DefinitelyTyped eval signature needs a narrow structural client assertion; runtime behavior is exercised.                                 |
| markdown-it-mathjax3 | 4.3.2    | stable 5.2.0            | Latest stable VitePress 1.6.4 peers `^4`; installing 5 fails peer resolution. Stable documentation build passes.                                                                                                                      |

`npm outdated` only lists TypeScript and the Prisma/Redlock prerelease dist-tags; docs additionally lists the math plugin. **Production audit still fails**: Prisma 7.10.0's dependency graph contains vulnerable deepmerge-ts/mysql2 (four high-severity package findings including propagated Prisma/config advisories). These were not hidden with overrides or accepted as safe. Docs audit also remains nonzero for stable VitePress/transitive tooling; its local development server must not be exposed publicly.

## Intentionally breaking changes / migration strategy

- Private package/import/workspace/path name is custody, without an admin compatibility package.
- Operational health payload no longer reports dependency readiness; readiness is a separate failing endpoint.
- Gameplay rejects extra identity fields/irrelevant amounts and missing/unsafe BET/RAISE amounts.
- Public API no longer exposes private-wallet setup/decryption helpers or accepts custody secrets.
- All production entrypoints are blocked pending a reviewed acceptance-complete implementation.
- PostgreSQL migration tracking now requires immutable SHA-256 evidence. Existing unhashed deployments fail rather than being auto-upgraded/blessed. Back up/reconcile first; a separately reviewed next-major data migration remains necessary. No production data-loss schema push was used.
- Full Principal/seat/ledger/event/asset/withdrawal schema replacement is **not delivered**. Migration checksum verification does not certify arbitrary manual DDL drift, SQLite/PostgreSQL parity or financial-history integrity.

## Commands and execution evidence

Logs/reports are under `/private/var/folders/v5/p6r4p28j27l_0_f3g6yzbkm40000gn/T/opencode/`, named `pokertools-*`. Command output was captured rather than inferring success from documentation.

Executed commands (repeated runs were used only for changed code or diagnosed failures):

```sh
git status --short
git rev-parse HEAD
node --version; npm --version
docker info --format '{{.ServerVersion}}'; anvil --version
npm ci --ignore-scripts
npm run test:quick
npm run build -w @pokertools/types
npm run build -w @pokertools/evaluator
npm view <each external manifest dependency> dist-tags --json
npm view typescript@6 version --json
npm view prisma versions --json
npm view redlock versions --json
npm view @typescript-eslint/parser@8.71.0 peerDependencies --json
npm view tsup@8.5.1 peerDependencies --json
npm install --ignore-scripts
npm install --ignore-scripts --prefix docs
npm update --ignore-scripts
npm update --ignore-scripts --prefix docs
git submodule sync
git submodule update --init --recursive
npm run db:generate:prepare -w @pokertools/api
npm rebuild better-sqlite3
npm rebuild better-sqlite3 --foreground-scripts
npm install
npm run infra:up -w @pokertools/api
npm run infra:down -w @pokertools/api
npm outdated --json || true
npm outdated --prefix docs --json || true
npm run build
npm run typecheck
npm run lint
npm test
npm run test -w @pokertools/api
npm run test:postgres:migrations -w @pokertools/api
npm run test:loopback -w @pokertools/api
npm run contracts:test -w @pokertools/custody
npm run docs:build --prefix docs
npm audit --omit=dev --json
npm audit --prefix docs --json
npm run e2e:docker
NODE_ENV=production node packages/api/dist/server.js
NODE_ENV=production node packages/custody/dist/index.js
NODE_ENV=production bash packages/api/scripts/docker-entrypoint.sh
gitleaks dir . --redact --report-format json --report-path <source-report>
gitleaks dir <captured-log-directory> --redact --report-format json --report-path <log-report>
```

Gitleaks 8.30.1 release archive was downloaded and its SHA-256 verified against GitHub release metadata (`b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5`). No packages, public releases or tags were published. Final commits: **none created; HEAD remains the starting SHA**. Changes are in the working tree, with submodule relocation metadata staged.

### Test results and diagnosed failures

- Baseline quick tests: 820 passed, 1 skipped after workspace artifacts built.
- First dependency installs failed peer resolution: redundant direct ESLint parser/plugin dependencies were removed (combined typescript-eslint owns them); docs math-plugin mismatch was documented/pinned to its supported stable release. Subsequent standard installs succeeded.
- Initial full API tests could not load the adapter's native binding after removing overrides. Explicit native script approval/rebuild fixed this. A separate Node acceptance file was initially discovered by Vitest; explicit suite selection fixed it without disabling tests.
- Real loopback SDK test exposed empty-body JSON content type, then old-socket-close reconnect corruption. Both were fixed and protected by actual loopback/regression tests.
- First two Docker E2E runs failed startup: 25 skipped each. Captured diagnostics identified the same missing adapter native binding. Native approval/build tooling corrected it; a subsequent Docker E2E passed 25/25. **Final rerun: 24 passed, 1 failed, no skips** — tournament merge at `packages/e2e/tests/docker-e2e.test.ts:817` found 4 active tables, expected at most 2. This remains an unresolved release-blocking failure; the assertion was not weakened. That harness injects busted states and ignores later reconciliation HTTP statuses, so it does not establish deterministic complete tournament behavior or a root cause for this failure.
- First PostgreSQL test-container run exceeded the cold image-pull timeout; timeout increased for container provisioning only. Final real PostgreSQL run passed 5/5, no skips.
- Final build/typecheck/lint exit 0. Final `npm test`: API 33 files / 247 passed; custody 3 files / 16 passed; engine 42 suites / 397 passed; evaluator 4 suites / 94 passed, 1 skipped; SDK 8 files / 181 passed; types 3 suites / 155 passed. Total: **1,090 passed, 1 skipped**. The separate PostgreSQL/loopback/Docker/Solidity suites are not included in this workspace total.
- Loopback wallet-hand suite: 1/1 passed. Solidity: 5/5 passed. Documentation build: passed.
- API/custody/Docker production admission commands each exit 1 with `ARCHITECTURE_CONVERGENCE_INCOMPLETE` (custody emitted-layout defect was also corrected and its gate rechecked).
- Production npm audit: exit nonzero, four high-severity package findings. This remains release-blocking.

### Gameplay / financial acceptance actually demonstrated

- Dedicated loopback: real wallet signatures/SIWE sessions, SDK HTTP requests, actual WebSocket, two seated wallet principals, completed fold-to-winner hand, replayed DEAL without second mutation, playerId-spoof rejection, masked REST/reconnect projections, chip conservation and stand. Initial test chip funding is a declared DB fixture; **not financial acceptance**.
- Legacy Docker acceptance: three wallet principals, live SDK WebSocket, completed cash hand/stand; 30-wallet tournament starts four tables (8/8/7/7). Director/settlement assertions passed in one run, but final rerun fails merging before settlement. Because tournament state is directly manipulated and the final run fails, this is **not** a complete API/SDK-only multi-table tournament demonstration.
- Service-only, mixed wallet/service, 10-seat, API-only complete multi-table tournament, timeout/action race with canonical turn IDs, full DB-authoritative restart/outbox replay and actual Redis restart/loss are **not demonstrated**.
- Real legacy Anvil transfers/deposit-monitor credit and a **simulated** operator withdrawal were exercised. They do not exercise exact treasury/log claims, multi-asset atomic ledger, EIP-712 intents or custody signed-byte persistence.
- New mandatory multi-chain/multi-asset/quorum/reorg/ambiguous-broadcast/reconciliation/gas-readiness suite is **not implemented or run** because those authoritative platform models/workflows are not yet implemented. No mock/DB shortcut is being counted as that acceptance.

### Chain evidence

Only local chain ID `31337` was exercised; **no second chain**. MockUSDC (6 decimals): `0x5fbdb2315678afecb367f032d93f642f64180aa3`; BatchSweeper: `0xe7f1725e7734ce288f8367e1bb143e90bb3f0512`. No second-decimal token was exercised. Public withdrawal transfer hash in both the passing and final failing Docker runs: `0x6750ee02d6c296b097d7853c8817e58b25d50103a11c791a6d33a30b001eec7c`. Deposit transfer hashes were not captured in this harness output. No valuable real-chain assets were used.

### SDK contract / secret-scan evidence

- Real Node SDK SIWE/HTTP/WebSocket usage and liveness schema validation passed. Shared strict gameplay requests are accepted/rejected by a real API. Browser-cookie acceptance, service-token acceptance, full REST/WS success/error schema coverage and no-duplicate-finance-contract proof are **not demonstrated**.
- Gitleaks filesystem scan includes untracked source, fixtures and built output (default third-party/node_modules/binary skips): 165 findings, nonzero exit. 159 are OpenZeppelin token-error/cryptographic-vector fixtures; six are own examples/public Anvil test-key/test-expression matches. Only own matches and representative third-party matches were inspected; this is **not a clean release-blocking scan**, and no blanket fixture suppression was added.
- Captured logs: zero Gitleaks findings. This is a scanner result, not a guarantee against all secret classes or prior Git-history leaks.
- Final rescan after builds/docs/tests: source remains 165 findings (exit 1), captured logs remain zero (exit 0). Docker/Anvil/test PostgreSQL resources were removed by their harnesses; the Redis process started for unit/integration tests was stopped. `git diff --check` and staged diff check pass.

## Remaining mandatory work / production safety decision

The requested architecture convergence is **not complete**. Principal/service-credential/scoped-seat authority, canonical turn/legal-action responses, durable action CAS/idempotency/outbox/event stream, generic chat, per-asset balanced atomic postings/rebuilds, chain/RPC quorum, direct treasury claims, EIP-712 intents, signed-byte persist-before-broadcast custody, finality/reorg incidents, reconciliation freezes and safe operator resolution are missing. Legacy cents/role/schema/SDK-legality/Telegram-coupled paths still need replacement, not compatibility shims. Examples/docs have warnings and an explicit ownership decision, but the requested complete browser/Node service examples and comprehensive contract/adversarial acceptance are not delivered.

Existing unsafe financial semantics and audit findings must not be enabled in production. Production admission is intentionally blocked in code; readiness remains false regardless of healthy DB/Redis. **Real-money operation is not safe to enable.** Passing existing regression suites is not sufficient to remove the block.

POKERTOOLS_CONVERGENCE=FAIL
