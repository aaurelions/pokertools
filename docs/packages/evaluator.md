# @pokertools/evaluator

High-performance evaluation of 5-, 6-, and 7-card poker hands, implemented as a pure
integer pipeline over precomputed lookup tables. No dependencies, no allocations in the
hot path — just scores.

## Installation

::: code-group

```bash [npm]
npm install @pokertools/evaluator
```

```bash [pnpm]
pnpm add @pokertools/evaluator
```

:::

## Quick start

```ts
import {
  evaluate,
  evaluateStrings,
  getHandRank,
  getCardCode,
  getCardCodes,
  HandRank,
} from "@pokertools/evaluator";

// String API (convenient)
const score = evaluateStrings(["As", "Ks", "Qs", "Js", "Ts"]); // royal flush
console.log(HandRank[getHandRank(score)]); // "StraightFlush"

// Integer API (fast — for Monte Carlo loops)
const cards = ["As", "Ks", "Qs", "Js", "Ts"].map(getCardCode);

const board = ["Ts", "Jc", "Qd"]; // flop
const hero = ["Ah", "Kh"];
const villain = ["2c", "7d"];

const heroScore = evaluate([...getCardCodes(board), ...getCardCodes(hero)]);
const villainScore = evaluate([...getCardCodes(board), ...getCardCodes(villain)]);

if (heroScore < villainScore) {
  console.log("Hero wins 🃏");
}
```

## Card encoding

Scores are computed from card **codes**, not strings:

| Card string | Rank index | Suit index | Code (`rank << 2 \| suit`) |
| :---------- | :--------- | :--------- | :------------------------- |
| `2s`        | 0          | 0          | 0                          |
| `9h`        | 7          | 1          | 29                         |
| `Td`        | 8          | 2          | 34                         |
| `Ac`        | 12         | 3          | 51                         |

| Character | Meaning                                          |
| :-------- | :----------------------------------------------- |
| Ranks     | `2`…`9` are digits, then `T`, `J`, `Q`, `K`, `A` |
| Suits     | `s`=♠, `h`=♥, `d`=♦, `c`=♣                       |

```ts
import { getCardCode, stringifyCardCode } from "@pokertools/evaluator";

getCardCode("As"); // 50
stringifyCardCode(50); // "As"
```

## API reference

| Function                 | Signature                       | Notes                                  |
| :----------------------- | :------------------------------ | :------------------------------------- |
| `evaluate`               | `(codes: number[]) => number`   | 5, 6 or 7 card codes; lower score wins |
| `evaluate5Cards`         | `(codes: number[]) => number`   | Specialized 5-card path                |
| `evaluate6Cards`         | `(codes: number[]) => number`   | Specialized 6-card path                |
| `evaluate7Cards`         | `(codes: number[]) => number`   | Specialized 7-card path                |
| `evaluateStrings`        | `(cards: string[]) => number`   | Parses `"As"`-style strings first      |
| `getCardCode`            | `(card: string) => number`      | String → integer code                  |
| `getCardCodes`           | `(cards: string[]) => number[]` | Batch string → codes                   |
| `getBoardCodes`          | `(board: string) => number[]`   | Whitespace-separated board → codes     |
| `stringifyCardCode`      | `(code: number) => string`      | Integer code → string                  |
| `getHandRank`            | `(score: number) => HandRank`   | Score → category                       |
| `HAND_RANK_DESCRIPTIONS` | `Record<HandRank, string>`      | Human-readable ranks                   |

## Hand rank table

`getHandRank` maps scores into categories using precomputed thresholds:

| HandRank        | Example        | Number of distinct 7-card hands |
| :-------------- | :------------- | :------------------------------ |
| `StraightFlush` | A♠ K♠ Q♠ J♠ T♠ | 40                              |
| `FourOfAKind`   | 9♣ 9♥ 9♦ 9♠    | 624                             |
| `FullHouse`     | K♣ K♥ K♦ 4♠ 4♥ | 3 744                           |
| `Flush`         | A♥ J♥ 7♥ 4♥ 2♥ | 5 108                           |
| `Straight`      | 6♣ 5♥ 4♠ 3♥ 2♦ | 10 200                          |
| `ThreeOfAKind`  | Q♣ Q♥ Q♦       | 54 912                          |
| `TwoPair`       | 8♣ 8♥ 4♠ 4♦    | 123 552                         |
| `OnePair`       | A♣ A♥          | 1 098 240                       |
| `HighCard`      | A♣ K♥ 9♦ 5♠ 2♣ | 1 302 540                       |

## Performance

| API                   | Handles/sec (single core, Node.js) |
| :-------------------- | :--------------------------------- |
| `evaluate` (7 cards)  | ~17M                               |
| `evaluateStrings`     | lower (string parsing)             |
| External JS libraries | typically 0.1–2M                   |

The speed comes from rank-frequency (quinary) hashing with precomputed lookup tables and
reused scratch buffers. The scratch buffers **must not** be re-entered through custom
array getters/proxies; normal sequential calls and separate worker isolates never share an
active evaluation.

::: tip
For equity calculations, score both hands (or a whole range) with `evaluate` in a tight
loop — one `evaluate` call is a handful of nanoseconds after warm-up.
:::

## Monte Carlo equity example

The integer API shines in equity simulators — pre-deal decks, board textures, full ranges:

```ts
import { evaluate, getCardCode } from "@pokertools/evaluator";

function equity(hero: string[], villain: string[], board: string[], iterations = 100_000) {
  const deck = new Set<number>();
  for (let r = 0; r < 13; r++) for (let s = 0; s < 4; s++) deck.add((r << 2) | s);
  for (const c of [...hero, ...villain, ...board]) deck.delete(getCardCode(c));

  const cards = [...deck];
  const heroCodes = board.map(getCardCode).concat(hero.map(getCardCode));
  const villainCodes = board.map(getCardCode).concat(villain.map(getCardCode));

  let wins = 0;
  for (let i = 0; i < iterations; i++) {
    // Fisher–Yates partial shuffle (first 3 cards) without extra allocations
    for (let j = cards.length - 1; j > cards.length - 4; j--) {
      const k = (Math.random() * (j + 1)) | 0;
      [cards[j], cards[k]] = [cards[k]!, cards[j]!];
    }
    if (
      evaluate([
        ...heroCodes,
        cards[cards.length - 1]!,
        cards[cards.length - 2]!,
        cards[cards.length - 3]!,
      ]) <
      evaluate([
        ...villainCodes,
        cards[cards.length - 1]!,
        cards[cards.length - 2]!,
        cards[cards.length - 3]!,
      ])
    ) {
      wins++;
    }
  }
  return wins / iterations;
}

console.log(equity(["As", "Ah"], ["Ks", "Kh"], ["Ts", "Jc", "Qd"])); // ≈ 0.82+
```

## Validation

```ts
import { evaluate } from "@pokertools/evaluator";

evaluate([0, 1, 2, 3]); // ❌ throws — requires 5, 6 or 7 cards
evaluate([getCardCode("As"), 50]); // ❌ duplicate cards are undefined behaviour
```

The fast integer API assumes **valid, distinct** card codes. It is a scoring engine, not a
hand-validator — use the engine package when you need full rule enforcement.
