/**
 * Regression test for ActionTo invariant failure in heads-up multi-hand scenarios
 *
 * Issue: After completing a hand in heads-up (seats 0 and 1), calling deal() again
 * causes ActionTo to point to seat 2 which doesn't exist.
 *
 * Error: "ActionTo points to empty seat: 2"
 */

import { ActionType } from "@pokertools/types";
import { PokerEngine } from "../../src/engine/PokerEngine";

describe("Heads-up Multi-Hand Bug", () => {
  it("should handle multiple hands in heads-up without ActionTo invariant failure", () => {
    const engine = new PokerEngine({
      smallBlind: 10,
      bigBlind: 20,
      maxPlayers: 6,
    });

    // Sit two players in seats 0 and 1 (heads-up)
    engine.sit(0, "p1", "Player 1", 1000);
    engine.sit(1, "p2", "Player 2", 1000);

    // Play 5 hands, folding to end each quickly
    for (let handNum = 0; handNum < 5; handNum++) {
      // Deal - this should NOT throw "ActionTo points to empty seat: 2"
      expect(() => engine.deal()).not.toThrow();
      // Verify actionTo is valid
      expect(engine.state.actionTo).not.toBeNull();
      expect(engine.state.actionTo).toBeGreaterThanOrEqual(0);
      expect(engine.state.actionTo).toBeLessThan(engine.state.maxPlayers);

      const actingPlayer = engine.state.players[engine.state.actionTo!];
      expect(actingPlayer).toBeTruthy();
      expect([0, 1]).toContain(engine.state.actionTo); // Should be seat 0 or 1

      // Fold to end hand quickly
      engine.act({
        type: ActionType.FOLD,
        playerId: actingPlayer!.id,
      });

      // Verify hand completed
      expect(engine.state.street).toBe("SHOWDOWN");
      expect(engine.state.winners).toBeTruthy();
      expect(engine.state.winners!.length).toBeGreaterThan(0);
    }
  });

  it("should handle multi-hand with different seat assignments", () => {
    const engine = new PokerEngine({
      smallBlind: 5,
      bigBlind: 10,
      maxPlayers: 9,
    });

    // Sit two players in non-adjacent seats
    engine.sit(2, "p1", "Player 1", 1000);
    engine.sit(5, "p2", "Player 2", 1000);

    // Play multiple hands
    for (let handNum = 0; handNum < 3; handNum++) {
      expect(() => engine.deal()).not.toThrow();

      const actingPlayer = engine.state.players[engine.state.actionTo!];
      expect(actingPlayer).toBeTruthy();
      expect([2, 5]).toContain(engine.state.actionTo); // Should be seat 2 or 5

      engine.act({
        type: ActionType.FOLD,
        playerId: actingPlayer!.id,
      });
    }
  });
});
