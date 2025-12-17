# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[Unreleased]: https://github.com/aaurelions/pokertools/compare/v1.0.1...HEAD
[1.0.1]: https://github.com/aaurelions/pokertools/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/aaurelions/pokertools/releases/tag/v1.0.0
