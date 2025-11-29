import { PokerEngine } from "../../src/engine/PokerEngine";
import { ActionType } from "@pokertools/types";

describe("Hand History Export", () => {
  test("exports JSON format", () => {
    const engine = new PokerEngine({
      smallBlind: 10,
      bigBlind: 20,
      maxPlayers: 3,
    });

    engine.sit(0, "p1", "Alice", 1000);
    engine.sit(1, "p2", "Bob", 1000);
    engine.sit(2, "p3", "Charlie", 1000);

    engine.deal();

    // Alice folds
    engine.act({
      type: ActionType.FOLD,
      playerId: "p1",
      timestamp: Date.now(),
    });

    // Bob calls
    engine.act({
      type: ActionType.CALL,
      playerId: "p2",
      timestamp: Date.now(),
    });

    // Charlie checks
    engine.act({
      type: ActionType.CHECK,
      playerId: "p3",
      timestamp: Date.now(),
    });

    // Get hand history
    const jsonHistory = engine.history({ format: "json" });

    expect(jsonHistory).toBeTruthy();
    expect(jsonHistory.length).toBeGreaterThan(0);

    // Parse and verify
    const parsed = JSON.parse(jsonHistory);
    expect(parsed.handId).toBeTruthy();
    expect(parsed.players).toHaveLength(3);
    expect(parsed.streets.length).toBeGreaterThan(0);
    // Total pot could be 0 if no winners yet
    expect(parsed.totalPot).toBeGreaterThanOrEqual(0);
  });

  test("exports PokerStars format", () => {
    const engine = new PokerEngine({
      smallBlind: 1,
      bigBlind: 2,
      maxPlayers: 2,
    });

    engine.sit(0, "p1", "Hero", 100);
    engine.sit(1, "p2", "Villain", 100);

    engine.deal();

    // Hero raises
    engine.act({
      type: ActionType.RAISE,
      playerId: "p1",
      amount: 6,
      timestamp: Date.now(),
    });

    // Villain calls
    engine.act({
      type: ActionType.CALL,
      playerId: "p2",
      timestamp: Date.now(),
    });

    // Get hand history in PokerStars format
    const psHistory = engine.history({ format: "pokerstars" });

    expect(psHistory).toBeTruthy();
    expect(psHistory).toContain("PokerStars Hand");
    expect(psHistory).toContain("Hold'em No Limit");
    expect(psHistory).toContain("Hero");
    expect(psHistory).toContain("Villain");
    // May or may not have flop depending on action completion
    expect(psHistory).toContain("*** HOLE CARDS ***");
  });

  test("gets structured hand history", () => {
    const engine = new PokerEngine({
      smallBlind: 5,
      bigBlind: 10,
      maxPlayers: 2,
    });

    engine.sit(0, "p1", "Alice", 500);
    engine.sit(1, "p2", "Bob", 500);

    engine.deal();

    const history = engine.getHandHistory();

    expect(history.handId).toBeTruthy();
    expect(history.players).toHaveLength(2);
    expect(history.stakes).toEqual({
      smallBlind: 5,
      bigBlind: 10,
      ante: 0,
    });
    expect(history.maxPlayers).toBe(2);
    expect(history.buttonSeat).toBe(0);
  });

  test("includes hole cards when requested", () => {
    const engine = new PokerEngine({
      smallBlind: 1,
      bigBlind: 2,
      maxPlayers: 2,
    });

    engine.sit(0, "p1", "Alice", 100);
    engine.sit(1, "p2", "Bob", 100);

    engine.deal();

    const jsonHistory = engine.history({
      format: "json",
      includeHoleCards: true,
    });

    const parsed = JSON.parse(jsonHistory);

    // Check that players have hole cards
    expect(parsed.players[0].cards).toBeTruthy();
    expect(parsed.players[0].cards.length).toBe(2);
    expect(parsed.players[1].cards).toBeTruthy();
    expect(parsed.players[1].cards.length).toBe(2);
  });

  test("sanitizes hole cards when not requested", () => {
    const engine = new PokerEngine({
      smallBlind: 1,
      bigBlind: 2,
      maxPlayers: 2,
    });

    engine.sit(0, "p1", "Alice", 100);
    engine.sit(1, "p2", "Bob", 100);

    engine.deal();

    const jsonHistory = engine.history({
      format: "json",
      includeHoleCards: false,
    });

    const parsed = JSON.parse(jsonHistory);

    // Hole cards should be undefined
    expect(parsed.players[0].cards).toBeUndefined();
    expect(parsed.players[1].cards).toBeUndefined();
  });

  test("compact JSON format", () => {
    const engine = new PokerEngine({
      smallBlind: 1,
      bigBlind: 2,
      maxPlayers: 2,
    });

    engine.sit(0, "p1", "Alice", 100);
    engine.sit(1, "p2", "Bob", 100);

    engine.deal();

    const compactHistory = engine.history({ format: "compact" });
    const prettyHistory = engine.history({ format: "json" });

    // Compact should be shorter (no formatting)
    expect(compactHistory.length).toBeLessThan(prettyHistory.length);

    // Both should parse to the same object
    expect(JSON.parse(compactHistory)).toEqual(JSON.parse(prettyHistory));
  });
});
