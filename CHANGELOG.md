# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Initial monorepo setup
- GitHub Actions CI/CD pipeline
- Comprehensive documentation

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

[Unreleased]: https://github.com/aaurelions/pokertools/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/aaurelions/pokertools/releases/tag/v1.0.0
