import { getCardCode } from "@pokertools/evaluator";

/**
 * Build a random provider that makes the engine's Fisher-Yates shuffle produce
 * a deck starting with `topCards` (remaining cards follow in ascending code
 * order). Calls beyond the shuffle return 0.
 *
 * NOT suitable for production - only for testing!
 */
export function createRiggedRandom(topCards: readonly string[]): () => number {
  const codes = topCards.map((card) => getCardCode(card));
  const target = [
    ...codes,
    ...Array.from({ length: 52 }, (_, code) => code).filter((code) => !codes.includes(code)),
  ];
  const deck = Array.from({ length: 52 }, (_, code) => code);
  const draws: number[] = [];

  for (let i = 51; i > 0; i--) {
    const j = deck.indexOf(target[i]);
    draws.push((j + 0.5) / (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }

  let next = 0;
  return () => draws[next++] ?? 0;
}
