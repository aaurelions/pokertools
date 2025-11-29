# 🃏 PokerTools

[![CI](https://github.com/aaurelions/pokertools/actions/workflows/ci.yml/badge.svg)](https://github.com/aaurelions/pokertools/actions/workflows/ci.yml)
[![NPM Publish](https://github.com/aaurelions/pokertools/actions/workflows/publish.yml/badge.svg)](https://github.com/aaurelions/pokertools/actions/workflows/publish.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A production-ready, high-performance poker toolkit for Node.js and the browser. Built with TypeScript, tested rigorously, and optimized for speed.

## 📦 Packages

| Package                                       | Version                                                                                                               | Description                                          |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| [@pokertools/types](./packages/types)         | [![npm](https://img.shields.io/npm/v/@pokertools/types.svg)](https://www.npmjs.com/package/@pokertools/types)         | TypeScript type definitions for poker game engine    |
| [@pokertools/evaluator](./packages/evaluator) | [![npm](https://img.shields.io/npm/v/@pokertools/evaluator.svg)](https://www.npmjs.com/package/@pokertools/evaluator) | Lightning-fast poker hand evaluator (16M+ hands/sec) |
| [@pokertools/engine](./packages/engine)       | [![npm](https://img.shields.io/npm/v/@pokertools/engine.svg)](https://www.npmjs.com/package/@pokertools/engine)       | Enterprise-grade Texas Hold'em poker engine          |
| [@pokertools/bench](./packages/bench)         | -                                                                                                                     | Performance benchmarks (private package)             |

## ✨ Features

### 🚀 Blazing Fast

- **16+ million** 7-card hand evaluations per second
- Optimized Perfect Hash algorithm for V8 JavaScript engine
- Zero dependencies for core packages

### 🎯 Production Ready

- **117/117 tests passing** (100% compliance)
- Comprehensive test coverage including property-based testing
- Fully compliant with TDA (Tournament Directors Association) rules
- Chip conservation guaranteed - no chips created or destroyed

### 🔒 Type Safe

- Written in TypeScript with full type definitions
- Immutable state management (Redux-style)
- Strict null checking and type safety

### 🎲 Feature Complete

- No-Limit Texas Hold'em engine
- Side pot calculation with iterative subtraction
- Dead button rule implementation
- Heads-up and multi-way support
- Rake calculation (No Flop, No Drop)
- Auto-runout for all-in scenarios
- Incomplete raise handling

## 🚀 Quick Start

### Install Packages

```bash
# Install the hand evaluator
npm install @pokertools/evaluator

# Install the poker engine
npm install @pokertools/engine

# Install type definitions
npm install @pokertools/types
```

### Evaluate a Poker Hand

```typescript
import { evaluate, rankDescription, rank, getCardCodes } from "@pokertools/evaluator";

const cards = ["Ah", "Kh", "Qh", "Jh", "Th", "9c", "2d"];
const cardCodes = getCardCodes(cards);
const score = evaluate(cardCodes);
const handRank = rank(cardCodes);
const description = rankDescription(handRank);

console.log(description); // "Royal Flush"
```

### Run a Poker Game

```typescript
import { PokerEngine } from "@pokertools/engine";
import { ActionType } from "@pokertools/types";

const engine = new PokerEngine({
  smallBlind: 5,
  bigBlind: 10,
  maxPlayers: 6,
});

// Seat players
engine.sit(0, "alice", "Alice", 1000);
engine.sit(1, "bob", "Bob", 1000);

// Deal cards
engine.deal();

// Player actions
engine.act({ type: ActionType.CALL, playerId: "alice" });
engine.act({ type: ActionType.CHECK, playerId: "bob" });

// Access game state
console.log(engine.state.street); // "FLOP"
console.log(engine.state.board); // ["Ah", "Kd", "Qc"]
```

## 📚 Documentation

- **[@pokertools/engine](./packages/engine/README.md)** - Complete engine documentation with examples
- **[@pokertools/evaluator](./packages/evaluator/README.md)** - Hand evaluator API reference
- **[@pokertools/types](./packages/types/README.md)** - TypeScript type definitions
- **[@pokertools/bench](./packages/bench/README.md)** - Performance benchmarks

## 🏗️ Development

This is a monorepo managed with npm workspaces.

### Prerequisites

- Node.js 18.x or higher
- npm 7.x or higher

### Setup

```bash
# Clone the repository
git clone https://github.com/aaurelions/pokertools.git
cd pokertools

# Install dependencies
npm install

# Build all packages
npm run build

# Run all tests
npm test

# Run benchmarks
npm run bench

# Clean build artifacts
npm run clean
```

### Package Scripts

```bash
# Build all packages
npm run build

# Test all packages
npm test

# Test specific package
npm run engine  # Test engine only
npm test -w @pokertools/evaluator  # Test evaluator only

# Run benchmarks
npm run bench
```

## 🧪 Testing

All packages include comprehensive test suites:

- **Unit Tests** - Testing individual functions and components
- **Integration Tests** - Testing full gameplay scenarios
- **Property Tests** - Random scenario testing with fast-check
- **Compliance Tests** - Verification against TDA poker rules

```bash
# Run all tests
npm test

# Run tests for specific package
npm test -w @pokertools/engine
npm test -w @pokertools/evaluator

# Run tests in watch mode
npm test -- --watch
```

## 📊 Performance

Benchmark results on Apple M1 Air (2020):

| Evaluator                 | Hands/sec      | Speed vs @pokertools/evaluator |
| ------------------------- | -------------- | ------------------------------ |
| **@pokertools/evaluator** | **17,915,292** | **1.00x (baseline)**           |
| phe (native C++)          | 16,574,257     | 0.93x                          |
| poker-evaluator           | 1,375,495      | 0.08x                          |
| pokersolver               | 70,980         | 0.004x                         |

See [packages/bench](./packages/bench) for detailed benchmarks.

## 🎯 Use Cases

### Online Poker Platforms

- Real-money poker games
- Tournament management
- Cash game tables
- Play-money games

### Game Development

- Poker training apps
- Mobile poker games
- Browser-based poker
- Discord/Telegram bots

### Analytics & Tools

- Hand history analysis
- Equity calculators
- Range analysis
- Training software

## 📝 License

MIT © PokerTools

All packages in this monorepo are licensed under the MIT License. See the [LICENSE](./LICENSE) file for details.

---

Made with ❤️ by poker enthusiasts, for poker enthusiasts.
