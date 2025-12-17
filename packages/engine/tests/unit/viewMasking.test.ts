import { PokerEngine } from "../../src/engine/PokerEngine";
import { ActionType, Street, PlayerStatus } from "@pokertools/types";
import {
  createPublicView,
  createSpectatorView,
  sanitizeActionHistory,
} from "../../src/utils/viewMasking";
import { createDeterministicRNG } from "../helpers/seededRandom";

/**
 * Helper to play through to showdown
 */
function playToShowdown(engine: PokerEngine, maxActions = 20): void {
  let actionCount = 0;
  while (engine.state.street !== Street.SHOWDOWN && actionCount < maxActions) {
    if (engine.state.actionTo === null) break;

    const player = engine.state.players[engine.state.actionTo!]!;
    const currentBet = Math.max(...Array.from(engine.state.currentBets.values()), 0);
    const playerBet = engine.state.currentBets.get(engine.state.actionTo!) || 0;

    try {
      if (currentBet > playerBet) {
        engine.act({
          type: ActionType.CALL,
          playerId: player.id,
        });
      } else {
        engine.act({
          type: ActionType.CHECK,
          playerId: player.id,
        });
      }
    } catch (_e) {
      break;
    }
    actionCount++;
  }
}

describe("View Masking - createPublicView", () => {
  test("should show player their own hole cards", () => {
    const engine = new PokerEngine({
      smallBlind: 5,
      bigBlind: 10,
      maxPlayers: 2,
    });

    engine.sit(0, "p0", "Player0", 1000);
    engine.sit(1, "p1", "Player1", 1000);
    engine.deal();

    const player0 = engine.state.players[0]!;
    const publicView = createPublicView(engine.state, player0.id);

    // Player should see their own cards
    expect(publicView.players[0]!.hand).not.toBeNull();
    expect(publicView.players[0]!.hand).toEqual(player0.hand);
    expect(publicView.viewingPlayerId).toBe(player0.id);
  });

  test("should hide opponent hole cards before showdown", () => {
    const engine = new PokerEngine({
      smallBlind: 5,
      bigBlind: 10,
      maxPlayers: 2,
    });

    engine.sit(0, "p0", "Player0", 1000);
    engine.sit(1, "p1", "Player1", 1000);
    engine.deal();

    const player0 = engine.state.players[0]!;
    const publicView = createPublicView(engine.state, player0.id);

    // Should hide opponent's cards
    expect(publicView.players[1]!.hand).toBeNull();
  });

  test("should always hide deck", () => {
    const engine = new PokerEngine({
      smallBlind: 5,
      bigBlind: 10,
      maxPlayers: 2,
    });

    engine.sit(0, "p0", "Player0", 1000);
    engine.sit(1, "p1", "Player1", 1000);
    engine.deal();

    const player0 = engine.state.players[0]!;
    const publicView = createPublicView(engine.state, player0.id);

    // Deck should always be hidden
    expect(publicView.deck).toEqual([]);
    expect(engine.state.deck.length).toBeGreaterThan(0); // Verify original deck is not empty
  });

  test("should show winner cards at showdown", () => {
    const engine = new PokerEngine({
      smallBlind: 5,
      bigBlind: 10,
      maxPlayers: 2,
      randomProvider: createDeterministicRNG(555),
    });

    engine.sit(0, "p0", "Player0", 1000);
    engine.sit(1, "p1", "Player1", 1000);

    let attempts = 0;
    do {
      engine.deal();
      playToShowdown(engine);
      attempts++;
      if (attempts > 100) {
        throw new Error("Could not get a single winner after 100 attempts");
      }
    } while (!engine.state.winners || engine.state.winners.length !== 1);

    expect(engine.state.street).toBe(Street.SHOWDOWN);

    const winner = engine.state.winners![0];
    const player0 = engine.state.players[0]!;
    const publicView = createPublicView(engine.state, player0.id);

    // Winner's cards should be visible
    expect(publicView.players[winner.seat]!.hand).not.toBeNull();
    expect(publicView.players[winner.seat]!.hand).toEqual(engine.state.players[winner.seat]!.hand);
  });

  test("should hide mucked cards at showdown when explicitly mucked", () => {
    // Use deterministic RNG to ensure consistent winner/loser
    const engine = new PokerEngine({
      smallBlind: 5,
      bigBlind: 10,
      maxPlayers: 2,
      randomProvider: createDeterministicRNG(42),
    });

    engine.sit(0, "p0", "Player0", 1000);
    engine.sit(1, "p1", "Player1", 1000);

    // Keep dealing until we get a clear winner (not a split pot)
    let attempts = 0;
    do {
      engine.deal();
      playToShowdown(engine);
      attempts++;
      if (attempts > 100) {
        throw new Error("Could not get a single winner after 100 attempts");
      }
    } while (!engine.state.winners || engine.state.winners.length !== 1);

    expect(engine.state.street).toBe(Street.SHOWDOWN);
    const winner = engine.state.winners![0];
    const loserSeat = winner.seat === 0 ? 1 : 0;
    const loser = engine.state.players[loserSeat]!;

    // At showdown, loser cards are automatically mucked (shownCards should be null)
    // Verify this is the default behavior
    expect(loser.shownCards).toBeNull();

    const player0 = engine.state.players[0]!;
    const publicView = createPublicView(engine.state, player0.id);

    // Mucked cards should be hidden in public view
    expect(publicView.players[loserSeat]!.hand).toBeNull();
  });

  test("should show partial cards based on shownCards", () => {
    // Test the masking logic with manually set shownCards to avoid RNG issues
    const engine = new PokerEngine({
      smallBlind: 5,
      bigBlind: 10,
      maxPlayers: 3,
      randomProvider: createDeterministicRNG(12345),
    });

    engine.sit(0, "p0", "Player0", 1000);
    engine.sit(1, "p1", "Player1", 1000);
    engine.sit(2, "p2", "Player2", 1000);

    engine.deal();
    playToShowdown(engine);

    // Find a player who is at showdown with cards
    let testSeat = -1;
    for (let i = 0; i < engine.state.players.length; i++) {
      const p = engine.state.players[i];
      if (
        p &&
        p.hand &&
        p.hand.length === 2 &&
        (p.status === PlayerStatus.ACTIVE || p.status === PlayerStatus.ALL_IN)
      ) {
        testSeat = i;
        break;
      }
    }

    if (testSeat === -1) {
      throw new Error("No suitable player found for test");
    }

    // Manually set shownCards to show only first card
    engine.state.players[testSeat]!.shownCards = [0];

    // View as a different player
    const viewerSeat = (testSeat + 1) % 3;
    const viewer = engine.state.players[viewerSeat]!;

    const publicView = createPublicView(engine.state, viewer.id);

    const visibleHand = publicView.players[testSeat]!.hand as Array<string | null>;
    expect(visibleHand).not.toBeNull();
    expect(visibleHand).toBeInstanceOf(Array);
    expect(visibleHand.length).toBe(2);
    expect(visibleHand[0]).not.toBeNull(); // First card shown
    expect(visibleHand[1]).toBeNull(); // Second card hidden
  });

  test("should handle empty shownCards array", () => {
    const engine = new PokerEngine({
      smallBlind: 5,
      bigBlind: 10,
      maxPlayers: 3, // Use 3 players to avoid heads-up edge cases
    });

    engine.sit(0, "p0", "Player0", 1000);
    engine.sit(1, "p1", "Player1", 1000);
    engine.sit(2, "p2", "Player2", 1000);

    engine.deal();

    // Get to showdown with at least 2 players
    playToShowdown(engine);

    // Find a different player than the viewer
    let testSeat = 1; // Player 1
    const viewerSeat = 0; // Player 0 is viewing
    const viewer = engine.state.players[viewerSeat]!;

    // Make sure test player has a hand and is at showdown
    if (!engine.state.players[testSeat]?.hand) {
      // Try another seat
      testSeat = 2;
    }

    // Manually set shownCards to empty array (edge case) via direct mutation
    engine.state.players[testSeat]!.shownCards = [];

    const publicView = createPublicView(engine.state, viewer.id);

    const visibleHand = publicView.players[testSeat]!.hand;
    if (visibleHand) {
      const handArray = visibleHand as Array<string | null>;
      expect(handArray.every((card) => card === null)).toBe(true);
    } else {
      // If hand is null, that's also acceptable (player is hidden completely)
      expect(visibleHand).toBeNull();
    }
  });

  test("should handle player with no hand", () => {
    const engine = new PokerEngine({
      smallBlind: 5,
      bigBlind: 10,
      maxPlayers: 2,
    });

    engine.sit(0, "p0", "Player0", 1000);
    engine.sit(1, "p1", "Player1", 1000);

    const player0 = engine.state.players[0]!;

    // Create view before dealing
    const publicView = createPublicView(engine.state, player0.id);

    // Players shouldn't have hands yet
    expect(publicView.players[0]!.hand).toBeNull();
    expect(publicView.players[1]!.hand).toBeNull();
  });

  test("should convert currentBets Map to plain object", () => {
    const engine = new PokerEngine({
      smallBlind: 5,
      bigBlind: 10,
      maxPlayers: 2,
    });

    engine.sit(0, "p0", "Player0", 1000);
    engine.sit(1, "p1", "Player1", 1000);
    engine.deal();

    const player0 = engine.state.players[0]!;
    const publicView = createPublicView(engine.state, player0.id);

    // Should be converted to plain object (not Map)
    expect(publicView.currentBets).not.toBeInstanceOf(Map);
    expect(typeof publicView.currentBets).toBe("object");
  });
});

describe("View Masking - createSpectatorView", () => {
  test("should hide all player hole cards for spectators", () => {
    const engine = new PokerEngine({
      smallBlind: 5,
      bigBlind: 10,
      maxPlayers: 2,
    });

    engine.sit(0, "p0", "Player0", 1000);
    engine.sit(1, "p1", "Player1", 1000);
    engine.deal();

    const spectatorView = createSpectatorView(engine.state);

    // All hole cards should be hidden
    expect(spectatorView.players[0]!.hand).toBeNull();
    expect(spectatorView.players[1]!.hand).toBeNull();
    expect(spectatorView.viewingPlayerId).toBeNull();
  });

  test("should show winner cards at showdown for spectators", () => {
    const engine = new PokerEngine({
      smallBlind: 5,
      bigBlind: 10,
      maxPlayers: 2,
      randomProvider: createDeterministicRNG(999),
    });

    engine.sit(0, "p0", "Player0", 1000);
    engine.sit(1, "p1", "Player1", 1000);

    let attempts = 0;
    do {
      engine.deal();
      playToShowdown(engine);
      attempts++;
      if (attempts > 100) {
        throw new Error("Could not get a single winner after 100 attempts");
      }
    } while (!engine.state.winners || engine.state.winners.length !== 1);

    const spectatorView = createSpectatorView(engine.state);

    const winner = engine.state.winners![0];

    // Winner's cards should be visible to spectators
    expect(spectatorView.players[winner.seat]!.hand).not.toBeNull();
  });

  test("should hide mucked cards at showdown for spectators", () => {
    const engine = new PokerEngine({
      smallBlind: 5,
      bigBlind: 10,
      maxPlayers: 2,
      randomProvider: createDeterministicRNG(777),
    });

    engine.sit(0, "p0", "Player0", 1000);
    engine.sit(1, "p1", "Player1", 1000);

    let attempts = 0;
    do {
      engine.deal();
      playToShowdown(engine);
      attempts++;
      if (attempts > 100) {
        throw new Error("Could not get a single winner after 100 attempts");
      }
    } while (!engine.state.winners || engine.state.winners.length !== 1);

    const winner = engine.state.winners![0];
    const loserSeat = winner.seat === 0 ? 1 : 0;

    const spectatorView = createSpectatorView(engine.state);

    // Loser's mucked cards should be hidden
    expect(spectatorView.players[loserSeat]!.hand).toBeNull();
  });

  test("should always hide deck for spectators", () => {
    const engine = new PokerEngine({
      smallBlind: 5,
      bigBlind: 10,
      maxPlayers: 2,
    });

    engine.sit(0, "p0", "Player0", 1000);
    engine.sit(1, "p1", "Player1", 1000);
    engine.deal();

    const spectatorView = createSpectatorView(engine.state);

    expect(spectatorView.deck).toEqual([]);
  });
});

describe("View Masking - sanitizeActionHistory", () => {
  test("should return action history as-is", () => {
    const engine = new PokerEngine({
      smallBlind: 5,
      bigBlind: 10,
      maxPlayers: 2,
    });

    engine.sit(0, "p0", "Player0", 1000);
    engine.sit(1, "p1", "Player1", 1000);
    engine.deal();

    const player0 = engine.state.players[0]!;
    const sanitized = sanitizeActionHistory(engine.state, player0.id);

    // Currently just returns the history unchanged
    expect(sanitized).toBe(engine.state.actionHistory);
    // After dealing, there should be some actions in history
    expect(Array.isArray(sanitized)).toBe(true);
  });

  test("should work with null viewer", () => {
    const engine = new PokerEngine({
      smallBlind: 5,
      bigBlind: 10,
      maxPlayers: 2,
    });

    engine.sit(0, "p0", "Player0", 1000);
    engine.sit(1, "p1", "Player1", 1000);
    engine.deal();

    const sanitized = sanitizeActionHistory(engine.state, null);

    expect(sanitized).toBe(engine.state.actionHistory);
  });
});
