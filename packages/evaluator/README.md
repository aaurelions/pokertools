# @pokertools/evaluator

[![npm version](https://img.shields.io/npm/v/@pokertools/evaluator.svg)](https://www.npmjs.com/package/@pokertools/evaluator)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A lightning-fast, strongly-typed Poker Hand Evaluator for Node.js and the browser.

Capable of evaluating **over 16 million 7-card hands per second** on a standard CPU. This library uses a Perfect Hash algorithm (based on Cactus Kev/Paul Senzee) optimized specifically for the V8 JavaScript engine.

## 🚀 Features

- **Extreme Performance:** ~17M evaluations/sec (7-card hands).
- **Zero Garbage Collection:** Uses static memory buffers to prevent GC overhead during Monte Carlo simulations.
- **Flexible:** Supports 5, 6, and 7 card hands.
- **TypeScript:** Written in strict TypeScript with full type definitions.
- **Lightweight:** Zero runtime dependencies.

## ⚡ Benchmarks

Comparison of 7-card hand evaluation speed (Node.js V8):

| Library                   | Input Type  | Speed (Hands/Sec) | Relative Speed |
| :------------------------ | :---------- | :---------------- | :------------- |
| **@pokertools/evaluator** | **Integer** | **~17,900,000**   | **100%**       |
| phe                       | Integer     | ~16,550,000       | 92.5%          |
| poker-evaluator           | String      | ~1,390,000        | 7.7%           |
| pokersolver               | String      | ~73,000           | 0.4%           |

### Raw Output

```text
🃏 Starting Benchmark: 1000 random 7-card hands per cycle
----------------------------------------------------------------
phe (Int)                 |      16,574,257 hands/sec | ±2.26%
poker-evaluator (Str)     |       1,375,495 hands/sec | ±0.33%
pokersolver (Str)         |          70,980 hands/sec | ±0.70%
@pokertools (Int)         |      17,915,292 hands/sec | ±1.56%
----------------------------------------------------------------
🚀 WINNER: @pokertools (Int)
```

_Benchmarks run on an M1 Air. Higher is better._

## 📦 Installation

```bash
npm install @pokertools/evaluator
```

## 📖 Usage

### 1. Basic Usage (Strings)

If you are building a UI or simple game logic, string inputs are easiest to work with.

```typescript
import { evaluateBoard, rankBoard, rankDescription } from "@pokertools/evaluator";

// 1. Get a raw strength score (lower is better)
const score = evaluateBoard("Ah Kh Qh Jh Th 2c 3c");
console.log(score); // 1 (Royal Flush is the lowest/best number)

// 2. Get the Rank Category (Enum)
const rank = rankBoard("Ah As Ks Kd Qs Qd 2c");
console.log(rankDescription(rank)); // "Two Pair"
```

### 2. High-Performance Usage (Integers)

If you are building an Equity Calculator or AI Solver, you should convert cards to integers **once** and pass integers around your system. This creates a 12x performance boost by skipping string parsing.

```typescript
import { evaluate, getCardCode, rank, HandRank } from "@pokertools/evaluator";

// Convert strings to integers once
const holeCards = [getCardCode("As"), getCardCode("Ah")];
const board = [getCardCode("Ks"), getCardCode("Kh"), getCardCode("Qs")];

// Combine arrays (Spread operator is fast enough for small arrays)
const hand = [...holeCards, ...board];

// Evaluate
const strength = evaluate(hand);

// Check Rank
if (rank(hand) === HandRank.FullHouse) {
  console.log("We have a boat!");
}
```

## 📚 API Reference

### Core Functions

#### `evaluate(codes: number[]): number`

The fastest evaluation method. Accepts an array of 5, 6, or 7 integers. Returns a raw score (lower is better).

- Royal Flush: 1
- ...
- Worst High Card: 7462

#### `evaluateStrings(cards: string[]): number`

Helper to evaluate an array of strings like `['Ah', 'Td', ...]`.

#### `evaluateBoard(board: string): number`

Helper to evaluate a space-separated string like `"Ah Td 2c"`.

### Ranking Helpers

#### `rank(codes: number[]): HandRank`

Returns the `HandRank` enum (0-8) for a set of card integers.

#### `HandRank` (Enum)

```typescript
enum HandRank {
  StraightFlush = 0,
  FourOfAKind = 1,
  FullHouse = 2,
  Flush = 3,
  Straight = 4,
  ThreeOfAKind = 5,
  TwoPair = 6,
  OnePair = 7,
  HighCard = 8,
}
```

#### `rankDescription(rank: HandRank): string`

Returns human-readable strings like "Full House" or "High Card".

### Card Encoding

#### `getCardCode(cardStr: string): number`

Converts a card string (e.g., `"Ah"`) into the optimized integer format used by this library.

#### `stringifyCardCode(code: number): string`

Converts an integer back into a readable string.

## 🧮 Algorithm

This library implements the **Perfect Hash** algorithm.

1.  It first checks for a Flush using a bitmask OR operation.
2.  If no flush, it calculates a unique prime-product hash (Quinary) based on the rank counts.
3.  This hash is used as an index into a pre-computed DAG (Directed Acyclic Graph) lookup table to immediately return the hand strength.

This approach avoids expensive sorting or pattern matching operations found in slower libraries.

## License

MIT
