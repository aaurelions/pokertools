# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.7] - 2026-06-26

### Changed

- Reduced the production Docker image footprint by pruning dev-only workspaces and unused peer dependency tooling from the API runtime image.
- Docker runtime database bootstrap now uses build-generated SQLite DDL instead of requiring the Prisma CLI in the production image.

### Fixed

- Docker Compose E2E now always reuses the locally built API image for the worker service.
- Hardened generated SQLite DDL ordering for future trigger/index support.

## [1.0.6] - 2026-06-26

### Fixed

- Docker E2E compose now builds the shared API/worker image once and reuses it for the worker service.

### Changed

- Expanded the Docker E2E package to run a real three-player blockchain-backed poker flow covering SIWE auth, on-chain deposits, gameplay winnings, stand/cash-out balance updates, and withdrawal settlement.
- Updated the Docker build/runtime image and CI/publish Node.js version to Node.js 24.

## [1.0.5] - 2026-06-25

### Security

- Removed replayable withdrawal messages; withdrawals now require nonce/timestamp signatures and DB-backed idempotency keys.
- Moved withdrawal debit/request creation to an atomic DB outbox pattern.
- Added `WALLET_ENCRYPTION_SECRET` as a required separate wallet-encryption secret for API and admin services.
- Updated API deposit address derivation to work with public HD wallet material and no API-side private-key derivation.
- Deposit monitor now enforces `Token.minDeposit` and ignores zero-address mint events.
- Production CORS now denies cross-origin requests unless `CORS_ORIGIN` is explicitly configured.

### Changed

- WebSocket `STATE_UPDATE` is now a lightweight `{ tableId, version, timestamp }` notification; full state is delivered by `SNAPSHOT` or REST fetches.
- Timeout worker now uses Redlock plus optimistic version-guarded Redis writes.
- Admin sweeper now paginates all user wallets.
- Prisma config requires `DATABASE_URL`; no implicit development database fallback is used.

### Added

- Prisma migration for `PaymentTransaction.idempotencyKey`.
- Regression coverage for withdrawal replay/idempotency, deposit min/mint filtering, WebSocket protocol shape, timeout locking, and full blockchain deposit/sweep/withdraw lifecycle.

## [1.0.4] - 2026-06-25

### Changed

- Upgraded Prisma from 6 to 7, including `@prisma/adapter-better-sqlite3` for SQLite connections. All `new PrismaClient()` calls replaced with `createPrismaClient()` factory. Removed `DATABASE_URL` from datasource config (now runtime-only via adapter). Removed `--skip-generate` from ensure-db.sh (not supported in Prisma 7).
- Upgraded Zod from 3 to 4: `.errors` replaced with `.issues`, `z.record()` now requires explicit key type.
- Upgraded @scure/bip32 from 1 to 2, @scure/bip39 from 1 to 2.
- Upgraded fastify-plugin from 5 to 6, @fastify/rate-limit from 10 to 11, @fastify/swagger-ui from 5 to 6.
- Upgraded dotenv from 16 to 17, ulid from 2 to 3, globals from 16 to 17.
- Bumped dozens of dev/transitive dependencies to latest.

### Fixed

- Graceful Redis quit handling: check connection status before quitting, suppress "Connection is closed" errors across plugins, workers, tests, and SocketManager.
- Redis psubscribe error handling added to SocketManager subscriber.
- vitest config: replaced deprecated `poolOptions.forks.singleFork` with top-level `singleFork`.
- dotenv config: added `quiet: true` to all `config()` calls to suppress missing env file warnings in CI and tests.

### Added

- `.npmrc` with `audit=false`, `fund=false`, `loglevel=error` for cleaner installs.
- `createPrismaClient()` utility in both `packages/admin/src/utils/` and `packages/api/src/utils/`.
- New test suites: engine game-logic edge cases, evaluator edge cases, SDK edge cases, and types schema coverage.
- `COOKIE_SECRET` to admin `.env.test`.

### CI

- Upgraded actions/checkout v4 -> v7, actions/setup-node v4 -> v6.
- Publish workflow Node.js 20 -> 22.
- Added `--no-audit --no-fund --loglevel=error` to `npm ci` in both workflows.

## [1.0.3] - 2026-06-25

### Fixed

#### @pokertools/api

- Fixed CI SQLite test database startup by normalizing test `DATABASE_URL` paths and creating the runtime directory before Prisma connects.
- Fixed auth nonce consumption to use atomic Redis `GETDEL` semantics.
- Fixed SIWE login tests and runtime behavior by using deterministic local signature verification for externally owned accounts.
- Fixed withdrawal message validation to require an exact signed message match.
- Added WebSocket inbound message size validation before JSON parsing.
- Fixed buy-in and add-chips idempotency cache keys to use the provided idempotency key.
- Fixed duplicate buy-ins so repeated requests do not move funds again when the player is already seated.
- Made stand cash-out balance sync transactional.
- Preserved settle-hand audit ledger entries when a player has already stood and cashed out.
- Replaced worker and route console logging with structured logger calls.
- Fixed standalone deposit monitor ESM loading.

#### @pokertools/admin

- Fixed `GasMonitor` to use the injected Telegram bot instance.

#### @pokertools/sdk / @pokertools/types

- Added runtime validation for server WebSocket messages and used it in the SDK socket handler.

#### @pokertools/engine

- Added regression coverage for heads-up multi-hand dealing behavior.

### Changed

- Updated CI to run on supported Node.js versions only.
- Bumped all workspace package versions to `1.0.3`.

## [1.0.2] - 2025-12-17

### Added

#### @pokertools/api

- **Multi-Chain Crypto Deposit System**
  - Support for Ethereum, Polygon, Arbitrum, and Base blockchains
  - Automatic USDC/USDT deposit detection and crediting
  - HD wallet address generation using BIP-44 derivation
  - Active deposit session monitoring (30-minute tracking windows)
  - Zero private keys on server (xPub only for security)
  - Transaction history with blockchain explorer links
  - Deposit monitor worker scanning every 15 seconds
  - Database models: `Blockchain`, `Token`, `AdminWallet`, `UserWallet`, `DepositSession`, `Deposit`

- **Player Notes System**
  - Private note-taking for tracking player behavior
  - Optional label system (e.g., "Fish", "Shark")
  - 500 character limit per note
  - One note per player pair with upsert functionality
  - Full CRUD operations via REST API
  - Complete privacy isolation between users
  - Database model: `PlayerNote`

- **New Services**
  - `BlockchainManager` - Multi-chain deposits and HD wallet management
  - `NotesManager` - Player notes CRUD operations

- **New Routes**
  - `GET /finance/chains` - List supported blockchains and tokens
  - `POST /finance/deposit/start` - Generate deposit address and start tracking
  - `GET /finance/deposit/address` - Get permanent deposit address
  - `GET /finance/deposits` - View deposit history with explorer links
  - `POST /notes` - Create or update player note
  - `GET /notes/:targetId` - Get note for specific player
  - `GET /notes` - Get all notes by authenticated user
  - `DELETE /notes/:targetId` - Delete player note

- **New Dependencies**
  - `@scure/bip32` - HD wallet derivation
  - `@scure/base` - Base encoding utilities
  - `viem` - Ethereum blockchain interactions (already present, now utilized)

- **Database Schema Extensions**
  - User model extended with `wallets`, `deposits`, `notesWritten`, `notesReceived` relations
  - New `DepositStatus` enum (`PENDING`, `CONFIRMED`, `FAILED`)

- **Worker Process**
  - `deposit-monitor` worker for active blockchain scanning
  - Deduplication by wallet address for efficiency
  - Parallel processing with concurrency limits
  - Automatic deposit crediting to user accounts

- **Testing**
  - 6 unit tests for `BlockchainManager` (HD wallet, sessions, address generation)
  - 14 unit tests for `NotesManager` (CRUD operations, validation, edge cases)
  - 12 integration tests for finance routes (deposits, chains, authentication)
  - 19 integration tests for notes routes (privacy, CRUD, multi-user scenarios)
  - Seed script `db:seed:crypto` for blockchain configuration
  - All 102 tests passing in CI/CD pipeline

### Changed

#### @pokertools/api

- Extended `User` model with crypto wallet and notes relations
- Updated README.md with new features section and API documentation
- Modified services plugin to include new managers
- Updated Fastify type declarations for `blockchainManager` and `notesManager`
- Enhanced architecture table with new components
- Updated background workers table with deposit monitor

### Security

#### @pokertools/api

- **HD Wallet Security**
  - Only xPub stored in database (no private keys)
  - Unique address per user via BIP-44 derivation
  - Atomic index increment prevents address collisions
  - xPub rotation support via `isActive` flag

- **Deposit Verification**
  - Transaction hash uniqueness check prevents double-crediting
  - Block confirmation tracking for finality
  - Active session-only scanning prevents resource exhaustion
  - ERC-20 Transfer event verification

- **Privacy Protection**
  - Player notes are strictly private (author-only access)
  - One note per player pair enforced at database level
  - No cross-user note visibility
  - Character limits prevent abuse

## [1.0.1] - 2025-11-30

### Added

#### @pokertools/engine

- `ADD_CHIPS` action for chip rebuys/top-ups during hands
- `RESERVE_SEAT` action for seat reservations with expiry timestamps
- "Wait for Big Blind" logic via `SitInOption` enum

#### @pokertools/types

- `ActionType.ADD_CHIPS` and `ActionType.RESERVE_SEAT` action types
- `AddChipsAction` and `ReserveSeatAction` interfaces
- `PlayerStatus.RESERVED` status for seat reservations
- `SitInOption` enum (`IMMEDIATE`, `WAIT_FOR_BB`)
- `Player.pendingAddOn` field for pending chip additions
- `Player.sitInOption` field for sit-in timing preference
- `Player.reservationExpiry` field for reservation expiration tracking
- Optional `sitInOption` parameter on `SitAction`

### Changed

#### @pokertools/engine

- `handleDeal()` now merges `pendingAddOn` into player stack at hand start
- `handleDeal()` automatically removes expired seat reservations
- `handleDeal()` enforces "Wait for BB" logic in cash games
- `handleSit()` initializes new player fields with defaults
- `gameReducer` supports new management actions

## [1.0.0] - 2025-11-29

### Added

#### @pokertools/engine

- Complete Texas Hold'em poker engine implementation
- Immutable state management (Redux-style)
- TDA rules compliance (100%)
- Chip conservation guarantees
- Side pot calculation with iterative subtraction
- Dead button rule implementation
- Heads-up positioning logic
- Incomplete raise handling
- Auto-runout for all-in scenarios
- Rake calculation (No Flop, No Drop)
- Player view masking for security
- Hand history export
- Comprehensive test suite (117 tests passing)
- Property-based testing with fast-check
- Integration tests for full gameplay scenarios

#### @pokertools/evaluator

- Lightning-fast hand evaluator (16M+ hands/sec)
- Perfect Hash algorithm implementation
- Support for 5, 6, and 7 card hands
- Zero garbage collection overhead
- TypeScript type definitions
- Comprehensive test suite

#### @pokertools/types

- Complete TypeScript type definitions
- Immutable type design
- Zero runtime dependencies
- Shared types across all packages

#### @pokertools/bench

- Performance benchmarking suite
- Comparison with popular evaluators
- Detailed analysis and results

### Changed

- N/A (initial release)

### Deprecated

- N/A (initial release)

### Removed

- N/A (initial release)

### Fixed

- Chip conservation violation in pot recalculation
- Incomplete raise validation for short-stack all-ins
- Action history street tracking
- Property test strictness

### Security

- View masking to prevent cheating
- Integer-only arithmetic to prevent float exploits
- Immutable state to prevent tampering

## Release Process

To create a new release:

1. Update version numbers in package.json files
2. Update this CHANGELOG.md with the new version
3. Commit changes: `git commit -am "chore: release vX.Y.Z"`
4. Create tag: `git tag vX.Y.Z`
5. Push: `git push && git push --tags`
6. Create GitHub Release
7. GitHub Actions will automatically publish to NPM

## Version Number Guidelines

Given a version number MAJOR.MINOR.PATCH:

- MAJOR: Incompatible API changes
- MINOR: Backwards-compatible functionality additions
- PATCH: Backwards-compatible bug fixes

## Links

- [Repository](https://github.com/aaurelions/pokertools)
- [NPM: @pokertools/engine](https://www.npmjs.com/package/@pokertools/engine)
- [NPM: @pokertools/evaluator](https://www.npmjs.com/package/@pokertools/evaluator)
- [NPM: @pokertools/types](https://www.npmjs.com/package/@pokertools/types)

[1.0.7]: https://github.com/aaurelions/pokertools/compare/v1.0.6...v1.0.7
[1.0.6]: https://github.com/aaurelions/pokertools/compare/v1.0.5...v1.0.6
[1.0.5]: https://github.com/aaurelions/pokertools/compare/v1.0.4...v1.0.5
[1.0.4]: https://github.com/aaurelions/pokertools/compare/v1.0.3...v1.0.4
[1.0.3]: https://github.com/aaurelions/pokertools/compare/v1.0.2...v1.0.3
[1.0.2]: https://github.com/aaurelions/pokertools/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/aaurelions/pokertools/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/aaurelions/pokertools/releases/tag/v1.0.0
