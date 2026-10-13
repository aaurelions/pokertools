import { PokerEngine } from "../../src/engine/poker-engine";
import { ActionType, PlayerStatus, Street } from "@pokertools/types";

const blindStructure = [{ smallBlind: 5, bigBlind: 10, ante: 0 }];

function makeEngine(tournament: boolean): PokerEngine {
  const engine = new PokerEngine({
    smallBlind: 5,
    bigBlind: 10,
    maxPlayers: 2,
    ...(tournament ? { blindStructure } : {}),
  });
  engine.sit(0, "p0", "Player0", 1000);
  engine.sit(1, "p1", "Player1", 1000);
  return engine;
}

/** Deal a hand and time out whoever is to act; returns that player's seat. */
function timeoutActor(engine: PokerEngine): number {
  engine.deal();
  const seat = engine.state.actionTo!;
  engine.act({ type: ActionType.TIMEOUT, playerId: engine.state.players[seat]!.id });
  expect(engine.state.players[seat]!.isSittingOut).toBe(true);
  return seat;
}

describe.each([
  ["tournament", true],
  ["cash", false],
])("SIT_IN (%s)", (_name, tournament) => {
  test("timeout -> sitting out -> SIT_IN -> dealt in next hand", () => {
    const engine = makeEngine(tournament);
    const seat = timeoutActor(engine);
    const id = engine.state.players[seat]!.id;

    engine.act({ type: ActionType.SIT_IN, playerId: id });
    expect(engine.state.players[seat]!.isSittingOut).toBe(false);

    engine.deal();
    const p = engine.state.players[seat]!;
    expect(p.status).not.toBe(PlayerStatus.FOLDED);
    expect(p.hand).toHaveLength(2);
  });

  test("without SIT_IN the player stays out of the next hand", () => {
    const engine = makeEngine(tournament);
    const seat = timeoutActor(engine);
    if (!tournament) {
      // cash: the sat-out player is not dealt, so there is no hand
      expect(() => engine.deal()).toThrow(/at least 2 players/);
    } else {
      engine.deal();
      expect(engine.state.players[seat]!.status).toBe(PlayerStatus.FOLDED);
    }
    expect(engine.state.players[seat]!.isSittingOut).toBe(true);
  });

  test("SIT_IN does not change the current hand", () => {
    const engine = new PokerEngine({
      smallBlind: 5,
      bigBlind: 10,
      maxPlayers: 3,
      ...(tournament ? { blindStructure } : {}),
    });
    engine.sit(0, "p0", "P0", 1000);
    engine.sit(1, "p1", "P1", 1000);
    engine.sit(2, "p2", "P2", 1000);
    engine.deal();
    const seat = engine.state.actionTo!;
    engine.act({ type: ActionType.TIMEOUT, playerId: engine.state.players[seat]!.id });
    const before = engine.state;
    engine.act({ type: ActionType.SIT_IN, playerId: before.players[seat]!.id });
    const after = engine.state;
    expect(after.players[seat]!.status).toBe(PlayerStatus.FOLDED);
    expect(after.players[seat]!.isSittingOut).toBe(false);
    expect(after.actionTo).toBe(before.actionTo);
    expect(after.board).toEqual(before.board);
    expect(after.street).toBe(before.street);
  });

  test("rejects unknown player and player not sitting out", () => {
    const engine = makeEngine(tournament);
    expect(() => engine.act({ type: ActionType.SIT_IN, playerId: "nobody" })).toThrow();
    expect(() => engine.act({ type: ActionType.SIT_IN, playerId: "p0" })).toThrow(
      /not sitting out/
    );
  });
});

describe("uncontested hands deal no community cards", () => {
  test("tournament heads-up, one player sitting out, other shoves", () => {
    const engine = makeEngine(true);
    timeoutActor(engine);
    engine.deal();
    const actor = engine.state.actionTo!;
    expect(engine.state.players[actor]!.isSittingOut).toBe(false);

    const stack = engine.state.players[actor]!.stack;
    const bet = engine.state.players[actor]!.betThisStreet;
    // Whatever the legal move is, shoving or checking, the hand is uncontested.
    try {
      engine.act({
        type: ActionType.RAISE,
        playerId: engine.state.players[actor]!.id,
        amount: stack + bet,
      });
    } catch {
      engine.act({ type: ActionType.CHECK, playerId: engine.state.players[actor]!.id });
    }

    expect(engine.state.winners).not.toBeNull();
    expect(engine.state.board).toHaveLength(0);
    expect(engine.state.street).not.toBe(Street.FLOP);
    expect(engine.state.winners!.every((w) => w.handRank === "Uncontested")).toBe(true);
    const totalAfter = engine.state.players.reduce((s, p) => s + (p?.stack ?? 0), 0);
    expect(totalAfter).toBe(2000); // chip conservation
  });
});
