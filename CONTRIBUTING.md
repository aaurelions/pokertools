# Contributing to Pokertools

Thank you for your interest in contributing to Pokertools! This document provides guidelines and instructions for contributing.

This repository uses npm workspaces. The root scripts are the source of truth for common workflows; package-level READMEs provide deeper implementation notes for each workspace.

## Code of Conduct

Be respectful and constructive in all interactions. We're all here to build great poker tools.

## Getting Started

### Prerequisites

- Node.js 24.x or higher
- npm 10.x or higher
- Git
- Docker (for Redis-backed local services and Docker E2E tests)
- Foundry (for admin contract tests and E2E blockchain flows)

### Setup Development Environment

```bash
# Clone the repository
git clone https://github.com/aaurelions/pokertools.git
cd pokertools

# Install dependencies
npm install

# Build all packages
npm run build

# Run tests
npm test
```

For API/admin work, copy the relevant example environment files before starting services:

```bash
cp packages/api/.env.example packages/api/.env
cp packages/admin/.env.example packages/admin/.env
```

## Project Structure

This is a monorepo with multiple packages:

- `packages/types` - TypeScript type definitions
- `packages/evaluator` - Hand evaluator
- `packages/engine` - Poker game engine
- `packages/api` - REST/WebSocket API service
- `packages/sdk` - TypeScript and React client SDK
- `packages/admin` - Fund sweeping and withdrawal administration service
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
npm test -- pokerRulesSpec.test.ts
```

Some service tests require local infrastructure. Use package-specific scripts when needed:

```bash
# API tests with Redis lifecycle managed by package scripts
npm run test:stand-alone -w @pokertools/api

# Admin lifecycle test prerequisites include Foundry contracts and API DB preparation
npm test -w @pokertools/admin

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

- Aim for >90% code coverage
- Test edge cases and error conditions
- Include property-based tests for complex logic

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
