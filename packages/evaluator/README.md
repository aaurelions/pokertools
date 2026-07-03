# 🃏 @pokertools/evaluator

> **High-performance poker hand evaluator for 5, 6, and 7 card hands**

[![npm version](https://img.shields.io/npm/v/@pokertools/evaluator.svg)](https://www.npmjs.com/package/@pokertools/evaluator)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-blue.svg)](https://www.typescriptlang.org/)

A blazing-fast poker hand evaluator using **perfect hash tables** and **lookup tables** for O(1) hand evaluation. Designed for Monte Carlo simulations and real-time poker applications.

---

## Table of Contents

- [⚡ Performance](#-performance)
- [📦 Installation](#-installation)
- [🚀 Quick Start](#-quick-start)
- [📖 API Reference](#-api-reference)
- [🎯 Score System](#-score-system)
- [🔧 Advanced Usage](#-advanced-usage)
- [🧪 Testing](#-testing)
- [⚙️ Configuration](#-configuration)
- [🏗️ Architecture](#-architecture)
- [⚠️ Important Notes](#-important-notes)
- [📊 Combinatorics Verification](#-combinatorics-verification)
- [🔗 Related Packages](#-related-packages)
- [📄 License](#-license)
- [🙏 Credits](#-credits)

---

## ⚡ Performance

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         BENCHMARK RESULTS                                   │
├─────────────────────────────────────────────────────────────────────────────┤
│  5 cards:  ~15-20 million evaluations/second                                │
│  6 cards:  ~12-15 million evaluations/second                                │
│  7 cards:  ~10-12 million evaluations/second                                │
├─────────────────────────────────────────────────────────────────────────────┤
│  Memory footprint: ~2.5 MB (lookup tables)                                  │
│  Algorithm: Perfect hash + suit hash + lookup tables                        │
│  Complexity: O(1) per evaluation                                            │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 📦 Installation

```bash
npm install @pokertools/evaluator
```

```bash
yarn add @pokertools/evaluator
```

```bash
pnpm add @pokertools/evaluator
```

---

## 🚀 Quick Start

```typescript
import {
  evaluate,
  evaluateStrings,
  evaluateBoard,
  rank,
  rankBoard,
  rankDescription,
  stringifyCardCode,
  HandRank,
} from "@pokertools/evaluator";

// Method 1: Evaluate card strings
const score = evaluateStrings(["As", "Kh", "Qd", "Jc", "Ts"]);
console.log(score); // Lower score = better hand

// Method 2: Evaluate board string
const score2 = evaluateBoard("As Kh Qd Jc Ts");

// Method 3: Get hand rank category
const handRank = rankBoard("As Kh Qd Jc Ts");
console.log(handRank); // 4 (Straight)
console.log(rankDescription(handRank)); // "Straight"
```

---

## 📖 API Reference

### Core Functions

#### `evaluate(codes: number[]): number`

Evaluates 5, 6, or 7 card integer codes. Returns a strength score where **lower is better**.

```typescript
import { evaluate, getCardCode } from "@pokertools/evaluator";

// Convert cards to codes manually
const codes = [
  getCardCode("As"), // 48
  getCardCode("Kh"), // 45
  getCardCode("Qd"), // 42
  getCardCode("Jc"), // 39
  getCardCode("Ts"), // 32
];

const score = evaluate(codes);
// Royal flush will have score = 1 (best possible)
```

---

#### `evaluateStrings(cards: string[]): number`

Evaluates an array of card strings. Convenient but slightly slower than `evaluate()` due to parsing overhead.

```typescript
import { evaluateStrings } from "@pokertools/evaluator";

// 5-card hand
const score5 = evaluateStrings(["As", "Ks", "Qs", "Js", "Ts"]);

// 6-card hand (best 5 of 6)
const score6 = evaluateStrings(["As", "Ks", "Qs", "Js", "Ts", "2h"]);

// 7-card hand (Texas Hold'em)
const score7 = evaluateStrings(["As", "Ks", "Qs", "Js", "Ts", "2h", "3c"]);
```

---

#### `evaluateBoard(board: string): number`

Evaluates a space-separated board string.

```typescript
import { evaluateBoard } from "@pokertools/evaluator";

// Standard Texas Hold'em (2 hole + 5 community)
const score = evaluateBoard("As Ks Qs Js Ts 2h 3c");

// Just the board (5 community cards)
const boardScore = evaluateBoard("As Ks Qs Js Ts");

// Extra whitespace is handled
const score2 = evaluateBoard("As  Ks   Qs Js Ts");
```

---

#### `rank(codes: number[]): HandRank`

Returns the hand rank category (0-8) for card integer codes.

```typescript
import { rank, getCardCodes, HandRank } from "@pokertools/evaluator";

const codes = getCardCodes(["As", "Ah", "Ad", "Ac", "Kh"]);
const handRank = rank(codes);

console.log(handRank === HandRank.FourOfAKind); // true
```

---

#### `rankBoard(board: string): HandRank`

Returns the hand rank category for a board string.

```typescript
import { rankBoard, HandRank } from "@pokertools/evaluator";

const handRank = rankBoard("As Ks Qs Js Ts");
console.log(handRank === HandRank.StraightFlush); // true
```

---

#### `rankDescription(rank: HandRank): string`

Returns the human-readable name of a hand rank.

```typescript
import { rankBoard, rankDescription } from "@pokertools/evaluator";

const handRank = rankBoard("As Ah Ad Kh Kd");
const name = rankDescription(handRank);
console.log(name); // "Full House"
```

---

### Utility Functions

#### `getCardCode(cardStr: string): number`

Converts a 2-character card string to an integer code.

```typescript
import { getCardCode } from "@pokertools/evaluator";

const aceOfSpades = getCardCode("As"); // 48
const kingOfHearts = getCardCode("Kh"); // 45
const tenOfDiamonds = getCardCode("Td"); // 34
const twoOfClubs = getCardCode("2c"); // 3
```

**Card Format:**

```
┌─────────────────────────────────────────────────────────────────┐
│                    CARD FORMAT: [Rank][Suit]                    │
├─────────────────────────────────────────────────────────────────┤
│  Ranks: 2, 3, 4, 5, 6, 7, 8, 9, T, J, Q, K, A                   │
│  Suits: s (♠ spades), h (♥ hearts), d (♦ diamonds), c (♣ clubs) │
├─────────────────────────────────────────────────────────────────┤
│  ⚠️ Rank must be UPPERCASE (T, J, Q, K, A)                       │
│  ⚠️ Suit must be LOWERCASE (s, h, d, c)                          │
└─────────────────────────────────────────────────────────────────┘
```

---

#### `getCardCodes(cards: string[]): number[]`

Converts an array of card strings to integer codes.

```typescript
import { getCardCodes } from "@pokertools/evaluator";

const codes = getCardCodes(["As", "Kh", "Qd", "Jc", "Ts"]);
// [48, 45, 42, 39, 32]
```

---

#### `stringifyCardCode(code: number): string`

Converts an integer code back to a card string.

```typescript
import { stringifyCardCode } from "@pokertools/evaluator";

stringifyCardCode(48); // "As"
stringifyCardCode(0); // "2s"
stringifyCardCode(51); // "Ac"
```

---

### Constants & Types

#### `HandRank` Enum

```typescript
import { HandRank } from "@pokertools/evaluator";

const enum HandRank {
  StraightFlush = 0, // 🏆 Best
  FourOfAKind = 1,
  FullHouse = 2,
  Flush = 3,
  Straight = 4,
  ThreeOfAKind = 5,
  TwoPair = 6,
  OnePair = 7,
  HighCard = 8, // Worst
}
```

**Hand Rank Distribution (5-card hands):**

| Rank | Name            | Count     | Probability |
| ---- | --------------- | --------- | ----------- |
| 0    | Straight Flush  | 40        | 0.00154%    |
| 1    | Four of a Kind  | 624       | 0.02401%    |
| 2    | Full House      | 3,744     | 0.14406%    |
| 3    | Flush           | 5,108     | 0.19654%    |
| 4    | Straight        | 10,200    | 0.39246%    |
| 5    | Three of a Kind | 54,912    | 2.11285%    |
| 6    | Two Pair        | 123,552   | 4.75390%    |
| 7    | One Pair        | 1,098,240 | 42.25690%   |
| 8    | High Card       | 1,302,540 | 50.11774%   |

---

#### `HAND_RANK_DESCRIPTIONS`

Map of hand rank enums to human-readable names.

```typescript
import { HAND_RANK_DESCRIPTIONS, HandRank } from "@pokertools/evaluator";

console.log(HAND_RANK_DESCRIPTIONS[HandRank.FullHouse]); // "Full House"
console.log(HAND_RANK_DESCRIPTIONS[HandRank.StraightFlush]); // "Straight Flush"
```

---

## 🎯 Score System

The evaluator returns a **score** where **lower is better**:

```
Score Range     Hand Type
───────────────────────────────────────
1-10           Straight Flush (Royal Flush = 1)
11-166         Four of a Kind
167-322        Full House
323-1599       Flush
1600-1609      Straight
1610-2467      Three of a Kind
2468-3325      Two Pair
3326-6185      One Pair
6186-7462      High Card
```

### Comparing Hands

```typescript
import { evaluateStrings } from "@pokertools/evaluator";

const royalFlush = evaluateStrings(["As", "Ks", "Qs", "Js", "Ts"]);
const straightFlush = evaluateStrings(["9h", "8h", "7h", "6h", "5h"]);
const fourOfAKind = evaluateStrings(["Ac", "Ah", "Ad", "As", "Kh"]);
const fullHouse = evaluateStrings(["Kh", "Kd", "Ks", "Qh", "Qd"]);

// Lower score wins
console.log(royalFlush); // 1
console.log(straightFlush); // 2-10
console.log(fourOfAKind); // 11-166
console.log(fullHouse); // 167-322

// Comparison
console.log(royalFlush < straightFlush); // true (royal beats straight flush)
console.log(fourOfAKind < fullHouse); // true (quads beat boat)
```

---

## 🔧 Advanced Usage

### Monte Carlo Simulation

```typescript
import { evaluate } from "@pokertools/evaluator";

function monteCarloEquity(
  heroHand: number[],
  villainHand: number[],
  board: number[],
  simulations: number = 100000
): number {
  let wins = 0;
  const deck = createDeck().filter(
    (c) => !heroHand.includes(c) && !villainHand.includes(c) && !board.includes(c)
  );

  for (let i = 0; i < simulations; i++) {
    const shuffled = shuffle(deck);
    const remainingCards = 5 - board.length;
    const runout = [...board, ...shuffled.slice(0, remainingCards)];

    const heroScore = evaluate([...heroHand, ...runout]);
    const villainScore = evaluate([...villainHand, ...runout]);

    if (heroScore < villainScore) wins++;
    else if (heroScore === villainScore) wins += 0.5;
  }

  return wins / simulations;
}
```

### Hand Range Analysis

```typescript
import { evaluate, getCardCodes } from "@pokertools/evaluator";

function analyzeRange(
  holeCards: string[],
  board: string[],
  range: string[][]
): { wins: number; ties: number; losses: number } {
  const heroCodes = getCardCodes(holeCards);
  const boardCodes = getCardCodes(board);
  const heroScore = evaluate([...heroCodes, ...boardCodes]);

  let wins = 0,
    ties = 0,
    losses = 0;

  for (const hand of range) {
    const villainCodes = getCardCodes(hand);
    const villainScore = evaluate([...villainCodes, ...boardCodes]);

    if (heroScore < villainScore) wins++;
    else if (heroScore === villainScore) ties++;
    else losses++;
  }

  return { wins, ties, losses };
}
```

### Finding Best 5 from 7

The evaluator automatically finds the best 5-card hand from 6 or 7 cards:

```typescript
import { evaluateStrings, rankBoard, rankDescription } from "@pokertools/evaluator";

// 7 cards: 2 hole cards + 5 community cards
const cards = ["As", "Kh", "Qs", "Js", "Ts", "2c", "3d"];
const score = evaluateStrings(cards);
const handRank = rankBoard(cards.join(" "));

console.log(rankDescription(handRank)); // "Straight" (A-K-Q-J-T)
// The 2c and 3d are ignored - best 5 cards selected automatically
```

---

## 🧪 Testing

The evaluator comes with a comprehensive test suite covering multiple dimensions of correctness.

```bash
# Run all tests for the evaluator package
npm test -w @pokertools/evaluator
```

### Test Categories

| Category           | File                             | Coverage                                                                                 |
| ------------------ | -------------------------------- | ---------------------------------------------------------------------------------------- |
| Basic correctness  | `tests/evaluator.test.ts`        | 5-card, 6-card, and 7-card hands across all 9 hand ranks                                 |
| Edge cases         | `tests/edge-cases.test.ts`       | Steel wheel, tied hands, best-5-from-7 selection, score direction                        |
| Input validation   | `tests/input-validation.test.ts` | Invalid card strings, wrong argument counts, boundary inputs                             |
| Frequency analysis | `tests/frequency.test.ts`        | Combinatorial verification of all 2,598,960 5-card hands and all 20,358,520 6-card hands |

### Frequency Tests

The frequency tests verify that the evaluator produces mathematically correct hand-rank distributions over every possible combination:

| Cards | Combinations | Run Time | Always Runs |
| ----- | ------------ | -------- | ----------- |
| 5     | 2,598,960    | ~200ms   | Yes         |
| 6     | 20,358,520   | ~2s      | Yes         |
| 7     | 133,784,560  | ~15s     | No (gated)  |

The 7-card frequency test is gated behind an environment variable because it iterates over 134 million combinations. See [Configuration](#-configuration) for details on enabling it.

---

## ⚙️ Configuration

The evaluator is a **pure function library** with no runtime configuration. There are no environment variables, config files, or constructor options to set — every exported function operates deterministically based solely on its inputs.

### Heavy Tests

When modifying the core evaluation logic, you can enable the full 7-card combinatorial frequency test to verify correctness against all 133,784,560 possible 7-card hands:

```bash
ENABLE_HEAVY_TESTS=true npm test -w @pokertools/evaluator
```

This flag is only relevant in development and has no effect on the built library.

---

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         EVALUATOR ARCHITECTURE                              │
└─────────────────────────────────────────────────────────────────────────────┘

┌──────────────┐
│  Input Cards │  "As", "Kh", "Qd"...
└──────┬───────┘
       │
       ▼
┌──────────────┐
│  Card Parser │  getCardCode() → Integer encoding
│              │  Format: (RankIndex << 2) | SuitIndex
└──────┬───────┘
       │  [48, 45, 42, 39, 32]
       ▼
┌──────────────────────────────────────────────────────────────┐
│                      EVALUATOR CORE                          │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌────────────────┐     ┌────────────────┐                   │
│  │  Suit Hash     │────▶│  Flush Check   │                   │
│  │  Detection     │     │  SUITS_HASH[]  │                   │
│  └────────────────┘     └───────┬────────┘                   │
│                                 │                            │
│         ┌───────────────────────┼───────────────────┐        │
│         │ FLUSH                 │ NO FLUSH          │        │
│         ▼                       ▼                   │        │
│  ┌────────────────┐     ┌────────────────┐          │        │
│  │ FLUSH_LOOKUP[] │     │ Quinary Hash   │          │        │
│  │  8192 entries  │     │ hashQuinary()  │          │        │
│  └───────┬────────┘     └───────┬────────┘          │        │
│          │                      │                   │        │
│          │              ┌───────┴────────┐          │        │
│          │              ▼       ▼        ▼          │        │
│          │        ┌─────────┬─────────┬─────────┐   │        │
│          │        │NO_FLUSH │NO_FLUSH │NO_FLUSH │   │        │
│          │        │   _5    │   _6    │   _7    │   │        │
│          │        │  49205  │ 246520  │ 1070190 │   │        │
│          │        └────┬────┴────┬────┴────┬────┘   │        │
│          │             │         │         │        │        │
│          └─────────────┴─────────┴─────────┘        │        │
│                              │                      │        │
└──────────────────────────────┼──────────────────────┘        │
                               │                               │
                               ▼                               │
                        ┌──────────────┐                       │
                        │    SCORE     │  1-7462               │
                        │ (lower=better)│                      │
                        └──────────────┘                       │
```

### Card Encoding

```
Card Integer = (RankIndex << 2) | SuitIndex

Rank Index: 2=0, 3=1, 4=2, 5=3, 6=4, 7=5, 8=6, 9=7, T=8, J=9, Q=10, K=11, A=12
Suit Index: s=0, h=1, d=2, c=3

Examples:
  "2s" = (0 << 2) | 0 = 0
  "2h" = (0 << 2) | 1 = 1
  "As" = (12 << 2) | 0 = 48
  "Ac" = (12 << 2) | 3 = 51
```

### Lookup Tables

| Table          | Size      | Purpose                       |
| -------------- | --------- | ----------------------------- |
| `FLUSH_LOOKUP` | 8,192     | Direct lookup for flush hands |
| `NO_FLUSH_5`   | 49,205    | 5-card non-flush hands        |
| `NO_FLUSH_6`   | 246,520   | 6-card non-flush hands        |
| `NO_FLUSH_7`   | 1,070,190 | 7-card non-flush hands        |
| `SUITS_HASH`   | 8,192     | Suit hash detection           |
| `DP_MATRIX`    | ~3,500    | Perfect hash calculation      |

---

## ⚠️ Important Notes

### Thread Safety

```typescript
/**
 * ⚠️ NOT THREAD-SAFE / NOT RE-ENTRANT
 *
 * The evaluator uses static buffers for performance.
 *
 * ✅ SAFE:
 *   - Sequential calls
 *   - Async/await (yields between calls)
 *   - Different JavaScript contexts
 *
 * ❌ UNSAFE:
 *   - Recursive evaluate() calls
 *   - SharedArrayBuffer / Worker threads
 *   - Calling evaluate() from within evaluate()
 */

// ✅ Safe: Sequential
const a = evaluate(hand1);
const b = evaluate(hand2);

// ✅ Safe: Async
for (const hand of hands) {
  const score = evaluate(hand);
  await saveToDatabase(score);
}

// ❌ UNSAFE: Recursive
function bad(cards) {
  if (cards.length > 7) {
    return evaluate(cards.slice(0, 7)); // DON'T DO THIS
  }
  return evaluate(cards);
}
```

### Input Validation

The evaluator does **not** validate for duplicate cards. Duplicate card detection is the responsibility of the game engine.

```typescript
// ❌ No error thrown, but undefined behavior
evaluate([0, 0, 0, 0, 0]); // 5 identical cards

// ✅ Validate before calling
function safeEvaluate(codes: number[]): number {
  const unique = new Set(codes);
  if (unique.size !== codes.length) {
    throw new Error("Duplicate cards detected");
  }
  return evaluate(codes);
}
```

### Card Format Requirements

```typescript
// ✅ Correct format
getCardCode("As"); // Ace of spades
getCardCode("Td"); // Ten of diamonds
getCardCode("2c"); // Two of clubs

// ❌ Wrong format
getCardCode("as"); // Error: lowercase rank
getCardCode("AS"); // Error: uppercase suit
getCardCode("10h"); // Error: use "T" for 10
getCardCode("1s"); // Error: no "1" rank
```

---

## 📊 Combinatorics Verification

The evaluator has been verified against all possible hand combinations:

| Cards | Combinations | Verified |
| ----- | ------------ | -------- |
| 5     | 2,598,960    | ✅       |
| 6     | 20,358,520   | ✅       |
| 7     | 133,784,560  | ✅       |

All hand frequencies match mathematically proven distributions.

---

## 🙏 Credits

Algorithm based on the perfect hash technique pioneered by:

- Cactus Kev's Poker Hand Evaluator
- Two Plus Two evaluator
- Senzee's 5-card evaluator

Optimized for TypeScript with lookup table compression and static buffer reuse.

## 🔗 Related Packages

| Package                         | Description            |
| ------------------------------- | ---------------------- |
| [@pokertools/types](../types)   | Type definitions       |
| [@pokertools/engine](../engine) | Game state machine     |
| [@pokertools/bench](../bench)   | Performance benchmarks |

## 📄 License

MIT © A.Aurelius
