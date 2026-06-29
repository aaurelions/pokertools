import { PokerEngine } from "../../src/engine/poker-engine";
import { ActionType, PlayerStatus, Street } from "@pokertools/types";
import { createDeck, shuffle, getSecureRandom } from "../../src/utils/deck";
import { handleDeal } from "../../src/actions/dealing";
import { createSeededRandom } from "../helpers/seeded-random";

/**
 * Secure Random & Fail-Closed Tests
 *
 * Verifies that the engine never bypasses the secure RNG fallback:
 * 1. handleDeal does NOT call Math.random when no randomProvider is supplied
 * 2. shuffle fails closed (throws) when secure RNG is unavailable
 */

describe("Secure RNG: handleDeal", () => {
  test("handleDeal does not call Math.random when no randomProvider is supplied in Node", () => {
    const randomSpy = jest.spyOn(Math, "random");

    const engine = new PokerEngine({
      smallBlind: 5,
      bigBlind: 10,
      maxPlayers: 2,
      // No randomProvider — shuffle must use getSecureRandom() internally
    });

    engine.sit(0, "p0", "Alice", 500);
    engine.sit(1, "p1", "Bob", 500);
    engine.deal();

    expect(randomSpy).not.toHaveBeenCalled();
    randomSpy.mockRestore();
  });

  test("handleDeal uses deterministic randomProvider when supplied (test behaviour is preserved)", () => {
    const rngA = createSeededRandom(42);
    const rngB = createSeededRandom(42);

    const engineA = new PokerEngine({
      smallBlind: 5,
      bigBlind: 10,
      maxPlayers: 2,
      randomProvider: rngA,
    });

    const engineB = new PokerEngine({
      smallBlind: 5,
      bigBlind: 10,
      maxPlayers: 2,
      randomProvider: rngB,
    });

    engineA.sit(0, "p0", "Alice", 500);
    engineA.sit(1, "p1", "Bob", 500);
    engineA.deal();

    engineB.sit(0, "p0", "Alice", 500);
    engineB.sit(1, "p1", "Bob", 500);
    engineB.deal();

    // Same seed → same hand IDs and same deck order (deterministic)
    expect(engineA.state.deck).toEqual(engineB.state.deck);
  });
});

describe("Secure RNG: shuffle fail-closed", () => {
  test("shuffle fails closed if secure RNG is unavailable (simulated non-Node env)", () => {
    // Simulate a non-Node environment by temporarily removing the "node"
    // property from process.versions. This causes getSecureRandom() to throw
    // instead of falling back to Math.random.
    const originalNode = (process.versions as { node?: string }).node;

    try {
      delete (process.versions as Record<string, unknown>).node;

      expect(() => shuffle(createDeck())).toThrow(/No secure random number generator available/);
    } finally {
      // Restore the original property so other tests are not affected.
      if (originalNode !== undefined) {
        (process.versions as Record<string, string>).node = originalNode;
      }
    }
  });

  test("shuffle with explicit deterministic RNG does NOT fail (test path is preserved)", () => {
    const rng = createSeededRandom(999);
    const deck = createDeck();
    const result = shuffle(deck, rng);
    expect(result).toHaveLength(52);
    const sorted = [...result].sort((a, b) => a - b);
    const expected = [...deck].sort((a, b) => a - b);
    expect(sorted).toEqual(expected);
  });

  test("getSecureRandom returns a working RNG in Node (not Math.random)", () => {
    const rng = getSecureRandom();
    expect(rng).not.toBe(Math.random);

    const values = new Set<number>();
    for (let i = 0; i < 20; i++) {
      const val = rng();
      expect(val).toBeGreaterThanOrEqual(0);
      expect(val).toBeLessThan(1);
      values.add(val);
    }
    // Extremely unlikely to get 20 identical values from a proper RNG
    expect(values.size).toBeGreaterThan(1);
  });

  test("getSecureRandom throws with clear message when not in Node", () => {
    const originalNode = (process.versions as { node?: string }).node;

    try {
      delete (process.versions as Record<string, unknown>).node;

      expect(() => getSecureRandom()).toThrow(
        "[PokerEngine] No secure random number generator available."
      );
    } finally {
      if (originalNode !== undefined) {
        (process.versions as Record<string, string>).node = originalNode;
      }
    }
  });
});

describe("Secure RNG: direct handleDeal call", () => {
  test("direct handleDeal call does not use Math.random (imports getSecureRandom)", () => {
    const randomSpy = jest.spyOn(Math, "random");

    // Create a minimal state matching what gameReducer passes to handleDeal
    const state = {
      config: {
        smallBlind: 5,
        bigBlind: 10,
        maxPlayers: 2,
        /* no randomProvider */
      },
      players: [
        {
          id: "p0",
          name: "Alice",
          seat: 0,
          stack: 500,
          status: PlayerStatus.WAITING,
          hand: null,
          shownCards: null,
          betThisStreet: 0,
          totalInvestedThisHand: 0,
          isSittingOut: false,
          pendingAddOn: 0,
          timeBank: 0,
          sitInOption: "IMMEDIATE" as const,
          reservationExpiry: null,
        },
        {
          id: "p1",
          name: "Bob",
          seat: 1,
          stack: 500,
          status: PlayerStatus.WAITING,
          hand: null,
          shownCards: null,
          betThisStreet: 0,
          totalInvestedThisHand: 0,
          isSittingOut: false,
          pendingAddOn: 0,
          timeBank: 0,
          sitInOption: "IMMEDIATE" as const,
          reservationExpiry: null,
        },
      ],
      maxPlayers: 2,
      handNumber: 0,
      buttonSeat: null,
      deck: [],
      board: [],
      street: Street.PREFLOP,
      pots: [],
      currentBets: new Map(),
      minRaise: 10,
      lastRaiseAmount: 0,
      actionTo: null,
      lastAggressorSeat: null,
      activePlayers: [],
      winners: null,
      rakeThisHand: 0,
      smallBlind: 5,
      bigBlind: 10,
      ante: 0,
      blindLevel: 0,
      timeBanks: new Map(),
      timeBankActiveSeat: null,
      actionHistory: [],
      previousStates: [],
      timestamp: Date.now(),
      handId: "initial",
    } as any;

    const result = handleDeal(state, {
      type: ActionType.DEAL,
      timestamp: Date.now(),
    });

    expect(randomSpy).not.toHaveBeenCalled();
    expect(result.handNumber).toBe(1);
    expect(result.deck).toHaveLength(48); // 52 - 4 (2 players × 2 cards)
    randomSpy.mockRestore();
  });
});
