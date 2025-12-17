import { isValidCard, cardCodesToStrings, cardStringsToCards } from "../../src/utils/cardUtils";

describe("cardUtils", () => {
  describe("isValidCard", () => {
    test("accepts valid cards", () => {
      const validCards = [
        "2s",
        "3h",
        "4d",
        "5c",
        "6s",
        "7h",
        "8d",
        "9c",
        "Ts",
        "Jh",
        "Qd",
        "Kc",
        "As",
      ];

      validCards.forEach((card) => {
        expect(isValidCard(card)).toBe(true);
      });
    });

    test("rejects invalid rank", () => {
      expect(isValidCard("1s")).toBe(false);
      expect(isValidCard("0s")).toBe(false);
      expect(isValidCard("Xs")).toBe(false);
      expect(isValidCard("10s")).toBe(false); // Should be "Ts"
    });

    test("rejects invalid suit", () => {
      expect(isValidCard("Ax")).toBe(false);
      expect(isValidCard("Av")).toBe(false);
      expect(isValidCard("A")).toBe(false);
    });

    test("rejects wrong length", () => {
      expect(isValidCard("")).toBe(false);
      expect(isValidCard("A")).toBe(false);
      expect(isValidCard("Ash")).toBe(false);
      expect(isValidCard("10h")).toBe(false);
    });

    test("rejects lowercase ranks", () => {
      expect(isValidCard("as")).toBe(false);
      expect(isValidCard("ks")).toBe(false);
      expect(isValidCard("ts")).toBe(false);
    });

    test("rejects uppercase suits", () => {
      expect(isValidCard("AS")).toBe(false);
      expect(isValidCard("AH")).toBe(false);
      expect(isValidCard("AD")).toBe(false);
      expect(isValidCard("AC")).toBe(false);
    });

    test("case sensitivity matters", () => {
      // Only lowercase suits and uppercase ranks are valid
      expect(isValidCard("As")).toBe(true);
      expect(isValidCard("as")).toBe(false);
      expect(isValidCard("AS")).toBe(false);
      expect(isValidCard("aS")).toBe(false);
    });
  });

  describe("cardCodesToStrings", () => {
    test("converts card codes to strings", () => {
      // Ace of spades is code 0, King of spades is code 4, etc.
      const codes = [0, 4, 8, 12]; // As, Ks, Qs, Js
      const strings = cardCodesToStrings(codes);

      expect(strings).toHaveLength(4);
      expect(strings.every(isValidCard)).toBe(true);
    });

    test("handles empty array", () => {
      expect(cardCodesToStrings([])).toEqual([]);
    });

    test("round-trip conversion preserves cards", () => {
      const originalCards = ["As", "Kh", "Qd", "Jc", "Ts"];
      const codes = cardStringsToCards(originalCards);
      const convertedBack = cardCodesToStrings(codes);

      expect(convertedBack).toEqual(originalCards);
    });
  });

  describe("cardStringsToCards", () => {
    test("converts card strings to codes", () => {
      const cards = ["As", "Ks", "Qs", "Js"];
      const codes = cardStringsToCards(cards);

      expect(codes).toHaveLength(4);
      expect(codes.every((code) => typeof code === "number")).toBe(true);
    });

    test("handles empty array", () => {
      expect(cardStringsToCards([])).toEqual([]);
    });

    test("throws on invalid card string", () => {
      expect(() => cardStringsToCards(["invalid"])).toThrow();
      expect(() => cardStringsToCards(["10s"])).toThrow();
      expect(() => cardStringsToCards(["Ax"])).toThrow();
    });

    test("converts all ranks correctly", () => {
      const allRanks = [
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
      const codes = cardStringsToCards(allRanks);

      // Should get 13 unique codes
      expect(codes).toHaveLength(13);
      expect(new Set(codes).size).toBe(13);
    });

    test("converts all suits correctly", () => {
      const allSuits = ["As", "Ah", "Ad", "Ac"];
      const codes = cardStringsToCards(allSuits);

      // Should get 4 unique codes (one per suit)
      expect(codes).toHaveLength(4);
      expect(new Set(codes).size).toBe(4);
    });

    test("maintains card uniqueness", () => {
      // Each card in a deck should have a unique code
      const fullDeck: string[] = [];
      const ranks = ["2", "3", "4", "5", "6", "7", "8", "9", "T", "J", "Q", "K", "A"];
      const suits = ["s", "h", "d", "c"];

      for (const rank of ranks) {
        for (const suit of suits) {
          fullDeck.push(rank + suit);
        }
      }

      const codes = cardStringsToCards(fullDeck);
      expect(codes).toHaveLength(52);
      expect(new Set(codes).size).toBe(52); // All unique
    });
  });
});
