import { PokerEngine } from "../../src/engine/PokerEngine";
import { ActionType } from "@pokertools/types";

describe("Tournament Actions - NEXT_BLIND_LEVEL", () => {
  test("should advance to next blind level in tournament", () => {
    const blindStructure = [
      { smallBlind: 5, bigBlind: 10, ante: 0 },
      { smallBlind: 10, bigBlind: 20, ante: 0 },
      { smallBlind: 25, bigBlind: 50, ante: 5 },
    ];

    const engine = new PokerEngine({
      smallBlind: 5,
      bigBlind: 10,
      maxPlayers: 2,
      blindStructure,
    });

    engine.sit(0, "p0", "Player0", 1000);
    engine.sit(1, "p1", "Player1", 1000);

    // Initial blind level
    expect(engine.state.blindLevel).toBe(0);
    expect(engine.state.smallBlind).toBe(5);
    expect(engine.state.bigBlind).toBe(10);
    expect(engine.state.ante).toBe(0);

    // Advance to level 1
    engine.act({
      type: ActionType.NEXT_BLIND_LEVEL,
    });

    expect(engine.state.blindLevel).toBe(1);
    expect(engine.state.smallBlind).toBe(10);
    expect(engine.state.bigBlind).toBe(20);
    expect(engine.state.ante).toBe(0);

    // Advance to level 2
    engine.act({
      type: ActionType.NEXT_BLIND_LEVEL,
    });

    expect(engine.state.blindLevel).toBe(2);
    expect(engine.state.smallBlind).toBe(25);
    expect(engine.state.bigBlind).toBe(50);
    expect(engine.state.ante).toBe(5);
  });

  test("should not advance beyond max blind level", () => {
    const blindStructure = [
      { smallBlind: 5, bigBlind: 10, ante: 0 },
      { smallBlind: 10, bigBlind: 20, ante: 0 },
    ];

    const engine = new PokerEngine({
      smallBlind: 5,
      bigBlind: 10,
      maxPlayers: 2,
      blindStructure,
    });

    engine.sit(0, "p0", "Player0", 1000);
    engine.sit(1, "p1", "Player1", 1000);

    // Advance to level 1 (max)
    engine.act({
      type: ActionType.NEXT_BLIND_LEVEL,
    });

    expect(engine.state.blindLevel).toBe(1);
    expect(engine.state.smallBlind).toBe(10);
    expect(engine.state.bigBlind).toBe(20);

    // Try to advance beyond max level
    engine.act({
      type: ActionType.NEXT_BLIND_LEVEL,
    });

    // Should stay at level 1
    expect(engine.state.blindLevel).toBe(1);
    expect(engine.state.smallBlind).toBe(10);
    expect(engine.state.bigBlind).toBe(20);
  });

  test("should not affect cash games without blind structure", () => {
    const engine = new PokerEngine({
      smallBlind: 5,
      bigBlind: 10,
      maxPlayers: 2,
      // No blindStructure - cash game
    });

    engine.sit(0, "p0", "Player0", 1000);
    engine.sit(1, "p1", "Player1", 1000);

    const initialSmallBlind = engine.state.smallBlind;
    const initialBigBlind = engine.state.bigBlind;
    const initialBlindLevel = engine.state.blindLevel;

    engine.act({
      type: ActionType.NEXT_BLIND_LEVEL,
    });

    // Should not change anything in cash game
    expect(engine.state.smallBlind).toBe(initialSmallBlind);
    expect(engine.state.bigBlind).toBe(initialBigBlind);
    expect(engine.state.blindLevel).toBe(initialBlindLevel);
  });

  test("should record action in history", () => {
    const blindStructure = [
      { smallBlind: 5, bigBlind: 10, ante: 0 },
      { smallBlind: 10, bigBlind: 20, ante: 0 },
    ];

    const engine = new PokerEngine({
      smallBlind: 5,
      bigBlind: 10,
      maxPlayers: 2,
      blindStructure,
    });

    engine.sit(0, "p0", "Player0", 1000);
    engine.sit(1, "p1", "Player1", 1000);

    const initialHistoryLength = engine.state.actionHistory.length;

    engine.act({
      type: ActionType.NEXT_BLIND_LEVEL,
    });

    // Should add action to history
    expect(engine.state.actionHistory.length).toBe(initialHistoryLength + 1);
    const lastAction = engine.state.actionHistory[engine.state.actionHistory.length - 1];
    expect(lastAction.action.type).toBe(ActionType.NEXT_BLIND_LEVEL);
    expect(lastAction.seat).toBeNull(); // Table-level action
  });

  test("should work with ante in blind structure", () => {
    const blindStructure = [
      { smallBlind: 10, bigBlind: 20, ante: 2 },
      { smallBlind: 25, bigBlind: 50, ante: 5 },
      { smallBlind: 50, bigBlind: 100, ante: 10 },
    ];

    const engine = new PokerEngine({
      smallBlind: 10,
      bigBlind: 20,
      maxPlayers: 3,
      blindStructure,
    });

    engine.sit(0, "p0", "Player0", 2000);
    engine.sit(1, "p1", "Player1", 2000);
    engine.sit(2, "p2", "Player2", 2000);

    expect(engine.state.ante).toBe(2);

    engine.act({
      type: ActionType.NEXT_BLIND_LEVEL,
    });

    expect(engine.state.blindLevel).toBe(1);
    expect(engine.state.smallBlind).toBe(25);
    expect(engine.state.bigBlind).toBe(50);
    expect(engine.state.ante).toBe(5);

    // Deal to test ante is properly applied
    engine.deal();

    // Players should have paid ante
    const player0Stack = engine.state.players[0]!.stack;
    const player1Stack = engine.state.players[1]!.stack;
    const player2Stack = engine.state.players[2]!.stack;

    // All players pay ante + blinds
    expect(player0Stack).toBeLessThan(2000);
    expect(player1Stack).toBeLessThan(2000);
    expect(player2Stack).toBeLessThan(2000);
  });

  test("should update timestamp", () => {
    const blindStructure = [
      { smallBlind: 5, bigBlind: 10, ante: 0 },
      { smallBlind: 10, bigBlind: 20, ante: 0 },
    ];

    const engine = new PokerEngine({
      smallBlind: 5,
      bigBlind: 10,
      maxPlayers: 2,
      blindStructure,
    });

    engine.sit(0, "p0", "Player0", 1000);
    engine.sit(1, "p1", "Player1", 1000);

    const initialTimestamp = engine.state.timestamp;

    // Wait a bit then advance blind level
    const actionTimestamp = Date.now();
    engine.act({
      type: ActionType.NEXT_BLIND_LEVEL,
      timestamp: actionTimestamp,
    });

    expect(engine.state.timestamp).toBe(actionTimestamp);
    expect(engine.state.timestamp).toBeGreaterThanOrEqual(initialTimestamp);
  });
});
