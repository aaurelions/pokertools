import { createDeck, shuffle, dealCards, burnAndDeal } from "../../src/utils/deck";

describe("Deck Utilities", () => {
  describe("createDeck", () => {
    test("creates 52 unique cards", () => {
      const deck = createDeck();
      expect(deck.length).toBe(52);

      // All cards should be unique
      const uniqueCards = new Set(deck);
      expect(uniqueCards.size).toBe(52);
    });

    test("contains all card codes from 0 to 51", () => {
      const deck = createDeck();
      const sorted = [...deck].sort((a, b) => a - b);

      for (let i = 0; i < 52; i++) {
        expect(sorted[i]).toBe(i);
      }
    });
  });

  describe("shuffle", () => {
    test("returns array of same length", () => {
      const deck = createDeck();
      const shuffled = shuffle(deck);
      expect(shuffled.length).toBe(52);
    });

    test("contains same cards (different order)", () => {
      const deck = createDeck();
      const shuffled = shuffle(deck);

      const sortedOriginal = [...deck].sort((a, b) => a - b);
      const sortedShuffled = [...shuffled].sort((a, b) => a - b);

      expect(sortedShuffled).toEqual(sortedOriginal);
    });

    test("is deterministic with seeded RNG", () => {
      const deck = createDeck();

      // Simple seeded RNG
      const createSeededRng = (seed: number) => {
        let state = seed;
        return () => {
          state = (state * 9301 + 49297) % 233280;
          return state / 233280;
        };
      };

      const rng1 = createSeededRng(12345);
      const rng2 = createSeededRng(12345);

      const shuffled1 = shuffle(deck, rng1);
      const shuffled2 = shuffle(deck, rng2);

      expect(shuffled1).toEqual(shuffled2);
    });

    test("produces different shuffles with different seeds", () => {
      const deck = createDeck();

      const createSeededRng = (seed: number) => {
        let state = seed;
        return () => {
          state = (state * 9301 + 49297) % 233280;
          return state / 233280;
        };
      };

      const rng1 = createSeededRng(12345);
      const rng2 = createSeededRng(67890);

      const shuffled1 = shuffle(deck, rng1);
      const shuffled2 = shuffle(deck, rng2);

      expect(shuffled1).not.toEqual(shuffled2);
    });

    test("does not modify original deck", () => {
      const deck = createDeck();
      const originalCopy = [...deck];

      shuffle(deck);

      expect(deck).toEqual(originalCopy);
    });
  });

  describe("dealCards", () => {
    test("deals correct number of cards", () => {
      const deck = createDeck();
      const [cards, remaining] = dealCards(deck, 5);

      expect(cards.length).toBe(5);
      expect(remaining.length).toBe(47);
    });

    test("deals cards from top of deck", () => {
      const deck = [0, 1, 2, 3, 4, 5];
      const [cards, remaining] = dealCards(deck, 3);

      expect(cards).toEqual([0, 1, 2]);
      expect(remaining).toEqual([3, 4, 5]);
    });

    test("throws error if not enough cards", () => {
      const deck = createDeck();

      expect(() => dealCards(deck, 53)).toThrow();
    });

    test("can deal all cards", () => {
      const deck = createDeck();
      const [cards, remaining] = dealCards(deck, 52);

      expect(cards.length).toBe(52);
      expect(remaining.length).toBe(0);
    });
  });

  describe("burnAndDeal", () => {
    test("burns one card and deals specified amount", () => {
      const deck = [0, 1, 2, 3, 4, 5];
      const [cards, remaining] = burnAndDeal(deck, 3);

      // Should skip first card (0) and deal next 3 (1, 2, 3)
      expect(cards).toEqual([1, 2, 3]);
      expect(remaining).toEqual([4, 5]);
    });

    test("burns and deals flop (3 cards)", () => {
      const deck = createDeck();
      const [flop, remaining] = burnAndDeal(deck, 3);

      expect(flop.length).toBe(3);
      expect(remaining.length).toBe(48); // 52 - 1 (burn) - 3 (dealt)
    });

    test("burns and deals turn (1 card)", () => {
      const deck = [0, 1, 2, 3];
      const [turn, remaining] = burnAndDeal(deck, 1);

      expect(turn).toEqual([1]);
      expect(remaining).toEqual([2, 3]);
    });

    test("throws error if not enough cards", () => {
      const deck = createDeck();

      expect(() => burnAndDeal(deck, 52)).toThrow();
    });
  });
});
