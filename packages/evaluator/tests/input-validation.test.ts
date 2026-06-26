import {
  evaluate,
  evaluateStrings,
  evaluateBoard,
  rank,
  getCardCode,
  getCardCodes,
  stringifyCardCode,
} from "../src/index";
import { getBoardCodes } from "../src/utils/card";

describe("Evaluator Input Validation", () => {
  describe("evaluate() with invalid array lengths", () => {
    test("rejects 0 cards", () => {
      expect(() => evaluate([])).toThrow("Evaluator requires 5, 6, or 7 cards. Received 0.");
    });

    test("rejects 1 card", () => {
      expect(() => evaluate([0])).toThrow("Evaluator requires 5, 6, or 7 cards. Received 1.");
    });

    test("rejects 2 cards", () => {
      expect(() => evaluate([0, 4])).toThrow("Evaluator requires 5, 6, or 7 cards. Received 2.");
    });

    test("rejects 3 cards", () => {
      expect(() => evaluate([0, 4, 8])).toThrow("Evaluator requires 5, 6, or 7 cards. Received 3.");
    });

    test("rejects 4 cards", () => {
      expect(() => evaluate([0, 4, 8, 12])).toThrow(
        "Evaluator requires 5, 6, or 7 cards. Received 4."
      );
    });

    test("rejects 8 cards", () => {
      expect(() => evaluate([0, 4, 8, 12, 16, 20, 24, 28])).toThrow(
        "Evaluator requires 5, 6, or 7 cards. Received 8."
      );
    });

    test("rejects 10 cards", () => {
      const tenCards = Array(10)
        .fill(0)
        .map((_, i) => i * 4);
      expect(() => evaluate(tenCards)).toThrow("Evaluator requires 5, 6, or 7 cards. Received 10.");
    });

    test("rejects 52 cards (full deck)", () => {
      const fullDeck = Array(52)
        .fill(0)
        .map((_, i) => i);
      expect(() => evaluate(fullDeck)).toThrow("Evaluator requires 5, 6, or 7 cards. Received 52.");
    });
  });

  describe("evaluate() with valid array lengths", () => {
    test("accepts 5 cards", () => {
      const fiveCards = [0, 4, 8, 12, 16]; // As, Ks, Qs, Js, Ts (royal flush spades)
      expect(() => evaluate(fiveCards)).not.toThrow();
      const result = evaluate(fiveCards);
      expect(typeof result).toBe("number");
    });

    test("accepts 6 cards", () => {
      const sixCards = [0, 4, 8, 12, 16, 20]; // As, Ks, Qs, Js, Ts, 9s
      expect(() => evaluate(sixCards)).not.toThrow();
      const result = evaluate(sixCards);
      expect(typeof result).toBe("number");
    });

    test("accepts 7 cards", () => {
      const sevenCards = [0, 4, 8, 12, 16, 20, 24]; // As, Ks, Qs, Js, Ts, 9s, 8s
      expect(() => evaluate(sevenCards)).not.toThrow();
      const result = evaluate(sevenCards);
      expect(typeof result).toBe("number");
    });
  });

  describe("getCardCode() with invalid strings", () => {
    test("rejects invalid rank", () => {
      expect(() => getCardCode("1s")).toThrow();
      expect(() => getCardCode("0s")).toThrow();
      expect(() => getCardCode("Xs")).toThrow();
      expect(() => getCardCode("10s")).toThrow(); // Should be "Ts"
    });

    test("rejects invalid suit", () => {
      expect(() => getCardCode("Ax")).toThrow();
      expect(() => getCardCode("Av")).toThrow();
      expect(() => getCardCode("Ab")).toThrow();
    });

    test("rejects wrong length strings", () => {
      expect(() => getCardCode("")).toThrow();
      expect(() => getCardCode("A")).toThrow();
      expect(() => getCardCode("Ash")).toThrow();
      expect(() => getCardCode("10h")).toThrow();
    });

    test("rejects lowercase rank", () => {
      expect(() => getCardCode("as")).toThrow();
      expect(() => getCardCode("ks")).toThrow();
      expect(() => getCardCode("ts")).toThrow();
    });

    test("rejects uppercase suit", () => {
      expect(() => getCardCode("AS")).toThrow();
      expect(() => getCardCode("AH")).toThrow();
      expect(() => getCardCode("AD")).toThrow();
      expect(() => getCardCode("AC")).toThrow();
    });
  });

  describe("getCardCode() with valid strings", () => {
    test("accepts all valid ranks", () => {
      const validRanks = [
        "2s",
        "3s",
        "4s",
        "5s",
        "6s",
        "7s",
        "8s",
        "9s",
        "Ts",
        "Js",
        "Qs",
        "Ks",
        "As",
      ];
      validRanks.forEach((card) => {
        expect(() => getCardCode(card)).not.toThrow();
        expect(typeof getCardCode(card)).toBe("number");
      });
    });

    test("accepts all valid suits", () => {
      const validSuits = ["As", "Ah", "Ad", "Ac"];
      validSuits.forEach((card) => {
        expect(() => getCardCode(card)).not.toThrow();
        expect(typeof getCardCode(card)).toBe("number");
      });
    });

    test("returns unique codes for different cards", () => {
      const as = getCardCode("As");
      const ah = getCardCode("Ah");
      const ks = getCardCode("Ks");

      expect(as).not.toBe(ah);
      expect(as).not.toBe(ks);
      expect(ah).not.toBe(ks);
    });
  });

  describe("getCardCodes() array function", () => {
    test("converts multiple cards correctly", () => {
      const cards = ["As", "Kh", "Qd", "Jc", "Ts"];
      const codes = getCardCodes(cards);

      expect(codes).toHaveLength(5);
      expect(codes.every((code) => typeof code === "number")).toBe(true);
    });

    test("handles empty array", () => {
      const codes = getCardCodes([]);
      expect(codes).toEqual([]);
    });

    test("throws on invalid card in array", () => {
      const invalidCards = ["As", "Kh", "invalid", "Jc"];
      expect(() => getCardCodes(invalidCards)).toThrow();
    });

    test("maintains card order", () => {
      const cards = ["2s", "3s", "4s"];
      const codes = getCardCodes(cards);

      const twoS = getCardCode("2s");
      const threeS = getCardCode("3s");
      const fourS = getCardCode("4s");

      expect(codes[0]).toBe(twoS);
      expect(codes[1]).toBe(threeS);
      expect(codes[2]).toBe(fourS);
    });
  });

  describe("evaluateStrings()", () => {
    test("evaluates valid 5-card array", () => {
      const cards = ["As", "Ks", "Qs", "Js", "Ts"];
      expect(() => evaluateStrings(cards)).not.toThrow();
      const result = evaluateStrings(cards);
      expect(typeof result).toBe("number");
    });

    test("evaluates valid 7-card array", () => {
      const cards = ["As", "Ah", "Kd", "Kc", "Qh", "Jd", "Ts"];
      expect(() => evaluateStrings(cards)).not.toThrow();
    });

    test("throws on invalid array length", () => {
      expect(() => evaluateStrings(["As", "Kh"])).toThrow("Evaluator requires 5, 6, or 7 cards");
    });

    test("throws on invalid card string", () => {
      expect(() => evaluateStrings(["As", "Kh", "Qd", "invalid", "Ts"])).toThrow();
    });
  });

  describe("evaluateBoard()", () => {
    test("evaluates space-separated board string with 5 cards", () => {
      const board = "As Ks Qs Js Ts";
      expect(() => evaluateBoard(board)).not.toThrow();
      const result = evaluateBoard(board);
      expect(typeof result).toBe("number");
    });

    test("evaluates 7-card board string", () => {
      const board = "As Ah Kd Kc Qh Jd Ts";
      expect(() => evaluateBoard(board)).not.toThrow();
    });

    test("throws on invalid board length", () => {
      expect(() => evaluateBoard("As Kh")).toThrow();
    });

    test("throws on invalid card in board", () => {
      expect(() => evaluateBoard("As Kh Qd invalid Ts")).toThrow();
    });

    test("handles extra whitespace", () => {
      const board = "As  Ks   Qs Js Ts"; // Extra spaces
      expect(() => evaluateBoard(board)).not.toThrow();
    });

    test("handles empty board string", () => {
      const board = "";
      // Empty board can't be evaluated (needs 5-7 cards)
      expect(() => evaluateBoard(board)).toThrow("Evaluator requires 5, 6, or 7 cards");
    });

    test("handles whitespace-only board string", () => {
      const board = "   ";
      // Whitespace-only board gets split into array with empty strings
      // which fail card validation before reaching the evaluator
      expect(() => evaluateBoard(board)).toThrow("Invalid card string length");
    });
  });

  describe("getBoardCodes() direct tests", () => {
    test("returns empty array for empty string", () => {
      const result = getBoardCodes("");
      expect(result).toEqual([]);
    });

    test("returns empty array for null/undefined", () => {
      const resultNull = getBoardCodes(null as any);
      expect(resultNull).toEqual([]);

      const resultUndefined = getBoardCodes(undefined as any);
      expect(resultUndefined).toEqual([]);
    });

    test("parses board with single space separator", () => {
      const result = getBoardCodes("As Kh Qd");
      expect(result).toHaveLength(3);
      expect(result[0]).toBe(getCardCode("As"));
      expect(result[1]).toBe(getCardCode("Kh"));
      expect(result[2]).toBe(getCardCode("Qd"));
    });

    test("parses board with multiple space separators", () => {
      const result = getBoardCodes("As  Kh   Qd");
      expect(result).toHaveLength(3);
    });

    test("handles leading and trailing whitespace", () => {
      const result = getBoardCodes("  As Kh Qd  ");
      expect(result).toHaveLength(3);
    });
  });

  describe("rank() with valid inputs", () => {
    test("returns numeric hand rank for 5 cards", () => {
      const royalFlush = getCardCodes(["As", "Ks", "Qs", "Js", "Ts"]);
      const rankValue = rank(royalFlush);

      expect(typeof rankValue).toBe("number");
      expect(rankValue).toBeGreaterThanOrEqual(0);
      expect(rankValue).toBeLessThanOrEqual(8);
    });

    test("returns numeric hand rank for 7 cards", () => {
      const sevenCards = getCardCodes(["As", "Ah", "Ad", "Ac", "Kh", "Qd", "Jc"]);
      const rankValue = rank(sevenCards);

      expect(typeof rankValue).toBe("number");
      expect(rankValue).toBeGreaterThanOrEqual(0);
      expect(rankValue).toBeLessThanOrEqual(8);
    });

    test("throws on invalid input length", () => {
      const threeCards = getCardCodes(["As", "Kh", "Qd"]);
      expect(() => rank(threeCards)).toThrow("Evaluator requires 5, 6, or 7 cards");
    });
  });

  describe("Hand evaluation correctness samples", () => {
    test("royal flush has best score (lowest number)", () => {
      const royalFlush = getCardCodes(["As", "Ks", "Qs", "Js", "Ts"]);
      const highCard = getCardCodes(["7h", "5d", "4c", "3s", "2h"]);

      const royalScore = evaluate(royalFlush);
      const highCardScore = evaluate(highCard);

      // Lower score = better hand
      expect(royalScore).toBeLessThan(highCardScore);
    });

    test("four of a kind beats full house", () => {
      const fourOfAKind = getCardCodes(["As", "Ah", "Ad", "Ac", "Kh"]);
      const fullHouse = getCardCodes(["Ks", "Kh", "Kd", "Qs", "Qh"]);

      const quadsScore = evaluate(fourOfAKind);
      const fullHouseScore = evaluate(fullHouse);

      expect(quadsScore).toBeLessThan(fullHouseScore);
    });

    test("straight flush beats four of a kind", () => {
      const straightFlush = getCardCodes(["9s", "8s", "7s", "6s", "5s"]);
      const fourOfAKind = getCardCodes(["As", "Ah", "Ad", "Ac", "Kh"]);

      const straightFlushScore = evaluate(straightFlush);
      const quadsScore = evaluate(fourOfAKind);

      expect(straightFlushScore).toBeLessThan(quadsScore);
    });
  });

  describe("Edge cases and boundary conditions", () => {
    test("handles lowest possible straight (wheel)", () => {
      const wheel = getCardCodes(["5h", "4d", "3c", "2s", "Ah"]);
      expect(() => evaluate(wheel)).not.toThrow();
      const result = evaluate(wheel);
      expect(typeof result).toBe("number");
    });

    test("handles all same suit flush", () => {
      const flush = getCardCodes(["As", "Ks", "9s", "6s", "3s"]);
      expect(() => evaluate(flush)).not.toThrow();
    });

    test("handles mixed case evaluation", () => {
      // All lowercase ranks should fail
      expect(() => getCardCode("as")).toThrow();

      // All uppercase suits should fail
      expect(() => getCardCode("AS")).toThrow();
    });

    test("evaluates with duplicate cards consistently", () => {
      // Note: Evaluator doesn't validate duplicate cards - that's the engine's job
      // It will evaluate them, but the result may be undefined behavior
      const duplicates = [0, 0, 0, 0, 0]; // Five identical cards
      expect(() => evaluate(duplicates)).not.toThrow();
    });
  });

  describe("stringifyCardCode edge cases", () => {
    test("handles invalid card codes with out-of-range rank", () => {
      // Card code with rank index 13 (out of range, max is 12 for Ace)
      const invalidRankCode = (13 << 2) | 0; // 52
      const result = stringifyCardCode(invalidRankCode);

      // Should return "?" for invalid rank
      expect(result).toBe("?s");
    });

    test("handles various out-of-range rank codes", () => {
      // Test multiple invalid ranks to ensure branch coverage
      expect(stringifyCardCode(14 << 2)).toBe("?s"); // rank 14
      expect(stringifyCardCode(15 << 2)).toBe("?s"); // rank 15
      expect(stringifyCardCode(100 << 2)).toBe("?s"); // rank 100
    });

    test("handles negative card codes gracefully", () => {
      // Negative codes are technically possible with bit shifts
      const negativeCode = -1;
      const result = stringifyCardCode(negativeCode);

      // Should use fallback "?" for invalid indices
      // -1 >> 2 = -1, and RANK_CHARS[-1] is undefined, so "?"
      expect(result).toContain("?");
    });

    test("handles very large card codes", () => {
      // Very large code that would produce out-of-range indices
      const largeCode = 999;
      const result = stringifyCardCode(largeCode);

      // Should use fallback "?" for invalid rank
      expect(result).toBe("?c"); // suit is 999 & 0b11 = 3 (clubs)
    });

    test("verifies all valid card codes stringify correctly", () => {
      // Test all 52 valid cards to ensure complete coverage
      const ranks = ["2", "3", "4", "5", "6", "7", "8", "9", "T", "J", "Q", "K", "A"];
      const suits = ["s", "h", "d", "c"];

      for (let rankIdx = 0; rankIdx < 13; rankIdx++) {
        for (let suitIdx = 0; suitIdx < 4; suitIdx++) {
          const code = (rankIdx << 2) | suitIdx;
          const expected = ranks[rankIdx] + suits[suitIdx];
          const result = stringifyCardCode(code);
          expect(result).toBe(expected);
        }
      }
    });

    test("tests boundary card codes", () => {
      // Test min and max valid codes
      expect(stringifyCardCode(0)).toBe("2s"); // Min: rank 0, suit 0
      expect(stringifyCardCode(51)).toBe("Ac"); // Max: rank 12, suit 3
    });

    test("tests codes that produce undefined suit (impossible but ensures branch)", () => {
      // While suit & 0b11 can only be 0-3, we test the logical flow
      // by ensuring the fallback works for rank
      const codeWithInvalidRank = -4; // This will produce negative rank index
      const result = stringifyCardCode(codeWithInvalidRank);
      expect(result).toMatch(/\?/); // Should contain ? for invalid rank
    });

    test("achieves full branch coverage with edge cases", () => {
      // Test the OR operators by ensuring both paths are hit
      // Path 1: Valid rank and suit (already tested above)
      expect(stringifyCardCode(0)).toBe("2s");

      // Path 2: Invalid rank, valid suit (hits rank || "?")
      expect(stringifyCardCode(999 << 2)).toMatch(/\?[shdc]/);

      // Path 3: All combinations to ensure branches are covered
      // Testing with negative indices
      expect(stringifyCardCode(-5)).toMatch(/\?/);
      expect(stringifyCardCode(-100)).toMatch(/\?/);

      // The suit fallback (|| "?") is unreachable because (x & 0b11) ∈ {0,1,2,3}
      // This is a defensive programming practice but mathematically proven unreachable
      // We document this for coverage tools:
      // Istanbul/V8 may not mark this as fully covered due to unreachable branch
    });
  });
});
