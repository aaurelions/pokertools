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
 * Cryptographically secure RNG using Node.js crypto module
 * Falls back to Math.random() only in browser/test environments
 *
 * @warning Math.random() is NOT cryptographically secure and should NEVER
 * be used for production poker games. Always provide a secure RNG.
 */
function getSecureRandom(): () => number {
  // Check if we're in Node.js environment
  if (typeof process !== "undefined" && process.versions?.node) {
    try {
      // Use Node.js crypto for production
      // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-unsafe-assignment
      const crypto = require("crypto");
      return () => {
        // Generate cryptographically secure random number [0, 1)
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
        const buffer = crypto.randomBytes(4);
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
        const value = buffer.readUInt32BE(0);
        return value / 0x100000000;
      };
    } catch (_error) {
      console.warn(
        "[SECURITY WARNING] crypto module not available. Falling back to Math.random(). " +
          "DO NOT use in production for real-money games!"
      );
    }
  }

  // Fallback for browser/test environments - emit warning
  if (process.env.NODE_ENV === "production") {
    console.error(
      "[CRITICAL SECURITY WARNING] Using Math.random() in production! " +
        "This is NOT cryptographically secure and games can be predicted. " +
        "Provide a secure RNG via the rng parameter."
    );
  }

  return Math.random;
}

/**
 * Shuffle deck using Fisher-Yates algorithm with injectable RNG
 *
 * @param deck - Deck to shuffle (not modified, returns new array)
 * @param rng - Random number generator function (0-1). MUST be cryptographically
 *              secure for production use (e.g., use crypto.randomBytes)
 * @returns New shuffled deck
 *
 * @security For production poker games, ALWAYS provide a cryptographically secure RNG.
 * The default RNG uses Node.js crypto module if available, otherwise falls back to
 * Math.random() which is NOT suitable for real-money games as it can be predicted.
 *
 * @example
 * ```typescript
 * // Production: Use crypto for secure shuffling
 * import { randomBytes } from 'crypto';
 * const secureRng = () => randomBytes(4).readUInt32BE(0) / 0x100000000;
 * const deck = shuffle(createDeck(), secureRng);
 *
 * // Development/Testing: Default is acceptable
 * const deck = shuffle(createDeck()); // Uses crypto if available
 * ```
 */
export function shuffle(deck: readonly number[], rng?: () => number): number[] {
  const random = rng ?? getSecureRandom();
  const shuffled = [...deck]; // Create mutable copy

  // Fisher-Yates shuffle
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    // Swap elements
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
