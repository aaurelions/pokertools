import { ActionType, ErrorCodes, PlayerStatus } from "@pokertools/types";
import { PokerEngine } from "../../src/engine/poker-engine";

function seededRandom(initialSeed: number): () => number {
  let seed = initialSeed;
  return () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 0x1_0000_0000;
  };
}

describe("rules audit regressions", () => {
  test("a short all-in big blind does not lower the full preflop bring-in", () => {
    const engine = new PokerEngine({
      smallBlind: 10,
      bigBlind: 20,
      maxPlayers: 4,
      randomProvider: seededRandom(1),
    });
    engine.sit(0, "button", "Button", 1000);
    engine.sit(1, "small", "Small blind", 1000);
    engine.sit(2, "big", "Big blind", 5);
    engine.sit(3, "utg", "UTG", 1000);
    engine.deal();

    engine.act({ type: ActionType.CALL, playerId: "utg" });
    engine.act({ type: ActionType.CALL, playerId: "button" });
    engine.act({ type: ActionType.CALL, playerId: "small" });

    expect(engine.state.players[3]!.totalInvestedThisHand).toBe(20);
    expect(engine.state.players[0]!.totalInvestedThisHand).toBe(20);
    expect(engine.state.players[1]!.totalInvestedThisHand).toBe(20);
    expect(engine.state.players[2]!.totalInvestedThisHand).toBe(5);
    while (engine.state.winners === null) {
      const player = engine.state.players[engine.state.actionTo!]!;
      engine.act({ type: ActionType.CHECK, playerId: player.id });
    }
    expect(engine.state.winners!.reduce((total, winner) => total + winner.amount, 0)).toBe(65);
  });

  test("the first tied hand left of the button receives an odd chip", () => {
    const engine = new PokerEngine({
      smallBlind: 1,
      bigBlind: 2,
      maxPlayers: 3,
      randomProvider: seededRandom(11),
    });
    engine.sit(0, "button", "Button", 100);
    engine.sit(1, "small", "Small blind", 100);
    engine.sit(2, "big", "Big blind", 100);
    engine.deal();

    engine.act({ type: ActionType.CALL, playerId: "button" });
    engine.act({ type: ActionType.FOLD, playerId: "small" });
    engine.act({ type: ActionType.CHECK, playerId: "big" });
    while (engine.state.winners === null) {
      const player = engine.state.players[engine.state.actionTo!]!;
      engine.act({ type: ActionType.CHECK, playerId: player.id });
    }

    const awards = new Map<number, number>();
    for (const winner of engine.state.winners) {
      awards.set(winner.seat, (awards.get(winner.seat) ?? 0) + winner.amount);
    }
    expect(awards.get(0)).toBe(2);
    expect(awards.get(2)).toBe(3);
  });

  test("the button is adjusted when play becomes heads-up so nobody posts consecutive big blinds", () => {
    const engine = new PokerEngine({ smallBlind: 10, bigBlind: 20, maxPlayers: 3 });
    engine.sit(0, "button", "Button", 1000);
    engine.sit(1, "small", "Small blind", 1000);
    engine.sit(2, "big", "Big blind", 1000);
    engine.deal();
    engine.act({ type: ActionType.FOLD, playerId: "button" });
    engine.act({ type: ActionType.FOLD, playerId: "small" });
    engine.stand("button");

    engine.deal();

    expect(engine.state.buttonSeat).toBe(2);
    expect(engine.state.currentBets.get(2)).toBe(10);
    expect(engine.state.currentBets.get(1)).toBe(20);
  });

  test("standing out of turn preserves the current actor and committed chips", () => {
    const engine = new PokerEngine({
      smallBlind: 10,
      bigBlind: 20,
      maxPlayers: 3,
      randomProvider: seededRandom(2),
    });
    engine.sit(0, "raiser", "Raiser", 1000);
    engine.sit(1, "small", "Small blind", 1000);
    engine.sit(2, "big", "Big blind", 1000);
    engine.deal();
    engine.act({ type: ActionType.RAISE, playerId: "raiser", amount: 100 });

    engine.stand("raiser");

    expect(engine.state.actionTo).toBe(1);
    expect(engine.state.players[0]).toMatchObject({
      status: PlayerStatus.FOLDED,
      stack: 0,
      totalInvestedThisHand: 100,
    });
    engine.act({ type: ActionType.CALL, playerId: "small" });
    engine.act({ type: ActionType.CALL, playerId: "big" });
    while (engine.state.winners === null) {
      const player = engine.state.players[engine.state.actionTo!]!;
      engine.act({ type: ActionType.CHECK, playerId: player.id });
    }
    expect(engine.state.winners.reduce((total, winner) => total + winner.amount, 0)).toBe(300);

    engine.deal();
    expect(engine.state.players[0]).toBeNull();
  });

  test("an all-in player cannot stand before the hand is settled", () => {
    const engine = new PokerEngine({ smallBlind: 10, bigBlind: 20, maxPlayers: 3 });
    engine.sit(0, "all-in", "All-in", 100);
    engine.sit(1, "small", "Small blind", 1000);
    engine.sit(2, "big", "Big blind", 1000);
    engine.deal();
    engine.act({ type: ActionType.RAISE, playerId: "all-in", amount: 100 });

    expect(engine.validate({ type: ActionType.STAND, playerId: "all-in" })).toMatchObject({
      valid: false,
      code: ErrorCodes.INVALID_ACTION,
    });
    expect(() => engine.stand("all-in")).toThrow("all-in");
    expect(engine.state.players[0]).toMatchObject({
      status: PlayerStatus.ALL_IN,
      totalInvestedThisHand: 100,
    });
  });

  test("all live hands are revealed when betting ends with an all-in", () => {
    const engine = new PokerEngine({
      smallBlind: 10,
      bigBlind: 20,
      maxPlayers: 3,
      randomProvider: seededRandom(3),
    });
    engine.sit(0, "short", "Short", 100);
    engine.sit(1, "small", "Small blind", 1000);
    engine.sit(2, "big", "Big blind", 1000);
    engine.deal();
    engine.act({ type: ActionType.RAISE, playerId: "short", amount: 100 });
    engine.act({ type: ActionType.CALL, playerId: "small" });
    engine.act({ type: ActionType.CALL, playerId: "big" });
    while (engine.state.winners === null) {
      const player = engine.state.players[engine.state.actionTo!]!;
      engine.act({ type: ActionType.CHECK, playerId: player.id });
    }

    for (const player of engine.state.players) {
      expect(player!.shownCards).toEqual([0, 1]);
    }
  });
});
