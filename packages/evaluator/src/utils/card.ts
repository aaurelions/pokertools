/**
 * Maps rank characters to their integer index (2=0 ... A=12)
 */
const RANK_MAP: Record<string, number> = {
  "2": 0,
  "3": 1,
  "4": 2,
  "5": 3,
  "6": 4,
  "7": 5,
  "8": 6,
  "9": 7,
  T: 8,
  J: 9,
  Q: 10,
  K: 11,
  A: 12,
};

/**
 * Maps suit characters to their integer index (s=0, h=1, d=2, c=3)
 */
const SUIT_MAP: Record<string, number> = {
  s: 0,
  h: 1,
  d: 2,
  c: 3,
};

const RANK_CHARS = ["2", "3", "4", "5", "6", "7", "8", "9", "T", "J", "Q", "K", "A"];
const SUIT_CHARS = ["s", "h", "d", "c"];

/**
 * Converts a card string (e.g. "Ah", "Td") into the integer format
 * expected by the evaluator.
 *
 * Format: (RankIndex << 2) | SuitIndex
 */
export function getCardCode(cardStr: string): number {
  if (cardStr.length !== 2) {
    throw new Error(`Invalid card string length: "${cardStr}"`);
  }

  const r = RANK_MAP[cardStr[0]];
  const s = SUIT_MAP[cardStr[1]];

  if (r === undefined || s === undefined) {
    throw new Error(`Invalid card characters: "${cardStr}"`);
  }

  return (r << 2) | s;
}

/**
 * Converts an array of card strings into an array of integers.
 */
export function getCardCodes(cards: string[]): number[] {
  const len = cards.length;
  const out = new Array<number>(len);
  for (let i = 0; i < len; i++) {
    out[i] = getCardCode(cards[i]);
  }
  return out;
}

/**
 * Parses a board string (e.g. "Ah Ks Qd") into integers.
 */
export function getBoardCodes(board: string): number[] {
  if (!board) return [];
  return getCardCodes(board.trim().split(/\s+/));
}

/**
 * Converts an integer code back to a string (e.g. 49 -> "Ah").
 */
export function stringifyCardCode(code: number): string {
  const rank = code >> 2;
  const suit = code & 0b11;
  const rankChar = RANK_CHARS[rank] || "?";
  const suitChar = SUIT_CHARS[suit] || "?";
  return rankChar + suitChar;
}
