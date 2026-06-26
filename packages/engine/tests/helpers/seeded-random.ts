/**
 * Simple seeded random number generator for deterministic tests
 * Uses a Linear Congruential Generator (LCG) algorithm
 *
 * NOT suitable for production - only for testing!
 */
export function createSeededRandom(seed: number): () => number {
  let state = seed;

  return function (): number {
    // LCG using parameters from Numerical Recipes
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

/**
 * Create a seeded RNG that produces a specific scenario
 * For example, ensuring winner/loser in heads-up games
 */
export function createDeterministicRNG(seed = 12345): () => number {
  return createSeededRandom(seed);
}
