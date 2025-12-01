import { evaluate5Cards, evaluate6Cards, evaluate7Cards } from "../src/core/evaluator";
import { getHandRank, HandRank } from "../src/models/hand-rank";

const runHeavy = process.env.ENABLE_HEAVY_TESTS ? test : test.skip;

/**
 * These tests loop through millions of hands.
 * 5-card is fast (~200ms).
 * 6-card is medium (~2s).
 * 7-card is slow (~12s) and is skipped by default unless ENABLE_HEAVY_TESTS=true.
 */
describe("Frequency Analysis (Combinatorics)", () => {
  const resetFreq = () => [0, 0, 0, 0, 0, 0, 0, 0, 0];

  test("5 Cards: 2,598,960 combinations", () => {
    const freq = resetFreq();

    // 52C5 iteration loops
    // Optimized loop structure for 5 cards
    for (let a = 0; a < 48; a++) {
      for (let b = a + 1; b < 49; b++) {
        for (let c = b + 1; c < 50; c++) {
          for (let d = c + 1; d < 51; d++) {
            for (let e = d + 1; e < 52; e++) {
              const val = evaluate5Cards([a, b, c, d, e]);
              freq[getHandRank(val)]++;
            }
          }
        }
      }
    }

    expect(freq[HandRank.StraightFlush]).toBe(40);
    expect(freq[HandRank.FourOfAKind]).toBe(624);
    expect(freq[HandRank.FullHouse]).toBe(3744);
    expect(freq[HandRank.Flush]).toBe(5108);
    expect(freq[HandRank.Straight]).toBe(10200);
    expect(freq[HandRank.ThreeOfAKind]).toBe(54912);
    expect(freq[HandRank.TwoPair]).toBe(123552);
    expect(freq[HandRank.OnePair]).toBe(1098240);
    expect(freq[HandRank.HighCard]).toBe(1302540);
  });

  test("6 Cards: 20,358,520 combinations", () => {
    const freq = resetFreq();

    // 52C6
    for (let a = 0; a < 47; a++) {
      for (let b = a + 1; b < 48; b++) {
        for (let c = b + 1; c < 49; c++) {
          for (let d = c + 1; d < 50; d++) {
            for (let e = d + 1; e < 51; e++) {
              for (let f = e + 1; f < 52; f++) {
                const val = evaluate6Cards([a, b, c, d, e, f]);
                freq[getHandRank(val)]++;
              }
            }
          }
        }
      }
    }

    expect(freq[HandRank.StraightFlush]).toBe(1844);
    expect(freq[HandRank.FourOfAKind]).toBe(14664);
    expect(freq[HandRank.FullHouse]).toBe(165984);
    expect(freq[HandRank.Flush]).toBe(205792);
    expect(freq[HandRank.Straight]).toBe(361620);
    expect(freq[HandRank.ThreeOfAKind]).toBe(732160);
    expect(freq[HandRank.TwoPair]).toBe(2532816);
    expect(freq[HandRank.OnePair]).toBe(9730740);
    expect(freq[HandRank.HighCard]).toBe(6612900);
  });

  // Mark as skipped to keep CI/Dev fast. Run manually when changing core logic.
  runHeavy("7 Cards: 133,784,560 combinations (Takes ~15s)", () => {
    const freq = resetFreq();

    // 52C7
    for (let a = 0; a < 46; a++) {
      for (let b = a + 1; b < 47; b++) {
        for (let c = b + 1; c < 48; c++) {
          for (let d = c + 1; d < 49; d++) {
            for (let e = d + 1; e < 50; e++) {
              for (let f = e + 1; f < 51; f++) {
                for (let g = f + 1; g < 52; g++) {
                  const val = evaluate7Cards([a, b, c, d, e, f, g]);
                  freq[getHandRank(val)]++;
                }
              }
            }
          }
        }
      }
    }

    expect(freq[HandRank.StraightFlush]).toBe(41584);
    expect(freq[HandRank.FourOfAKind]).toBe(224848);
    expect(freq[HandRank.FullHouse]).toBe(3473184);
    expect(freq[HandRank.Flush]).toBe(4047644);
    expect(freq[HandRank.Straight]).toBe(6180020);
    expect(freq[HandRank.ThreeOfAKind]).toBe(6461620);
    expect(freq[HandRank.TwoPair]).toBe(31433400);
    expect(freq[HandRank.OnePair]).toBe(58627800);
    expect(freq[HandRank.HighCard]).toBe(23294460);
  });
});
