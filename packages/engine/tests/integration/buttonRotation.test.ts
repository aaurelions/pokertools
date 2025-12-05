import { PokerEngine } from "../../src/engine/PokerEngine";
import { ActionType, Street } from "@pokertools/types";

/**
 * Helper to play a hand to showdown via check/call actions
 */
function playHandToShowdown(engine: PokerEngine): void {
  let iterations = 0;
  while (engine.state.street !== Street.SHOWDOWN && iterations < 100) {
    iterations++;
    const actionTo = engine.state.actionTo;
    if (actionTo === null) break;

    const player = engine.state.players[actionTo];
    if (!player) break;

    try {
      engine.act({ type: ActionType.CHECK, playerId: player.id });
    } catch {
      try {
        engine.act({ type: ActionType.CALL, playerId: player.id });
      } catch {
        break;
      }
    }
  }
}

describe("Button Rotation", () => {
  test("wraps around in heads-up with sparse seating (9-seat table)", () => {
    const engine = new PokerEngine({
      smallBlind: 10,
      bigBlind: 20,
      maxPlayers: 9, // 9-seat table
    });

    // Players at seats 0 and 1 only
    engine.sit(0, "p1", "Alice", 1000);
    engine.sit(1, "p2", "Bob", 1000);

    // Hand 1
    engine.deal();
    expect(engine.state.buttonSeat).toBe(0);
    playHandToShowdown(engine);

    // Hand 2
    engine.deal();
    expect(engine.state.buttonSeat).toBe(1);
    playHandToShowdown(engine);

    // Hand 3 - should wrap to seat 0, not crash
    engine.deal();
    expect(engine.state.buttonSeat).toBe(0);
    expect(engine.state.actionTo).not.toBeNull();
  });

  test("wraps around in heads-up with non-adjacent seating", () => {
    const engine = new PokerEngine({
      smallBlind: 10,
      bigBlind: 20,
      maxPlayers: 6,
    });

    // Players at seats 0 and 5 (non-adjacent on 6-seat table)
    engine.sit(0, "p1", "Alice", 1000);
    engine.sit(5, "p2", "Bob", 1000);

    // Hand 1
    engine.deal();
    expect(engine.state.buttonSeat).toBe(0);
    playHandToShowdown(engine);

    // Hand 2 - should move to seat 5 (skip empty seats 1-4)
    engine.deal();
    expect(engine.state.buttonSeat).toBe(5);
    playHandToShowdown(engine);

    // Hand 3 - should wrap to seat 0
    engine.deal();
    expect(engine.state.buttonSeat).toBe(0);
  });

  test("dead button rule applies with 3+ players", () => {
    const engine = new PokerEngine({
      smallBlind: 10,
      bigBlind: 20,
      maxPlayers: 9,
    });

    // Players at seats 0, 2, 4 (gaps between them)
    engine.sit(0, "p1", "Alice", 1000);
    engine.sit(2, "p2", "Bob", 1000);
    engine.sit(4, "p3", "Charlie", 1000);

    engine.deal();
    expect(engine.state.buttonSeat).toBe(0);

    // Play to showdown
    playHandToShowdown(engine);

    // Button should move to seat 1 (dead button at empty seat)
    engine.deal();
    expect(engine.state.buttonSeat).toBe(1); // Dead button at empty seat 1
  });

  test("multiple hands rotation is consistent", () => {
    const engine = new PokerEngine({
      smallBlind: 10,
      bigBlind: 20,
      maxPlayers: 9,
    });

    engine.sit(0, "p1", "Alice", 10000);
    engine.sit(1, "p2", "Bob", 10000);

    const expectedButtons = [0, 1, 0, 1, 0]; // Alternating pattern

    for (let hand = 0; hand < 5; hand++) {
      engine.deal();
      expect(engine.state.buttonSeat).toBe(expectedButtons[hand]);
      playHandToShowdown(engine);
    }
  });
});
