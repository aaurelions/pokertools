# Contributing to Pokertools

Thank you for your interest in contributing to Pokertools! This document provides guidelines and instructions for contributing.

## Code of Conduct

Be respectful and constructive in all interactions. We're all here to build great poker tools.

## Getting Started

### Prerequisites

- Node.js 18.x or higher
- npm 7.x or higher
- Git

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

## Project Structure

This is a monorepo with multiple packages:

- `packages/types` - TypeScript type definitions
- `packages/evaluator` - Hand evaluator
- `packages/engine` - Poker game engine
- `packages/bench` - Performance benchmarks (private)

## Development Workflow

### Making Changes

1. Create a new branch from `main`:

   ```bash
   git checkout -b feature/your-feature-name
   ```

2. Make your changes and ensure tests pass:

   ```bash
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

# Run tests for specific package
npm test -w @pokertools/engine
npm test -w @pokertools/evaluator

# Run tests in watch mode
npm test -- --watch

# Run specific test file
npm test -- pokerRulesSpec.test.ts
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

### Formatting

- Run the linter before committing:
  ```bash
  npm run lint
  ```

### Best Practices

- Keep functions small and focused
- Prefer pure functions (no side effects)
- Use descriptive variable names
- Add JSDoc comments for public APIs
- Avoid premature optimization

## Pull Request Process

1. **Update Documentation**: If you change APIs, update README files

2. **Add Tests**: Ensure all new code has tests

3. **Verify CI**: Ensure GitHub Actions pass

4. **Update Changelog**: Add entry to CHANGELOG.md

5. **Submit PR**:
   - Fill out the PR template
   - Link related issues
   - Request review

### PR Checklist

- [ ] Tests added/updated
- [ ] Documentation updated
- [ ] Changelog updated
- [ ] All tests pass (`npm test`)
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
