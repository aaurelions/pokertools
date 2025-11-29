import { SUITBIT_BY_ID, BINARIES_BY_ID } from "../tables/bit-masks";
import { SUITS_HASH } from "../tables/dp";
import { FLUSH_LOOKUP } from "../tables/flush";
import { NO_FLUSH_5 } from "../tables/no-flush-5";
import { NO_FLUSH_6 } from "../tables/no-flush-6";
import { NO_FLUSH_7 } from "../tables/no-flush-7";
import { hashQuinary } from "./hash";

/**
 * Static buffers to prevent garbage collection overhead during hot loop evaluations.
 *
 * @internal
 * @warning NOT THREAD-SAFE / NOT RE-ENTRANT
 *
 * These static arrays are reused across all evaluate() calls within the same
 * JavaScript context to eliminate GC pressure during Monte Carlo simulations.
 *
 * **Thread Safety Implications:**
 * - Safe for standard Node.js/Browser single-threaded execution
 * - Safe for async/await code (each await yields control)
 * - NOT safe if called recursively (don't call evaluate() from within evaluate())
 * - NOT safe with SharedArrayBuffer or true multi-threaded contexts
 * - NOT safe if multiple evaluate() calls are interleaved in the same tick
 *
 * **Performance Trade-off:**
 * Using static buffers provides ~12% speed improvement (17M vs 15M hands/sec)
 * by avoiding array allocations in the hot path. The non-reentrancy is acceptable
 * because poker hand evaluation is a synchronous, non-recursive operation.
 *
 * @example
 * // ✅ SAFE: Sequential evaluation
 * const score1 = evaluate(hand1);
 * const score2 = evaluate(hand2);
 *
 * @example
 * // ✅ SAFE: Async is OK (yields between calls)
 * for (const hand of hands) {
 *   const score = evaluate(hand);
 *   await saveToDatabase(score);
 * }
 *
 * @example
 * // ❌ UNSAFE: Recursive call
 * function badIdea(cards) {
 *   if (cards.length > 7) {
 *     return evaluate(cards.slice(0, 7)); // Corrupts static buffers!
 *   }
 *   return evaluate(cards);
 * }
 */
const suitBinary = [0, 0, 0, 0];
const quinary = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];

/**
 * Fast reset of static buffers.
 * Manual index assignment is faster than .fill(0).
 */
function resetBuffers(): void {
  suitBinary[0] = 0;
  suitBinary[1] = 0;
  suitBinary[2] = 0;
  suitBinary[3] = 0;

  quinary[0] = 0;
  quinary[1] = 0;
  quinary[2] = 0;
  quinary[3] = 0;
  quinary[4] = 0;
  quinary[5] = 0;
  quinary[6] = 0;
  quinary[7] = 0;
  quinary[8] = 0;
  quinary[9] = 0;
  quinary[10] = 0;
  quinary[11] = 0;
  quinary[12] = 0;
}

export function evaluate5Cards(cards: number[]): number {
  const c1 = cards[0],
    c2 = cards[1],
    c3 = cards[2],
    c4 = cards[3],
    c5 = cards[4];
  resetBuffers();

  // 1. Calculate Suit Hash
  const suitHash =
    SUITBIT_BY_ID[c1] +
    SUITBIT_BY_ID[c2] +
    SUITBIT_BY_ID[c3] +
    SUITBIT_BY_ID[c4] +
    SUITBIT_BY_ID[c5];

  // 2. Populate Rank Frequency (Quinary)
  quinary[c1 >> 2]++;
  quinary[c2 >> 2]++;
  quinary[c3 >> 2]++;
  quinary[c4 >> 2]++;
  quinary[c5 >> 2]++;

  // 3. Check for Flush using DP Table
  if (SUITS_HASH[suitHash]) {
    suitBinary[c1 & 0x3] |= BINARIES_BY_ID[c1];
    suitBinary[c2 & 0x3] |= BINARIES_BY_ID[c2];
    suitBinary[c3 & 0x3] |= BINARIES_BY_ID[c3];
    suitBinary[c4 & 0x3] |= BINARIES_BY_ID[c4];
    suitBinary[c5 & 0x3] |= BINARIES_BY_ID[c5];

    return FLUSH_LOOKUP[suitBinary[SUITS_HASH[suitHash] - 1]];
  }

  // 4. Check Hash Table
  const hash = hashQuinary(quinary, 13, 5);
  return NO_FLUSH_5[hash];
}

export function evaluate6Cards(cards: number[]): number {
  const c1 = cards[0],
    c2 = cards[1],
    c3 = cards[2],
    c4 = cards[3],
    c5 = cards[4],
    c6 = cards[5];
  resetBuffers();

  const suitHash =
    SUITBIT_BY_ID[c1] +
    SUITBIT_BY_ID[c2] +
    SUITBIT_BY_ID[c3] +
    SUITBIT_BY_ID[c4] +
    SUITBIT_BY_ID[c5] +
    SUITBIT_BY_ID[c6];

  quinary[c1 >> 2]++;
  quinary[c2 >> 2]++;
  quinary[c3 >> 2]++;
  quinary[c4 >> 2]++;
  quinary[c5 >> 2]++;
  quinary[c6 >> 2]++;

  if (SUITS_HASH[suitHash]) {
    suitBinary[c1 & 0x3] |= BINARIES_BY_ID[c1];
    suitBinary[c2 & 0x3] |= BINARIES_BY_ID[c2];
    suitBinary[c3 & 0x3] |= BINARIES_BY_ID[c3];
    suitBinary[c4 & 0x3] |= BINARIES_BY_ID[c4];
    suitBinary[c5 & 0x3] |= BINARIES_BY_ID[c5];
    suitBinary[c6 & 0x3] |= BINARIES_BY_ID[c6];

    return FLUSH_LOOKUP[suitBinary[SUITS_HASH[suitHash] - 1]];
  }

  const hash = hashQuinary(quinary, 13, 6);
  return NO_FLUSH_6[hash];
}

export function evaluate7Cards(cards: number[]): number {
  const c1 = cards[0],
    c2 = cards[1],
    c3 = cards[2],
    c4 = cards[3],
    c5 = cards[4],
    c6 = cards[5],
    c7 = cards[6];
  resetBuffers();

  const suitHash =
    SUITBIT_BY_ID[c1] +
    SUITBIT_BY_ID[c2] +
    SUITBIT_BY_ID[c3] +
    SUITBIT_BY_ID[c4] +
    SUITBIT_BY_ID[c5] +
    SUITBIT_BY_ID[c6] +
    SUITBIT_BY_ID[c7];

  quinary[c1 >> 2]++;
  quinary[c2 >> 2]++;
  quinary[c3 >> 2]++;
  quinary[c4 >> 2]++;
  quinary[c5 >> 2]++;
  quinary[c6 >> 2]++;
  quinary[c7 >> 2]++;

  if (SUITS_HASH[suitHash]) {
    suitBinary[c1 & 0x3] |= BINARIES_BY_ID[c1];
    suitBinary[c2 & 0x3] |= BINARIES_BY_ID[c2];
    suitBinary[c3 & 0x3] |= BINARIES_BY_ID[c3];
    suitBinary[c4 & 0x3] |= BINARIES_BY_ID[c4];
    suitBinary[c5 & 0x3] |= BINARIES_BY_ID[c5];
    suitBinary[c6 & 0x3] |= BINARIES_BY_ID[c6];
    suitBinary[c7 & 0x3] |= BINARIES_BY_ID[c7];

    return FLUSH_LOOKUP[suitBinary[SUITS_HASH[suitHash] - 1]];
  }

  const hash = hashQuinary(quinary, 13, 7);
  return NO_FLUSH_7[hash];
}
