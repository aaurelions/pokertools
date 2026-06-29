/**
 * Create a standard 52-card deck
 * Returns array of integer card codes (0-51)
 */
export function createDeck(): number[] {
  const deck: number[] = [];

  // For each rank (0-12: 2 through A)
  for (let rank = 0; rank < 13; rank++) {
    // For each suit (0-3: spades, hearts, diamonds, clubs)
    for (let suit = 0; suit < 4; suit++) {
      // Card code = (rank << 2) | suit
      deck.push((rank << 2) | suit);
    }
  }

  return deck;
}

/**
 * Cryptographically secure RNG using Node.js crypto module.
 *
 * **Fail-closed design:** Throws an error if no secure RNG source is available.
 * This function NEVER falls back to Math.random().
 *
 * In Node.js, uses `crypto.randomBytes`. Outside Node.js (or if crypto is
 * unavailable), throws an error instructing the caller to provide a
 * `randomProvider` in the table config.
 */
export function getSecureRandom(): () => number {
  if (typeof process !== "undefined" && process.versions?.node) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const crypto = require("crypto") as typeof import("crypto");

    return () => {
      const buffer = crypto.randomBytes(4);
      return buffer.readUInt32BE(0) / 0x100000000;
    };
  }

  throw new Error(
    "[PokerEngine] No secure random number generator available. " +
      "Provide a randomProvider () => number in the table config. " +
      "For testing, provide a deterministic randomProvider (e.g. createSeededRandom(seed))."
  );
}

/**
 * Shuffle deck using Fisher-Yates algorithm with injectable RNG.
 *
 * **Fail-closed design:** When no `rng` is supplied, uses `getSecureRandom()`
 * which throws if no cryptographically secure source is available. It NEVER
 * falls back to `Math.random()`.
 *
 * @param deck - Deck to shuffle (not modified, returns new array)
 * @param rng  - Optional RNG function returning values in [0, 1).
 *               For deterministic tests, pass a seeded RNG.
 *               When omitted, `getSecureRandom()` is used (Node crypto).
 * @returns New shuffled deck
 *
 * @example
 * ```typescript
 * // Production (Node): uses crypto.randomBytes via getSecureRandom()
 * const deck = shuffle(createDeck());
 *
 * // Production (Node): explicit secure RNG
 * import { randomBytes } from 'crypto';
 * const rng = () => randomBytes(4).readUInt32BE(0) / 0x100000000;
 * const deck = shuffle(createDeck(), rng);
 *
 * // Deterministic testing
 * const seeded = createSeededRandom(12345);
 * const deck = shuffle(createDeck(), seeded);
 * ```
 */
export function shuffle(deck: readonly number[], rng?: () => number): number[] {
  const random = rng ?? getSecureRandom();
  const shuffled = [...deck];

  // Fisher-Yates shuffle
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    const temp = shuffled[i];
    shuffled[i] = shuffled[j];
    shuffled[j] = temp;
  }

  return shuffled;
}

/**
 * Deal cards from deck
 *
 * @param deck - Deck to deal from
 * @param count - Number of cards to deal
 * @returns Tuple of [dealt cards, remaining deck]
 */
export function dealCards(
  deck: readonly number[],
  count: number
): [cards: number[], remaining: number[]] {
  if (count > deck.length) {
    throw new Error(`Cannot deal ${count} cards from deck of ${deck.length}`);
  }

  const cards = deck.slice(0, count);
  const remaining = deck.slice(count);

  return [Array.from(cards), Array.from(remaining)];
}

/**
 * Burn one card and deal specified number
 * (Standard poker procedure)
 *
 * @param deck - Deck to deal from
 * @param count - Number of cards to deal after burn
 * @returns Tuple of [dealt cards, remaining deck]
 */
export function burnAndDeal(
  deck: readonly number[],
  count: number
): [cards: number[], remaining: number[]] {
  if (count + 1 > deck.length) {
    throw new Error(`Cannot burn and deal ${count} cards from deck of ${deck.length}`);
  }

  // Skip first card (burn), deal next 'count' cards
  const cards = deck.slice(1, count + 1);
  const remaining = deck.slice(count + 1);

  return [Array.from(cards), Array.from(remaining)];
}
