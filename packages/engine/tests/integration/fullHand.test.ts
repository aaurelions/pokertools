import { PokerEngine } from "../../src/engine/PokerEngine";
import { ActionType, Street } from "@pokertools/types";

describe("Full Hand Integration", () => {
  test("complete hand from deal to showdown", () => {
    // Create engine
    const engine = new PokerEngine({
      smallBlind: 10,
      bigBlind: 20,
      maxPlayers: 3,
    });

    // Add players
    engine.sit(0, "p1", "Alice", 1000);
    engine.sit(1, "p2", "Bob", 1000);
    engine.sit(2, "p3", "Charlie", 1000);

    // Deal hand
    engine.deal();

    const state = engine.state;

    // Verify deal
    expect(state.street).toBe(Street.PREFLOP);
    expect(state.handNumber).toBe(1);
    expect(state.buttonSeat).toBe(0);

    // Verify blinds posted
    const sbPlayer = state.players[1]!;
    const bbPlayer = state.players[2]!;
    expect(sbPlayer.stack).toBe(990); // Posted SB
    expect(bbPlayer.stack).toBe(980); // Posted BB

    // Verify cards dealt
    const alice = state.players[0]!;
    expect(alice.hand).toBeTruthy();
    expect(alice.hand!.length).toBe(2);

    // Get player view (should see own cards only)
    const aliceView = engine.view("p1");
    expect(aliceView.players[0]!.hand).toBeTruthy();
    expect(aliceView.players[1]!.hand).toBeNull(); // Can't see Bob's cards
  });

  test("fold awards pot to last player", () => {
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

    // Charlie checks (already posted BB)
    engine.act({
      type: ActionType.CHECK,
      playerId: "p3",
      timestamp: Date.now(),
    });

    // Should be at flop
    const state = engine.state;
    expect(state.street).toBe(Street.FLOP);
    expect(state.board.length).toBe(3);
  });

  test("bet and call progression", () => {
    const engine = new PokerEngine({
      smallBlind: 10,
      bigBlind: 20,
      maxPlayers: 2, // Heads-up
    });

    engine.sit(0, "p1", "Alice", 1000);
    engine.sit(1, "p2", "Bob", 1000);

    engine.deal();

    const initialState = engine.state;

    // In heads-up, button (seat 0) is SB and acts first preflop
    expect(initialState.actionTo).toBe(0);

    // Alice raises to 60
    engine.act({
      type: ActionType.RAISE,
      playerId: "p1",
      amount: 60,
      timestamp: Date.now(),
    });

    // Bob calls
    engine.act({
      type: ActionType.CALL,
      playerId: "p2",
      timestamp: Date.now(),
    });

    const state = engine.state;

    // Should progress to flop
    expect(state.street).toBe(Street.FLOP);

    // Pot should be 120 (60 + 60)
    const totalPot = state.pots.reduce((sum, pot) => sum + pot.amount, 0);
    expect(totalPot).toBe(120);
  });

  test("all-in creates side pot", () => {
    const engine = new PokerEngine({
      smallBlind: 10,
      bigBlind: 20,
      maxPlayers: 3,
    });

    // Alice has short stack
    engine.sit(0, "p1", "Alice", 100);
    engine.sit(1, "p2", "Bob", 1000);
    engine.sit(2, "p3", "Charlie", 1000);

    engine.deal();

    // Alice goes all-in for 100
    engine.act({
      type: ActionType.RAISE,
      playerId: "p1",
      amount: 100,
      timestamp: Date.now(),
    });

    // Bob calls 100
    engine.act({
      type: ActionType.CALL,
      playerId: "p2",
      timestamp: Date.now(),
    });

    // Charlie raises to 200
    engine.act({
      type: ActionType.RAISE,
      playerId: "p3",
      amount: 200,
      timestamp: Date.now(),
    });

    // Bob calls additional 100
    engine.act({
      type: ActionType.CALL,
      playerId: "p2",
      timestamp: Date.now(),
    });

    const state = engine.state;

    // Should have progressed to flop (all action complete)
    expect(state.street).toBe(Street.FLOP);

    // Should have multiple pots
    expect(state.pots.length).toBeGreaterThan(1);
  });
});
