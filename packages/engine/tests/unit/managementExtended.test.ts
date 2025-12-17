import { PokerEngine } from "../../src/engine/PokerEngine";
import { ActionType } from "@pokertools/types";
import { IllegalActionError } from "../../src/errors/IllegalActionError";
import { ErrorCodes } from "../../src/errors/ErrorCodes";

describe("Management Actions - Extended", () => {
  test("STAND during a live hand folds the player and removes them", () => {
    const engine = new PokerEngine({
      smallBlind: 10,
      bigBlind: 20,
      maxPlayers: 6,
    });

    engine.sit(0, "p1", "Alice", 1000);
    engine.sit(1, "p2", "Bob", 1000);
    engine.sit(2, "p3", "Charlie", 1000);

    engine.deal();

    // Preflop: Alice acts first (UTG)
    expect(engine.state.actionTo).toBe(0);

    // Alice stands up mid-hand
    engine.act({
      type: ActionType.STAND,
      playerId: "p1",
      timestamp: Date.now(),
    });

    const state = engine.state;

    // Alice should be removed
    expect(state.players[0]).toBeNull();

    // Check where action is
    expect(state.actionTo).toBe(1); // Should be Bob (SB)

    // Ensure game state is consistent
    expect(state.activePlayers).not.toContain(0);
  });

  test("STAND during a live hand triggers fold logic (advances state)", () => {
    const engine = new PokerEngine({
      smallBlind: 10,
      bigBlind: 20,
      maxPlayers: 2, // Heads-up
    });

    engine.sit(0, "p1", "Alice", 1000); // Button/SB
    engine.sit(1, "p2", "Bob", 1000); // BB

    engine.deal();

    // Heads-up preflop: Button (SB) acts first
    expect(engine.state.actionTo).toBe(0);

    // Alice stands up
    engine.act({
      type: ActionType.STAND,
      playerId: "p1",
      timestamp: Date.now(),
    });

    // Since only 1 player remains (Bob), the hand should end immediately
    // Bob wins by default
    expect(engine.state.street).toBe("SHOWDOWN");
    expect(engine.state.winners?.length).toBe(1);
    expect(engine.state.winners![0].seat).toBe(1);
    expect(engine.state.players[0]).toBeNull();
  });

  test("STAND with non-existent player throws error", () => {
    const engine = new PokerEngine({
      smallBlind: 10,
      bigBlind: 20,
      maxPlayers: 6,
    });

    engine.sit(0, "p1", "Alice", 1000);
    const initialTimestamp = engine.state.timestamp;

    // Stand non-existent player should throw
    try {
      engine.act({
        type: ActionType.STAND,
        playerId: "ghost",
        timestamp: initialTimestamp + 100,
      });
      fail("Should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(IllegalActionError);
      expect((e as IllegalActionError).code).toBe(ErrorCodes.PLAYER_NOT_FOUND);
    }

    // State should match
    expect(engine.state.players[0]?.id).toBe("p1");
    expect(engine.state.timestamp).toBe(initialTimestamp);
  });

  test("ADD_CHIPS with non-existent player throws error", () => {
    const engine = new PokerEngine({
      smallBlind: 10,
      bigBlind: 20,
      maxPlayers: 6,
    });

    const initialTimestamp = engine.state.timestamp;

    try {
      engine.act({
        type: ActionType.ADD_CHIPS,
        playerId: "ghost",
        amount: 1000,
        timestamp: initialTimestamp + 100,
      });
      fail("Should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(IllegalActionError);
      expect((e as IllegalActionError).code).toBe(ErrorCodes.PLAYER_NOT_FOUND);
    }

    expect(engine.state.timestamp).toBe(initialTimestamp);
  });
});