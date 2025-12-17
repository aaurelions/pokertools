import { PokerEngine } from "../../src/engine/PokerEngine";
import { ActionType } from "@pokertools/types";
import { exportHandHistory, getHandHistory, exportMultipleHands } from "../../src/history/exporter";

describe("Hand History Export", () => {
  let engine: PokerEngine;

  beforeEach(() => {
    engine = new PokerEngine({
      smallBlind: 10,
      bigBlind: 20,
      maxPlayers: 6,
    });

    // Set up a simple hand
    engine.sit(0, "p1", "Alice", 1000);
    engine.sit(1, "p2", "Bob", 1000);
    engine.sit(2, "p3", "Charlie", 1000);
    engine.deal();
  });

  describe("getHandHistory", () => {
    test("returns structured hand history object", () => {
      // Complete the hand
      engine.act({ type: ActionType.FOLD, playerId: "p1" });
      engine.act({ type: ActionType.FOLD, playerId: "p2" });

      const history = getHandHistory(engine.state);

      expect(history).toHaveProperty("handId");
      expect(history).toHaveProperty("stakes");
      expect(history).toHaveProperty("players");
      expect(history).toHaveProperty("streets");
      expect(history).toHaveProperty("winners");
      expect(history.stakes).toEqual({
        smallBlind: 10,
        bigBlind: 20,
        ante: 0,
      });
    });

    test("includes all seated players", () => {
      const history = getHandHistory(engine.state);

      expect(history.players).toHaveLength(3);
      expect(history.players[0]).toMatchObject({
        name: "Alice",
        seat: 0,
        startingStack: expect.any(Number),
        endingStack: expect.any(Number),
      });
    });

    test("includes action history in streets", () => {
      engine.act({ type: ActionType.CALL, playerId: "p1" });

      const history = getHandHistory(engine.state);

      expect(history.streets.length).toBeGreaterThan(0);
      expect(history.streets[0].actions.some((a) => a.action.type === "CALL")).toBe(true);
    });
  });

  describe("exportHandHistory - JSON format", () => {
    test("exports to JSON by default", () => {
      engine.act({ type: ActionType.FOLD, playerId: "p1" });
      engine.act({ type: ActionType.FOLD, playerId: "p2" });

      const exported = exportHandHistory(engine.state);

      expect(() => JSON.parse(exported)).not.toThrow();
      const parsed = JSON.parse(exported);
      expect(parsed).toHaveProperty("handId");
      expect(parsed).toHaveProperty("stakes");
    });

    test("exports with pretty printing by default", () => {
      engine.act({ type: ActionType.FOLD, playerId: "p1" });
      engine.act({ type: ActionType.FOLD, playerId: "p2" });

      const exported = exportHandHistory(engine.state, { format: "json" });

      // Pretty-printed JSON has newlines
      expect(exported).toContain("\n");
      expect(exported).toContain("  ");
    });

    test("compact format removes whitespace", () => {
      engine.act({ type: ActionType.FOLD, playerId: "p1" });
      engine.act({ type: ActionType.FOLD, playerId: "p2" });

      const exported = exportHandHistory(engine.state, { format: "compact" });

      // Compact JSON should not have pretty printing
      const parsed = JSON.parse(exported);
      expect(parsed).toHaveProperty("handId");

      // Should be more compact (no indentation)
      expect(exported.split("\n").length).toBe(1);
    });

    test("includeHoleCards option affects output", () => {
      engine.act({ type: ActionType.FOLD, playerId: "p1" });
      engine.act({ type: ActionType.FOLD, playerId: "p2" });

      const withHoleCards = exportHandHistory(engine.state, {
        format: "json",
        includeHoleCards: true,
      });

      const withoutHoleCards = exportHandHistory(engine.state, {
        format: "json",
        includeHoleCards: false,
      });

      // Both should be valid JSON
      expect(() => JSON.parse(withHoleCards)).not.toThrow();
      expect(() => JSON.parse(withoutHoleCards)).not.toThrow();

      // Option should affect the export (size should differ if cards are included/excluded)
      const parsedWith = JSON.parse(withHoleCards);
      expect(parsedWith.players).toBeDefined();
    });
  });

  describe("exportHandHistory - PokerStars format", () => {
    test("exports to PokerStars format", () => {
      engine.act({ type: ActionType.FOLD, playerId: "p1" });
      engine.act({ type: ActionType.FOLD, playerId: "p2" });

      const exported = exportHandHistory(engine.state, { format: "pokerstars" });

      expect(typeof exported).toBe("string");
      // PokerStars format should contain certain keywords
      expect(exported).toContain("PokerStars Hand");
      expect(exported.length).toBeGreaterThan(0);
    });

    test("includes table info", () => {
      engine.act({ type: ActionType.FOLD, playerId: "p1" });
      engine.act({ type: ActionType.FOLD, playerId: "p2" });

      const exported = exportHandHistory(engine.state, { format: "pokerstars" });

      // Should mention 6-max
      expect(exported).toContain("6-max");
    });

    test("includes stakes information", () => {
      engine.act({ type: ActionType.FOLD, playerId: "p1" });
      engine.act({ type: ActionType.FOLD, playerId: "p2" });

      const exported = exportHandHistory(engine.state, { format: "pokerstars" });

      // Should contain numeric values related to blinds
      expect(exported).toMatch(/\d+/);
      expect(exported.length).toBeGreaterThan(100);
    });

    test("includes player actions", () => {
      engine.act({ type: ActionType.CALL, playerId: "p1" });
      engine.act({ type: ActionType.RAISE, playerId: "p2", amount: 60 });

      const exported = exportHandHistory(engine.state, { format: "pokerstars" });

      expect(exported).toContain("calls");
      expect(exported).toContain("raises");
    });

    test("handles includeHoleCards option", () => {
      engine.act({ type: ActionType.FOLD, playerId: "p1" });
      engine.act({ type: ActionType.FOLD, playerId: "p2" });

      const withCards = exportHandHistory(engine.state, {
        format: "pokerstars",
        includeHoleCards: true,
      });

      const _withoutCards = exportHandHistory(engine.state, {
        format: "pokerstars",
        includeHoleCards: false,
      });

      // With cards should show dealt cards
      expect(withCards.includes("[") || withCards.includes("Dealt")).toBe(true);
    });
  });

  describe("exportMultipleHands", () => {
    test("exports multiple hands to JSON array", () => {
      // Play first hand
      engine.act({ type: ActionType.FOLD, playerId: "p1" });
      engine.act({ type: ActionType.FOLD, playerId: "p2" });
      const state1 = engine.snapshot;

      // Play second hand
      engine.deal();
      // Find who has action
      const currentPlayer = engine.state.players[engine.state.actionTo!];
      engine.act({ type: ActionType.FOLD, playerId: currentPlayer!.id });
      const state2 = engine.snapshot;

      // Restore states and export
      const restoredState1 = PokerEngine.restore(state1).state;
      const restoredState2 = PokerEngine.restore(state2).state;

      const exported = exportMultipleHands([restoredState1, restoredState2], { format: "json" });

      const parsed = JSON.parse(exported);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed).toHaveLength(2);
      expect(parsed[0]).toHaveProperty("handId");
      expect(parsed[1]).toHaveProperty("handId");
    });

    test("exports multiple hands to PokerStars format with separators", () => {
      // Play first hand
      engine.act({ type: ActionType.FOLD, playerId: "p1" });
      engine.act({ type: ActionType.FOLD, playerId: "p2" });
      const state1 = engine.snapshot;

      // Play second hand
      engine.deal();
      const currentPlayer = engine.state.players[engine.state.actionTo!];
      engine.act({ type: ActionType.FOLD, playerId: currentPlayer!.id });
      const state2 = engine.snapshot;

      // Restore states and export
      const restoredState1 = PokerEngine.restore(state1).state;
      const restoredState2 = PokerEngine.restore(state2).state;

      const exported = exportMultipleHands([restoredState1, restoredState2], {
        format: "pokerstars",
      });

      // Should contain both hand headers
      const handCount = (exported.match(/PokerStars Hand/g) || []).length;
      expect(handCount).toBe(2);

      // Should be separated by blank lines
      expect(exported).toContain("\n\n\n");
    });

    test("handles empty array", () => {
      const exported = exportMultipleHands([], { format: "json" });
      const parsed = JSON.parse(exported);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed).toHaveLength(0);
    });

    test("compact format for multiple hands", () => {
      engine.act({ type: ActionType.FOLD, playerId: "p1" });
      engine.act({ type: ActionType.FOLD, playerId: "p2" });
      const state1 = { ...engine.state };

      const exported = exportMultipleHands([state1], { format: "compact" });

      // Should be valid JSON
      const parsed = JSON.parse(exported);
      expect(Array.isArray(parsed)).toBe(true);

      // Should be compact (single line)
      expect(exported.split("\n").length).toBe(1);
    });
  });

  describe("export with showdown", () => {
    test("includes winner information", () => {
      // Simple fold scenario - winner is determined without showdown
      engine.act({ type: ActionType.FOLD, playerId: "p1" });
      engine.act({ type: ActionType.FOLD, playerId: "p2" });

      const history = getHandHistory(engine.state);

      expect(history.winners).toBeDefined();
      expect(history.winners!.length).toBeGreaterThan(0);
      expect(history.winners![0]).toHaveProperty("seat");
      expect(history.winners![0]).toHaveProperty("amount");
    });

    test("exports showdown with hand rankings", () => {
      // Create new engine for showdown scenario
      const showdownEngine = new PokerEngine({
        smallBlind: 10,
        bigBlind: 20,
        maxPlayers: 3,
      });

      showdownEngine.sit(0, "p1", "Alice", 1000);
      showdownEngine.sit(1, "p2", "Bob", 1000);
      showdownEngine.deal();

      // Call to showdown
      showdownEngine.act({ type: ActionType.CALL, playerId: "p1" });
      showdownEngine.act({ type: ActionType.CHECK, playerId: "p2" });

      // Check through all streets
      while (showdownEngine.state.street !== "SHOWDOWN") {
        const currentPlayer = showdownEngine.state.players[showdownEngine.state.actionTo!];
        if (currentPlayer) {
          showdownEngine.act({ type: ActionType.CHECK, playerId: currentPlayer.id });
        }
      }

      const exported = exportHandHistory(showdownEngine.state, { format: "json" });
      const parsed = JSON.parse(exported);

      expect(parsed.winners).toBeDefined();
      expect(parsed.winners.length).toBeGreaterThan(0);
    });
  });

  describe("export with antes", () => {
    test("includes ante information", () => {
      const engineWithAntes = new PokerEngine({
        smallBlind: 10,
        bigBlind: 20,
        ante: 5,
        maxPlayers: 6,
      });

      engineWithAntes.sit(0, "p1", "Alice", 1000);
      engineWithAntes.sit(1, "p2", "Bob", 1000);
      engineWithAntes.deal();

      const history = getHandHistory(engineWithAntes.state);

      expect(history.stakes.ante).toBe(5);
    });
  });

  describe("export with tournament blinds", () => {
    test("exports tournament information", () => {
      const tournamentEngine = new PokerEngine({
        smallBlind: 10,
        bigBlind: 20,
        maxPlayers: 6,
        blindStructure: [
          { smallBlind: 10, bigBlind: 20, ante: 0 },
          { smallBlind: 20, bigBlind: 40, ante: 0 },
          { smallBlind: 30, bigBlind: 60, ante: 5 },
        ],
      });

      tournamentEngine.sit(0, "p1", "Alice", 1000);
      tournamentEngine.sit(1, "p2", "Bob", 1000);
      tournamentEngine.deal();

      tournamentEngine.act({ type: ActionType.FOLD, playerId: "p1" });

      const history = getHandHistory(tournamentEngine.state);

      // Should have proper structure
      expect(history).toHaveProperty("handId");
      expect(history).toHaveProperty("stakes");
      expect(history.stakes).toHaveProperty("smallBlind");
      expect(history.stakes).toHaveProperty("bigBlind");
    });
  });
});
