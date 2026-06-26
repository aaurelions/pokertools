/**
 * Regression test for ActionTo invariant failure in heads-up multi-hand scenarios
 *
 * Issue: After completing a hand in heads-up (seats 0 and 1), calling deal() again
 * causes ActionTo to point to seat 2 which doesn't exist.
 *
 * Error: "ActionTo points to empty seat: 2"
 */

import { ActionType } from "@pokertools/types";
import { PokerEngine } from "../../src/engine/poker-engine";

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

  it("should handle transition from 3 players to heads-up when button lands on empty seat", () => {
    const engine = new PokerEngine({
      smallBlind: 10,
      bigBlind: 20,
      maxPlayers: 9,
    });

    // Sit three players at seats 0, 1, 2
    engine.sit(0, "p1", "Player 1", 1000);
    engine.sit(1, "p2", "Player 2", 1000);
    engine.sit(2, "p3", "Player 3", 1000);

    // Play a hand to establish button position
    engine.deal();
    const actingPlayer1 = engine.state.players[engine.state.actionTo!];
    engine.act({ type: ActionType.FOLD, playerId: actingPlayer1!.id });
    const actingPlayer2 = engine.state.players[engine.state.actionTo!];
    engine.act({ type: ActionType.FOLD, playerId: actingPlayer2!.id });

    // Play another hand to move the button to seat 1
    engine.deal();
    const ap1 = engine.state.players[engine.state.actionTo!];
    engine.act({ type: ActionType.FOLD, playerId: ap1!.id });
    const ap2 = engine.state.players[engine.state.actionTo!];
    engine.act({ type: ActionType.FOLD, playerId: ap2!.id });

    // Now remove player at seat 2 (simulating bust-out)
    engine.stand("p3");

    // Button was at seat 1. Dead Button would move it to seat 2 (empty).
    // In heads-up, the button must land on an occupied seat.
    expect(() => engine.deal()).not.toThrow();

    // Verify button is on an occupied seat
    const buttonSeat = engine.state.buttonSeat;
    expect(buttonSeat).not.toBeNull();
    expect(buttonSeat).toBe(0);
    expect(engine.state.players[buttonSeat!]).not.toBeNull();

    // Verify actionTo is valid and points to an occupied seat
    expect(engine.state.actionTo).not.toBeNull();
    const actionPlayer = engine.state.players[engine.state.actionTo!];
    expect(actionPlayer).toBeTruthy();
    expect([0, 1]).toContain(engine.state.actionTo);

    // Complete the hand
    engine.act({ type: ActionType.FOLD, playerId: actionPlayer!.id });
    expect(engine.state.winners).toBeTruthy();

    // Play another hand to verify stability
    expect(() => engine.deal()).not.toThrow();
    expect([0, 1]).toContain(engine.state.actionTo);
  });
});
