# Contributing to Pokertools

Thank you for your interest in contributing to Pokertools! This document provides guidelines and instructions for contributing.

This repository uses npm workspaces. The root scripts are the source of truth for common workflows; package-level READMEs provide deeper implementation notes for each workspace.

## Code of Conduct

Be respectful and constructive in all interactions. We're all here to build great poker tools.

## Getting Started

### Prerequisites

- Node.js ^24.15.0 || >=26.0.0
- npm 12.2.0 or higher
- Git
- Docker (for Redis-backed local services and Docker E2E tests)
- Foundry (for custody contract tests and E2E blockchain flows)

### Setup Development Environment

```bash
# Clone the repository
git clone --recurse-submodules https://github.com/aaurelions/pokertools.git
cd pokertools

# Install dependencies
npm ci

# Build all packages
npm run build

# Run tests
npm test
```

For API/custody work, copy the relevant example environment files before starting services:

```bash
cp packages/api/.env.example packages/api/.env
cp packages/custody/.env.example packages/custody/.env
```

For production-style Docker deployment, copy the root template and keep the filled file out of git:

```bash
cp .env.example .env.production
```

## Project Structure

This is a monorepo with multiple packages:

- `packages/types` - TypeScript type definitions
- `packages/evaluator` - Hand evaluator
- `packages/engine` - Poker game engine
- `packages/api` - REST/WebSocket API service
- `packages/sdk` - TypeScript and React client SDK
- `packages/custody` - Private signing and custody worker
- `packages/e2e` - Docker-based end-to-end tests
- `packages/bench` - Performance benchmarks (private)

Before making changes, read the README for the package you are touching. Keep that README accurate whenever you change public APIs, exported types, routes, environment variables, scripts, operational behavior, or security-sensitive flows.

## Development Workflow

### Making Changes

1. Create a new branch from `main`:

   ```bash
   git checkout -b feature/your-feature-name
   ```

2. Make your changes and ensure tests pass:

   ```bash
   npm run format:check
   npm run lint
   npm test
   ```

3. Build to verify TypeScript compilation:

   ```bash
   npm run build
   ```

4. Commit your changes with clear commit messages:
   ```bash
   git commit -m "feat: add new feature"
   ```

### Commit Message Format

We follow the Conventional Commits specification:

- `feat:` - New feature
- `fix:` - Bug fix
- `docs:` - Documentation changes
- `test:` - Adding or updating tests
- `refactor:` - Code refactoring
- `perf:` - Performance improvements
- `chore:` - Maintenance tasks

Examples:

```
feat(engine): add support for Omaha poker
fix(evaluator): correct hand ranking for wheel straight
docs(readme): update installation instructions
test(engine): add tests for incomplete raise logic
```

### Running Tests

```bash
# Run all tests
npm test

# Run fast unit/package tests used by the precommit script
npm run test:quick

# Run tests for specific package
npm test -w @pokertools/engine
npm test -w @pokertools/evaluator

# Run tests in watch mode
npm test -- --watch

# Run specific test file
npm test -w @pokertools/engine -- tests/integration/poker-rules-spec.test.ts
```

Some service tests require local infrastructure. Use package-specific scripts when needed:

```bash
# API tests with Redis lifecycle managed by package scripts
npm run test:stand-alone -w @pokertools/api

# Custody workflow tests use API DB preparation; contracts require Foundry
npm test -w @pokertools/custody

# Docker-based full-stack E2E suite
npm run e2e:docker
```

### Building Packages

```bash
# Build all packages
npm run build

# Build specific package
npm run build -w @pokertools/engine
```

## Testing Guidelines

### Test Requirements

All code changes must include tests:

- **New Features**: Add integration tests demonstrating the feature
- **Bug Fixes**: Add regression tests that fail without the fix
- **Refactoring**: Ensure existing tests still pass

### Test Structure

```typescript
describe('Feature Name', () => {
  test('should handle specific case', () => {
    // Arrange
    const engine = new PokerEngine({ ... });

    // Act
    const result = engine.act({ ... });

    // Assert
    expect(result.street).toBe('FLOP');
  });
});
```

### Test Coverage

- Preserve package-level coverage gates; see [testing](docs/guide/testing.md)
- Test edge cases and error conditions
- Include property-based tests for complex logic

Shared wire contracts belong in `@pokertools/types`; private ports remain with
their domain. Preserve [dependency directions](docs/guide/architecture.md).
Run focused tests for local edits, then infrastructure acceptance for changes
to persistence, finance, custody or public protocols. Coverage is not acceptance.

## Code Style

### TypeScript

- Use strict TypeScript settings
- Prefer interfaces over types for objects
- Use `readonly` for immutable properties
- Avoid `any` - use proper types

### File and Import Naming

- Use lowercase kebab-case filenames for TypeScript source, test, helper, and script files (for example, `game-reducer.ts`, `side-pots.test.ts`, and `prisma-client.ts`).
- Keep conventional entrypoint and config names such as `index.ts`, `index.tsx`, `config.ts`, `app.ts`, `server.ts`, `setup.ts`, `*.config.ts`, `fastify.d.ts`, and `shims.d.ts`.
- Keep exported TypeScript identifiers in normal TypeScript casing: `UpperCamelCase` for classes/interfaces/types/enums, `lowerCamelCase` for functions/variables/properties, and `CONSTANT_CASE` only for true module-level constants.
- Update import/export specifiers to match disk casing exactly. Public package imports should flow through package entrypoints unless a subpath export is intentionally supported.
- Do not rename Solidity contract files as part of TypeScript naming cleanup unless deploy tooling and imports are updated with special care.

### Formatting

- Run the formatter and linter before committing:
  ```bash
  npm run format
  npm run lint
  ```
- For CI-equivalent local validation, run:
  ```bash
  npm run validate
  ```

### Best Practices

- Keep functions small and focused
- Prefer pure functions (no side effects)
- Use descriptive variable names
- Add or update package README sections for public APIs, exported types, routes, WebSocket messages, environment variables, scripts, and security-relevant behavior
- Add JSDoc comments for public APIs when they clarify usage or invariants
- Avoid premature optimization

## Documentation Standards

Package README files are developer documentation, not marketing pages. Keep them:

- **Implementation-backed**: examples and tables must match current source, package exports, tests, and configuration.
- **Operationally useful**: document prerequisites, scripts, environment variables, dependencies, and failure modes.
- **Security-aware**: link to [SECURITY.md](./SECURITY.md) and call out secrets, authentication, authorization, randomness, financial integrity, and hidden-information boundaries where relevant.
- **Current**: update versions, Node/npm requirements, route names, WebSocket messages, and test commands when they change.
- **Complete but concise**: prefer accurate tables and minimal runnable examples over speculative roadmaps.

Do not add placeholders, TODO-only sections, undocumented claims, generated benchmark numbers without reproduction steps, or examples that cannot compile against current package exports.

## Pull Request Process

1. **Update Documentation**: If you change APIs, routes, env vars, scripts, security behavior, or package exports, update the affected README files

2. **Add Tests**: Ensure all new code has tests

3. **Verify CI**: Ensure GitHub Actions pass

4. **Update Changelog**: Add entry to CHANGELOG.md

5. **Submit PR**:
   - Fill out the PR template
   - Link related issues
   - Request review

### PR Checklist

- [ ] Tests added/updated
- [ ] Documentation updated, including package README(s) where applicable
- [ ] Changelog updated
- [ ] All tests pass (`npm test`)
- [ ] Format check passes (`npm run format:check`)
- [ ] Lint passes (`npm run lint`)
- [ ] Build succeeds (`npm run build`)
- [ ] No TypeScript errors
- [ ] Follows code style guidelines

## Releasing

### Dependency policy

Use stable mutually compatible versions, not prerelease dist-tags, broad
ranges or forced peer overrides; the narrow exact parent-scoped security
overrides below are the only exception. Three version lines are intentionally
held; do not "fix" them just to clear `npm outdated`:

| Dependency             | Held at | Reason                                                                                                                     |
| :--------------------- | :------ | :------------------------------------------------------------------------------------------------------------------------- |
| `typescript`           | 6.0.3   | `typescript-eslint@8.71.0` peers on `typescript >=4.8.4 <6.1.0`, so stable 7.0.2 is out of range; tsup/ts-node target TS6. |
| `prisma` / `@prisma/*` | 7.10.0  | Stable line; the newer dist-tag is an RC.                                                                                  |
| `redlock`              | 4.x     | Stable line; newer dist-tags are beta.                                                                                     |

Every manifest requires Node.js `^24.15.0 || >=26.0.0` and npm `>=12.2.0`.
The Node range mirrors `jsdom@30.1.1` (`^22.22.2 || ^24.15.0 || >=26.0.0`);
Node 25 and 24.x below 24.15 are unsupported. npm 12.2 is required because
npm 12 enforces the `allowScripts` policy (npm 11.16 only warns). CI must
install npm 12.2 before `npm ci`, and Docker builder/runtime images must pin
the same npm.

Recheck these constraints before upgrading, rather than changing versions
solely to clear `outdated`.

#### Security overrides

Prisma 7.10.0 (latest stable 7.x) exact-pins vulnerable transitive packages.
Two narrow, exact, parent-scoped `overrides` in the root `package.json`
remediate them without forcing unrelated versions:

| Parent (exact)          | Override             | Fixed advisory                                             |
| :---------------------- | :------------------- | :--------------------------------------------------------- |
| `@prisma/config@7.10.0` | `deepmerge-ts` 8.0.2 | GHSA-ggr8-5vv4-36mx (high) — fixed only in major 8         |
| `prisma@7.10.0`         | `mysql2` 3.24.5      | GHSA-3f6p-5ww8-9rcr (high), GHSA-rgwj-5xj2-c3m3 (moderate) |

`@prisma/config` only imports the named `deepmerge` export and passes it to
`c12` as the config merger. An isolated temp install of `@prisma/config@7.10.0`
with the override produced identical `loadConfigFromFile` output and identical
`deepmerge` results versus 7.1.5, and `prisma validate`, `prisma db push`
(SQLite) and `prisma generate` all pass with the overrides. The root `prisma`
direct devDependency is pinned to exact `7.10.0` because npm rejects a
parent-scoped override whose parent is a direct dependency unless the specs
match exactly.

Remove each override entry when the upstream stable Prisma release ships fixed
`mysql2`/`deepmerge-ts`, then refresh the lockfile. Until then, any Prisma or
override change must run the SQLite and PostgreSQL paths:

```bash
npm run db:generate -w @pokertools/api                        # SQLite client generation
(cd packages/api && node scripts/validate-migrations.mjs)     # SQLite db push + schema.sql parity
npm run db:migrate -w @pokertools/api                         # PostgreSQL migrations
npm run test:postgres:migrations -w @pokertools/api           # disposable PostgreSQL acceptance
```

`npm audit --omit=dev` is clean after these overrides. Docker still prunes the
CLI graph from the runtime image, and
`node scripts/test-runtime-dependencies.mjs <image>` verifies its absence. The
full root audit retains only a low dev-only `esbuild` advisory
(GHSA-g7r4-m6w7-qqqr, Windows dev-server file read) in tsup's nested 0.27.x;
latest tsup 8.5.1 still declares `esbuild ^0.27.0`, so the only in-range "fix"
is a downgrade and it is absent from `--omit=dev`.

#### Docs dependency class

The docs site depends only on build-time generators (`vitepress`,
`markdown-it`, `vue`), classified as `devDependencies`; the generated site is
static HTML and none of them is a runtime artifact. `markdown-it-mathjax3`
(MathJax + `speech-rule-engine` + `@xmldom/xmldom`) was removed rather than
held at 4.3.2: no docs page used math rendering except one formatting demo,
which now shows formulas as plain code/text. VitePress stays on the latest
stable 1.6.4 (no prerelease, no Vite override); the full docs audit retains
only VitePress's bundled `vite` 5.x/esbuild 0.21.5 advisories, which have no
stable-1.x fix. The Vite 5 advisory is an optional dev-server residual, not
part of the built site; the docs dev script binds loopback only (no
`--host 0.0.0.0`), but VitePress 1.6.4's preview server ignores `--host` and
listens on all interfaces, so run preview only on trusted machines.
`npm --prefix docs audit --omit=dev` is clean.

#### Install-script policy

npm 11.16 introduced the `allowScripts` policy and only warned about blocked
dependency install scripts; npm 12 enforces it by skipping unreviewed scripts
by default. Approve exact resolved versions after a lockfile refresh instead of
blanket-approving:

```bash
npm install-scripts ls               # read-only: unreviewed install scripts
npm install-scripts prune --dry-run  # stale pins left by upgraded dependencies
npm install-scripts prune
npm approve-scripts <pkg>            # re-pin a specific reviewed upgrade
```

#### Dependency regression commands

Run after dependency, lockfile or publish-manifest changes:

```bash
# Held peer ranges still resolve.
npm ls typescript typescript-eslint
npm --prefix docs ls vitepress markdown-it

# Node floor and code still pass.
npm run typecheck
npm run lint
npm test

# Docs build on latest stable VitePress 1.x (no math renderer).
npm --prefix docs run docs:build

# Audit posture: both production trees are clean; the full root audit keeps
# only the low dev-only esbuild advisory documented above.
npm --prefix docs audit --omit=dev
npm audit --omit=dev

# Publishable tarballs ship compiled output only (no hidden build metadata).
npm run check:publish
```

`check-publish-contents` fails if `dist/.tsbuildinfo` or
`dist/.nlhe-build-stamp` reappear; the generic `!dist/.*` / `!dist/**/.*`
exclusions in the publishable workspaces keep them out. Source maps under
`dist/` remain intentionally public for the SDK.

Releases are handled by maintainers:

1. Update version in package.json files
2. Update CHANGELOG.md
3. Create git tag
4. Push to GitHub
5. Create GitHub Release
6. GitHub Actions will publish to NPM

## Need Help?

- **Questions**: Open a GitHub Discussion
- **Bugs**: Open a GitHub Issue
- **Security**: Email security concerns privately

## Recognition

Contributors will be recognized in:

- GitHub contributor list
- CHANGELOG.md for significant contributions
- Project README for major features

## License

By contributing, you agree that your contributions will be licensed under the MIT License.

---

Thank you for contributing to Pokertools! 🎴
