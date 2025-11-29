/**
 * Standard Poker Hand Ranks.
 * Using const enum for inlining performance.
 */
export const enum HandRank {
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

export const HAND_RANK_DESCRIPTIONS: Readonly<Record<HandRank, string>> = {
  [HandRank.StraightFlush]: "Straight Flush",
  [HandRank.FourOfAKind]: "Four of a Kind",
  [HandRank.FullHouse]: "Full House",
  [HandRank.Flush]: "Flush",
  [HandRank.Straight]: "Straight",
  [HandRank.ThreeOfAKind]: "Three of a Kind",
  [HandRank.TwoPair]: "Two Pair",
  [HandRank.OnePair]: "One Pair",
  [HandRank.HighCard]: "High Card",
};

/**
 * Converts a raw evaluator score into a HandRank category.
 * Thresholds are based on the specific hash algorithm used.
 */
export function getHandRank(val: number): HandRank {
  if (val > 6185) return HandRank.HighCard; // 1277 high cards
  if (val > 3325) return HandRank.OnePair; // 2860 one pairs
  if (val > 2467) return HandRank.TwoPair; //  858 two pairs
  if (val > 1609) return HandRank.ThreeOfAKind; //  858 three-kinds
  if (val > 1599) return HandRank.Straight; //   10 straights
  if (val > 322) return HandRank.Flush; // 1277 flushes
  if (val > 166) return HandRank.FullHouse; //  156 full houses
  if (val > 10) return HandRank.FourOfAKind; //  156 four-kinds
  return HandRank.StraightFlush; //   10 straight-flushes
}
