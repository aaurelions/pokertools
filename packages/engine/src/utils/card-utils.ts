import { stringifyCardCode, getCardCode } from "@pokertools/evaluator";

/**
 * Convert integer card codes to string array
 */
export function cardCodesToStrings(codes: readonly number[]): string[] {
  return codes.map((code) => stringifyCardCode(code));
}

/**
 * Convert string card array to integer codes
 * Filters out null (masked) cards
 */
export function cardStringsToCards(cards: ReadonlyArray<string | null>): number[] {
  return cards.filter((c): c is string => c !== null).map((card) => getCardCode(card));
}

/**
 * Validate card string format
 */
export function isValidCard(card: string): boolean {
  if (card.length !== 2) return false;

  const rank = card[0];
  const suit = card[1];

  const validRanks = ["2", "3", "4", "5", "6", "7", "8", "9", "T", "J", "Q", "K", "A"];
  const validSuits = ["s", "h", "d", "c"];

  return validRanks.includes(rank) && validSuits.includes(suit);
}
