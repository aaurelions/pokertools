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

Historical partial-phase verdict: **FAIL**. The findings above are preserved as
the handoff evidence; they are not claims about the continuation below.

## Continuation implementation

- Read the complete handoff before inspection or implementation. Reviewed status,
  staged and unstaged diffs, untracked candidates, lockfile origins, relocated
  custody contents, and the twenty-commit history. No reset, stash or developer
  subagent was used. Read-only exploration/research assisted diagnosis.
- Recoverable checkpoint: **`90d867e2faa17ef9dfdc2b8d4ac74c761bd26138`**.
  Commit hooks required formatting the existing partial work, then passed lint
  and quick tests. The checkpoint contains no runtime DB/logs, generated secrets,
  local `.env`, Anvil state or Docker artifacts. The deliberately public,
  renamed custody `.env.test` remains a test fixture, not a real credential.
- Candidate secret scan before checkpoint: six reviewed matches (empty setting,
  public Anvil account-zero key, source expressions, truncated/example tokens).
  No real credential was identified. Default full-tree scan still had the 165
  historical matches; a reviewed policy and canary tests were subsequently added.
- Focused commits: `820bf90` (tournament reconciliation and public play),
  `9f35a7d` (maintained SIWE and nonce claims), `f81a5cd` (scanner policy,
  runtime dependency evidence and environment-file custody gate).

## Resolved blockers

### Tournament root cause and correction

The old Docker harness erased chips, retained zero-stack busted seat objects,
left hand-boundary fields inconsistent, and ignored reconciliation HTTP failures.
It was not a valid tournament simulation. Production code also had independent
defects: it counted zero-stack all-in contenders as eliminated during an active
hand, closed source tables after deferred/failed moves, never consolidated
multiple half-full tables, and let late snapshot jobs reset status to ACTIVE.

The director now holds sorted table locks under its tournament lock; uses actual
settled/undealt hand boundaries for both movement endpoints; retains all-in
contenders until awards; clears settled busted seats through engine STAND; fails
closed on missing/inconsistent assignments; consolidates capacity; refreshes its
observations after movement; and closes only empty, unassigned tables. Rollback
removes a successful destination SIT before reseating at source if the entry
update fails. Failed automatic reconciliation is observable without turning an
already accepted action into a falsely failed mutation.

Queued snapshot projection uses version and state/lifecycle compare-and-set and
cannot regress a newer snapshot or reopen a CLOSED table. Next-hand jobs also
respect CLOSED. **This is not a PostgreSQL-authority/outbox implementation.**

`tournament-public-play.test.ts` exercises the original all-in elimination defect
through public action/reconcile routes, then plays eight entrants across four
tables to a winner, asserting 4 → 2 → 1, no active entry on a closed table,
idempotent reconciliation/settlement and rejection of a late closure projection.
No action, seat, stack or elimination fixture edits are used in that test.
Authentication/funding are explicitly test fixtures, not principal/finance proof.

The 30-player Docker tournament now uses SDK HTTP actions for all hands, public
registration/director/settlement, progressive elimination, winner chip conservation
(90,000), 4 → 2 → 1 observations and repeated reconciliation/settlement. Raw state
mutation helpers and reconciliation sleeps were removed. Every tournament HTTP
status is checked; login no longer retries and ignores HTTP failures. The original
`activeTables.length <= 2` assertion was retained and stronger assertions added.
First-failure container diagnostics are captured before teardown.

### Authentication and startup corrections

SDK formatting/parsing delegates to `viem/siwe` (a direct SDK runtime dependency).
The parser preserves resources and returns maintained Date-valued timestamps;
the formatter accepts Date/ISO ergonomic inputs and rejects malformed fields.
Old non-standard short-nonce/short-address fixtures were corrected, not retained
as a permissive formatting path. Invalid construction is explicitly tested.

API SIWE validates required fields, version, URI context, chain, issuedAt and
maintained validity checks. A tightly bounded 30-second future-issuedAt tolerance
handles independent wallet/API clocks (Docker exposed millisecond skew); a
60-second future value remains rejected. notBefore/expiration retain absolute
enforcement. Signature verification precedes atomic GETDEL nonce consumption:
wrong signers cannot burn a challenge and concurrent valid replays yield exactly
one success. Real loopback tests cover all these boundaries.

Custody rechecks the production gate after dotenv but **before** reading secret
files/mnemonic material. A regression verifies production supplied by an environment
file is blocked. The original immediate explicit-production refusal remains.

## Final architecture

**The requested final ownership model is still a target, not fully delivered.**

| Boundary              | Required ownership                                                                            | Continuation state                                                                                     |
| --------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `@pokertools/engine`  | Deterministic rules and masked views                                                          | Preserved; no AI/LLM rules added.                                                                      |
| `@pokertools/types`   | Canonical runtime/wire contracts                                                              | Operational/strict-action contracts preserved; full REST/WS unification missing.                       |
| `@pokertools/api`     | Principals/auth/seats/turns, durable state/events, ledger/intents, chain verification, replay | Tournament and SIWE defects corrected; wallet User, legacy finance and Redis authority remain.         |
| `@pokertools/sdk`     | Universal browser/Node client and optional React                                              | Maintained SIWE and existing transports; service/actionId/asset protocol missing.                      |
| `@pokertools/custody` | Isolated signing, nonce/raw bytes, broadcast, finality/reorg/reconciliation worker            | Name/security gates preserved and strengthened; legacy Telegram workflow remains.                      |
| Redis                 | Cache/pubsub/locks/queues only                                                                | **Not achieved**: still hot game authority.                                                            |
| PostgreSQL            | Durable authoritative platform state                                                          | Migration integrity preserved; atomic game action/event/idempotency/outbox authority **not achieved**. |

No AI/LLM-specific functionality was introduced. No old admin-package alias was
added. Neither production gate nor fail-closed readiness was weakened.

## Final tests

Final continuation verification results are recorded below after command completion.
Logs are external to the repository under the approved `T/opencode` directory,
with `continuation-*` names. Mandatory acceptances that are not implemented are
**missing**, not passing and not counted as harmless skips.

## Anvil evidence

Only valueless local chain 31337 and the historical six-decimal MockUSDC strategy
are exercised. This continuation does **not** demonstrate a second chain/asset,
direct treasury tx/log claims, RPC quorum, real custody raw-byte broadcast,
post-credit/withdrawal reorg monitoring, treasury freeze or gas-starvation recovery.
Legacy simulated withdrawal approval is not claimed as real custody acceptance.

## SDK/browser/service acceptance

- Real loopback Node SDK wallet HTTP/WebSocket/masking/reconnect hand acceptance
  remains, and maintained SDK SIWE now has real loopback validity/replay coverage.
- Public tournament gameplay uses SDK HTTP; focused API regression uses injected
  HTTP requests. It does not substitute for canonical Turn/LegalAction acceptance.
- SERVICE-only, mixed wallet/service, ten-seat and browser acceptance are still
  missing. No fake wallet was introduced to pretend a SERVICE principal exists.
- Lost-response finance/action/registration tests, canonical turn race tests and
  durable Redis-loss/outbox recovery remain missing.

## Dependency audit

Fresh registry/advisory research still finds Prisma 7.10.0 to be the newest stable
compatible line. The `prisma` latest tag points at 8.0.0-rc.19, not a stable 8.0.0.
Prisma pins mysql2 3.15.3 and config pins deepmerge-ts 7.1.5; patched upstream
libraries exist, but compatible stable Prisma has not adopted them. Upstream
`prisma/orm#30295` remains open. No override, legacy-peer-deps, disabled audit or
forced downgrade was used.

| Advisory                             | Package/range       | Affected path                           | Stable upstream status                                                             |
| ------------------------------------ | ------------------- | --------------------------------------- | ---------------------------------------------------------------------------------- |
| GHSA-ggr8-5vv4-36mx / CVE-2026-40345 | deepmerge-ts <8.0.0 | Recursive config merge stack exhaustion | Library patched in 8.0.0; Prisma config pins 7.1.5.                                |
| GHSA-3f6p-5ww8-9rcr                  | mysql2 <3.22.0      | MySQL auth downgrade to plaintext       | Library patched in 3.22.0; Prisma CLI pins 3.15.3.                                 |
| GHSA-rgwj-5xj2-c3m3                  | mysql2 <=3.23.0     | Compressed MySQL protocol inflate       | Library patched in 3.23.1; Prisma CLI pins 3.15.3. Advisory is moderate, not high. |

Raw `npm audit --omit=dev --json` still reports four high **package findings**
(including propagation to Prisma/config), not four separate high advisories.
The development install is not audit-clean.

The existing Docker build removes these CLI-only packages. New reproducible
`scripts/test-runtime-dependencies.mjs <image>` checks **every installed package
manifest** and API/custody module resolution in the actual built image, with no
network. It proves prisma, @prisma/config, deepmerge-ts and mysql2 are not shipped
or resolvable there. This evidence is specific to the tested Docker artifact;
it is not a blanket acceptance for arbitrary npm-based deployments or development
CLI use. Root audit output is retained unchanged.

## Secret scan

`.gitleaks.toml` extends the default scanner, adds literal EVM signing-key detection,
excludes only pinned third-party Foundry submodules, and uses value/path/rule-scoped
exceptions for reviewed placeholders, expressions and the public Anvil key in
named isolated fixtures. No first-party test/fixture/Solidity/docs blanket ignore.

Canaries caught Gitleaks 8.30.1's global path+regex AND enumeration defect
(upstream PR #2227). `targetRules` avoids whole-file suppression. Eight first-party
paths, including exempted files, contracts, docs/examples and a build log, must
still detect random signing keys/credential canaries. Source and captured release
reports are scanned separately; final results are recorded with final tests.
Zero findings is scanner evidence, not proof against all secret classes/history.

## Remaining limitations

The table below maps every previously missing architecture/acceptance requirement
to its actual continuation status. “Missing” means no implementation and no new
acceptance evidence; it is intentionally not a PASS.

| Requirement                    | Previous status                       | Implementation / evidence                                                        | Final status                        |
| ------------------------------ | ------------------------------------- | -------------------------------------------------------------------------------- | ----------------------------------- |
| 1–2 preservation/checkpoint    | Uncommitted partial work              | Preserved, reviewed/scanned, checkpoint SHA above                                | Delivered                           |
| 3 tournament regression        | Docker merge failure; invalid harness | Director/projection fixes; API public-play regression; replaced Docker harness   | Verification recorded below         |
| 4 DB game authority            | Redis authority                       | No atomic game/event/idempotency/outbox model                                    | Missing                             |
| 5 Principal model              | Wallet User only                      | No replacement Principal/seat model                                              | Missing                             |
| 6 scoped service auth          | Missing                               | No service credentials/scopes                                                    | Missing                             |
| 7 actor identity               | Spoof field rejected, old protocol    | Auth-derived playerId preserved; no turn/version/actionId request                | Incomplete                          |
| 8 Turn/Observation/LegalAction | Missing                               | No canonical decision boundary                                                   | Missing                             |
| 9 SDK legality                 | Independent helpers                   | Not converted to authoritative legal-action consumption                          | Missing                             |
| 10 shared wire contracts       | Partial                               | No comprehensive DTO/schema unification                                          | Incomplete                          |
| 11 maintained SIWE             | Home-grown SDK helper                 | viem delegation; SDK and real loopback validity/replay tests                     | Delivered                           |
| 12 atomic asset model          | Cents/default currency                | No asset registry/atomic finance replacement                                     | Missing                             |
| 13 balanced postings           | Legacy ledger                         | No immutable asset journal/rebuild/arbitrary atomic tests                        | Missing                             |
| 14 remove donations            | No donation found                     | None introduced; source inspection finds no donation feature                     | Preserved absence                   |
| 15 RPC pool/quorum             | Primary/backup                        | No arbitrary validated pool/quorum                                               | Missing                             |
| 16 exact treasury claims       | Derived deposits                      | No chain/tx/log treasury claim path                                              | Missing                             |
| 17 deposit finality            | No post-credit monitoring             | No durable reorg incident/freeze workflow                                        | Missing                             |
| 18 typed withdrawal            | Hand-built USD string                 | EIP-712 intent not implemented                                                   | Missing                             |
| 19 persist-before-broadcast    | Unsafe legacy flow                    | Signed raw-byte/nonce durable workflow absent                                    | Missing                             |
| 20 replacement policy          | Not converged                         | No explicit audited conservative policy                                          | Missing                             |
| 21 withdrawal reorg            | Not converged                         | No quorum/deep-finality/owed-obligation handling                                 | Missing                             |
| 22 asset operational state     | Missing                               | No ACTIVE/DEGRADED/FROZEN model                                                  | Missing                             |
| 23 treasury reconciliation     | Legacy balance checks                 | No quorum-backed liability/equity/freeze evidence                                | Missing                             |
| 24 native gas readiness        | Legacy monitor                        | No obligation-preserving quorum signing gate                                     | Missing                             |
| 25 narrow custody              | Renamed, legacy Telegram coupling     | Startup gate hardened; core workflow still coupled                               | Incomplete                          |
| 26 incidents/resolution        | Missing                               | No durable incident/resolution model                                             | Missing                             |
| 27 readiness                   | Hard-coded fail-closed                | Correctly left blocked; real financial checks missing                            | Incomplete                          |
| 28 universal SDK               | Wallet only                           | Maintained SIWE; service/legal-action/asset APIs absent                          | Incomplete                          |
| 29 lost-response retries       | Transport fixes, limited idempotency  | No complete real loopback mutation-loss suite                                    | Incomplete                          |
| 30 generic chat                | Absent                                | No append-only public chat/replay contract                                       | Missing                             |
| 31 event/outbox                | Missing                               | Late projection hardened, no durable event/outbox stream                         | Missing                             |
| 32 replay/audit                | Legacy hand history                   | No sequence integrity/durable boundary                                           | Incomplete                          |
| 33 single next-major schema    | Legacy models remain                  | No replacement baseline; no compatibility alias added                            | Incomplete                          |
| 34 dependency audit            | Four high package findings            | New stable research and actual Docker absence proof; raw audit remains nonzero   | Artifact-specific evidence only     |
| 35 secret scanning             | 165 findings                          | Narrow policy, isolated public key fixtures, canaries, release scans             | Verification recorded below         |
| 36 two SERVICE gameplay        | Missing                               | No implementation/test                                                           | Missing                             |
| 37 mixed wallet/service        | Missing                               | No implementation/test                                                           | Missing                             |
| 38 ten-seat API/SDK            | Missing                               | No implementation/test                                                           | Missing                             |
| 39 complete API-only MTT       | Manipulated failing harness           | New 30-player public/SDK path; canonical turn protocol still absent              | Incomplete canonical acceptance     |
| 40 Redis loss                  | Not proven durable                    | No DB action/outbox recovery acceptance                                          | Missing                             |
| 41 timeout/action race         | Redis-version tests only              | No cross-process canonical turn/DB CAS acceptance                                | Missing                             |
| 42 multi-chain Anvil           | Single chain                          | No second chain/decimal token                                                    | Missing                             |
| 43 real deposit claims         | Legacy derived deposits               | No canonical treasury-claim acceptance                                           | Missing                             |
| 44 real custody withdrawal     | Simulated approval                    | No persist/recover exact-byte acceptance                                         | Missing                             |
| 45 deterministic reorgs        | Missing                               | No deposit/withdrawal reorg acceptance                                           | Missing                             |
| 46 RPC disagreement            | Missing                               | No quorum/freeze acceptance                                                      | Missing                             |
| 47 treasury shortfall          | Missing                               | No real liability/quorum/freeze acceptance                                       | Missing                             |
| 48 gas starvation              | Missing                               | No obligation-preserving custody acceptance                                      | Missing                             |
| 49 browser SDK                 | Missing                               | No browser-level public SDK acceptance                                           | Missing                             |
| 50 final verification          | Historical partial results            | Continuation commands/results below; missing acceptance suites cannot be counted | Incomplete convergence verification |
| 51 production admission        | Blocked                               | Refusal preserved and tested; no unsafe override                                 | Correctly still blocked             |
| 52 focused commits             | None                                  | Checkpoint and focused commits recorded                                          | Delivered                           |
| 53 report                      | Historical FAIL                       | History preserved; continuation requirements/evidence explicit                   | Updated                             |
| 54 ownership                   | Target not achieved                   | Explicit target/current map above                                                | Incomplete                          |
| 55 final criteria              | FAIL                                  | Many mandatory implementations and acceptances absent                            | FAIL                                |

No downstream product integration was attempted. Passing legacy/new regression
tests does not enable valuable assets. **Production remains blocked.**

POKERTOOLS_CONVERGENCE=FAIL

---

# Final convergence (next-major architecture completed)

The historical sections above are preserved as handoff evidence. This section
records the completed convergence; source and executed acceptance results are
authoritative.

## Final commits

- Implementation commit: **`b00de49337d58a741fb37d0daff7b0a9cd4a23f0`**
  (`feat!: converge on canonical next-major architecture`).
- Evidence/admission commit: the commit containing this section (compiled
  `CONVERGENCE_EVIDENCE` in `@pokertools/types` references the implementation
  commit and every mandatory acceptance result).
- Recoverable handoff checkpoints remain: `90d867e`, `820bf90`, `9f35a7d`,
  `f81a5cd`, `0b68c62`, `c21f779`. No history was reset or discarded.

## Final package responsibility map

| Package                 | Authority                                                                                                                                                                                                     |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@pokertools/engine`    | Deterministic Hold'em rules, action legality, showdown/pots, snapshots, seat-masked views. No AI/LLM concepts.                                                                                                |
| `@pokertools/evaluator` | Deterministic hand evaluation.                                                                                                                                                                                |
| `@pokertools/types`     | Sole environment-independent runtime/wire contracts (principals, turns, observations, actions, chat/replay, finance, incidents, readiness) and compiled convergence evidence.                                 |
| `@pokertools/api`       | Principals/auth (SIWE + scoped SERVICE), seats/tables/tournaments, canonical turns, PostgreSQL-authoritative game state/events/outbox, atomic ledger, payment intents, blockchain verification, replay/audit. |
| `@pokertools/sdk`       | Universal Browser/Node client and optional React subpath over the shared protocol; no client poker-legality authority.                                                                                        |
| `@pokertools/custody`   | Isolated private signing, serialized treasury nonces, persist-before-broadcast, broadcast/observation/finality, incidents and reconciliation; Telegram-independent core.                                      |
| PostgreSQL              | Durable authoritative platform state.                                                                                                                                                                         |
| Redis                   | Cache, pubsub, locks, queues, ephemeral coordination only.                                                                                                                                                    |

## Schema / breaking changes

- Pre-production PostgreSQL baseline reset (allowed by this task): `001_initial_schema`
  is now generated from the final Prisma schema with native enums; `002_financial_invariants`
  and `003_audit_invariants` carry only non-Prisma enforcement (balanced/immutable
  journal, same-asset FKs, append-only events/audit). The three hashes are pinned in
  `prisma/postgres/migrations.json`; future migrations are append-only and immutable.
- Removed obsolete models/enums (`Account`, `LedgerEntry`, `PaymentTransaction`,
  `Blockchain`, `Token`, `AdminWallet`, `UserWallet`, `DepositSession`, `Role.BOT`).
- Backward compatibility with the pre-production architecture is intentionally gone:
  no caller-selected actor, no Redis game authority, no cents/default-currency money,
  no hand-built withdrawal messages, no legacy API/SDK finance DTOs or aliases, no
  Telegram-coupled payout path in the canonical runtime.

## Dependency versions and exceptions

- All external dependencies are on the newest stable mutually compatible releases
  (re-checked at implementation time), including `viem@2.57.2`, `fastify@5.12.5`,
  `zod@4.6.5`, `bullmq@6.3.11`, `ioredis@6.0.0`, `prisma/@prisma/*@7.10.0`,
  `playwright@1.63.0`, `esbuild@0.28.2`.
- Documented stable exceptions (unchanged reasons): TypeScript 6.0.3 (TS7 has no
  supported JS compiler API for tsup DTS/ts-node; typescript-eslint peers `<6.1.0`),
  Prisma 7.10.0 (latest tag is an 8.0.0 RC), Redlock 4.2.0 (latest is 5.0.0-beta),
  VitePress 1.6.4 + markdown-it-mathjax3 4.3.2 (stable peer range; newer math plugin
  is incompatible with stable VitePress). No `--legacy-peer-deps`, forced
  incompatible overrides, disabled type checking or ignored audit failures were used.
- `npm audit --omit=dev` still reports four high package findings in the npm graph
  (`prisma` CLI → `@prisma/config`/`deepmerge-ts`, `mysql2`). These are CLI/build-only:
  the production Docker image deletes them and the API/custody runtime does not
  resolve them. Reproducible artifact evidence (final image
  `sha256:711b648646543e204132e6537d3e28241f47598d2ea6b6ef4320c42b30c9bf1f`):
  `RUNTIME_ADVISORY_PACKAGES_ABSENT=PASS` and `PRISMA_CLIENT_PROVIDER=postgresql`.
  No reachable high/critical runtime vulnerability remains in the shipped artifact.

## Executed acceptance matrix (fresh infrastructure)

| Area                             | Command                                                        | Result                                                                                                   |
| -------------------------------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Install/build/typecheck/lint     | `npm ci`, `npm run build`, `npm run typecheck`, `npm run lint` | all exit 0                                                                                               |
| Workspace tests                  | `npm test`                                                     | API 452, custody 42, engine 397, evaluator 94 (+1 skip), SDK 194, types 221 = **1400 passed, 1 skipped** |
| PostgreSQL migrations            | `npm run test:postgres:migrations -w @pokertools/api`          | 5/5 (hash/history/gap/unhashed fail-closed)                                                              |
| Loopback wallet SDK              | `npm run test:loopback -w @pokertools/api`                     | 3/3                                                                                                      |
| Solidity                         | `npm run contracts:test -w @pokertools/custody`                | 5/5                                                                                                      |
| Canonical gameplay/recovery      | `npm run test:canonical -w @pokertools/api`                    | 16/16                                                                                                    |
| Two-chain finance/custody        | `bash scripts/run-finance-acceptance.sh`                       | 42/42                                                                                                    |
| Browser SDK                      | `npm run test:browser -w @pokertools/api`                      | 1/1 (headless Chromium 1.63.0)                                                                           |
| Docker E2E (incl. 30-player MTT) | `npm run e2e:docker`                                           | 25/25                                                                                                    |
| Runtime dependency artifact      | `node scripts/test-runtime-dependencies.mjs pokertools:final`  | PASS, PostgreSQL provider                                                                                |
| Secret scan                      | Gitleaks 8.30.1 with `.gitleaks.toml`                          | 0 findings; `SECRET_POLICY_CANARIES=PASS` (8 first-party paths)                                          |

Acceptance evidence:

- **2 SERVICE gameplay**, **mixed 2 WALLET + 2 SERVICE**, and **10-seat** hands
  complete through the public API/SDK with masking, legal-action contract, stale
  rejection, duplicate-request idempotency, reconnect resume and chip conservation.
- **Redis loss**: Redis is killed/flushed and restarted; accepted actions are
  recovered from PostgreSQL only, versions remain monotonic and event sequences
  intact; the commit-before-publish crash path is covered by the durable outbox
  recovery test.
- **Timeout/action race**: a real client action races the scheduled timeout worker
  for the same canonical turn; exactly one mutation wins and the loser observes a
  stale turn/version without a second mutation.
- **API-only multi-table tournament**: 30 SDK principals register, start four tables
  (8/8/7/7), play real hands/actions, are eliminated and balanced through the public
  director endpoints, consolidate 4 → 2 → 1, settle once, and repeat
  reconcile/settle as idempotent no-ops with chip conservation.
- **Two isolated Anvil chains (31337/31338), 6- and 18-decimal tokens**: direct
  treasury deposit claims verify chain/token/receipt/Transfer/sender/recipient/amount/
  exact log identity through endpoint quorum; wrong chain/token/sender/recipient/log,
  multi-log transactions and duplicate claims are rejected/idempotent; credited
  deposits are monitored to deep finality and a reorg preserves user liability with
  a durable `DEPOSIT_REORG` incident and route freeze (no duplicate liability).
- **Real custody withdrawal**: EIP-712 intent → atomic reserve → serialized treasury
  nonce → signed raw bytes persisted before broadcast
  (`keccakOfPersistedRawTx === txHash`) → quorum confirmation/finality → balanced
  ledger completion; restart reads PostgreSQL only. Ambiguous accepted-then-dropped
  broadcasts recover the exact bytes/hash with a single transfer and no new nonce,
  debit or replacement; gas starvation blocks without erasing the obligation and
  resumes after replenishment; withdrawal reorg restores the owed obligation exactly
  once; RPC disagreement and treasury shortfall create durable incidents and freeze
  new risk while monitoring continues; operator resolution rechecks incidents,
  ledger invariants, quorum and gas in one transaction.
- **Production admission**: with compiled verified evidence and safe configuration,
  the production image applies reviewed migrations and serves `/health` 200 with
  `/ready` 200; unsafe configurations (SQLite URL, missing CORS, missing custody
  signing keys, custody secrets in the public API) fail closed with explicit codes.
  The API never loads signing secrets.

## Remaining limitations (non-blocking)

- The npm audit graph retains CLI/build-only Prisma advisories as documented above;
  they are absent from the shipped artifact. Any future npm-based deployment that
  installs the Prisma CLI into the runtime would reintroduce them.
- `persist-snapshot`/`snapshot-projection` remain as a defensive no-op guard even
  though PostgreSQL commits are authoritative.
- The optional derived-address sweeper is not wired; the direct-treasury deposit path
  is fully independent of it.
- Docs/READMEs outside the packages updated here may still describe historical
  architecture details.

All mandatory architecture and acceptance requirements are implemented and
verified; the production block was replaced only after the matrix above passed.

POKERTOOLS_CONVERGENCE=PASS
