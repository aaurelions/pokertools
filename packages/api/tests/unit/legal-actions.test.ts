import { describe, it, expect } from "vitest";
import { PokerEngine } from "@pokertools/engine";
import type { ActionType } from "@pokertools/types";
import { getLegalActions } from "../../src/services/legal-actions.js";

const TURN_ID = "table-1:hand-1:0:0";

function seatedEngine(stacks: number[], smallBlind = 5, bigBlind = 10): PokerEngine {
  const engine = new PokerEngine({ smallBlind, bigBlind, maxPlayers: stacks.length });
  stacks.forEach((stack, seat) => {
    engine.sit(seat, `p${seat}`, `P${seat}`, stack);
  });
  engine.deal();
  return engine;
}

function actorId(engine: PokerEngine): string {
  const seat = engine.state.actionTo;
  if (seat === null) throw new Error("No acting seat");
  return engine.state.players[seat]!.id;
}

function familyOf(
  actions: ReturnType<typeof getLegalActions>,
  family: ActionType
): (typeof actions)[number] | undefined {
  return actions.find((action) => action.family === family);
}

describe("getLegalActions", () => {
  it("exposes fold/call/raise preflop with engine-validated BET/RAISE bounds", () => {
    const engine = seatedEngine([1000, 1000, 1000]);
    const principal = actorId(engine);

    const actions = getLegalActions(engine, TURN_ID, principal);
    const families = actions.map((action) => action.family);

    expect(families).toContain("FOLD");
    expect(families).toContain("CALL");
    expect(families).toContain("RAISE");
    expect(families).not.toContain("CHECK");

    const raise = familyOf(actions, "RAISE" as ActionType)!;
    expect(raise.minAmount).toBeDefined();
    expect(raise.maxAmount).toBeDefined();
    expect(raise.minAmount! <= raise.maxAmount!).toBe(true);

    // The engine itself must accept both advertised endpoints.
    expect(
      engine.validate({ type: "RAISE", playerId: principal, amount: raise.minAmount! }).valid
    ).toBe(true);
    expect(
      engine.validate({ type: "RAISE", playerId: principal, amount: raise.maxAmount! }).valid
    ).toBe(true);
  });

  it("scopes every action id to the turn and uses uppercase engine families", () => {
    const engine = seatedEngine([1000, 1000, 1000]);
    const principal = actorId(engine);
    const actions = getLegalActions(engine, TURN_ID, principal);

    for (const action of actions) {
      expect(action.actionId).toBe(`${TURN_ID}:${action.family}`);
      expect(action.family).toBe(action.family.toUpperCase());
    }
  });

  it("returns nothing for a non-actor or an unauthenticated principal", () => {
    const engine = seatedEngine([1000, 1000, 1000]);
    const principal = actorId(engine);
    const other = `p${[0, 1, 2].find((seat) => engine.state.players[seat]?.id !== principal)}`;

    expect(getLegalActions(engine, TURN_ID, other)).toEqual([]);
    expect(getLegalActions(engine, TURN_ID, null)).toEqual([]);
    expect(getLegalActions(engine, "", principal)).toEqual([]);
  });

  it("caps a short all-in raise at the player's maximum wager", () => {
    // Seat 0 is first to act with only 15 chips vs a 20-chip minimum raise-to.
    const engine = seatedEngine([15, 1000, 1000]);
    const principal = actorId(engine);
    expect(principal).toBe("p0");

    const raise = familyOf(getLegalActions(engine, TURN_ID, principal), "RAISE" as ActionType)!;
    expect(raise.minAmount).toBe(15);
    expect(raise.maxAmount).toBe(15);
    expect(engine.validate({ type: "RAISE", playerId: principal, amount: 15 }).valid).toBe(true);
  });

  it("exposes check and bounded BET on an unbet street", () => {
    const engine = seatedEngine([1000, 1000, 1000]);
    engine.act({ type: "CALL", playerId: actorId(engine) });
    engine.act({ type: "CALL", playerId: actorId(engine) });
    engine.act({ type: "CHECK", playerId: actorId(engine) });

    expect(engine.state.street).toBe("FLOP");
    const principal = actorId(engine);
    const actions = getLegalActions(engine, TURN_ID, principal);
    const families = actions.map((action) => action.family);

    expect(families).toContain("CHECK");
    expect(families).toContain("BET");
    expect(families).not.toContain("CALL");

    const bet = familyOf(actions, "BET" as ActionType)!;
    expect(bet.minAmount).toBe(engine.state.bigBlind);
    expect(bet.maxAmount).toBe(engine.state.players[engine.state.actionTo!]!.stack);
    expect(
      engine.validate({ type: "BET", playerId: principal, amount: bet.minAmount! }).valid
    ).toBe(true);
    expect(
      engine.validate({ type: "BET", playerId: principal, amount: bet.maxAmount! }).valid
    ).toBe(true);
  });

  it("does not expose management families through the generic public path", () => {
    const engine = seatedEngine([1000, 1000, 1000]);
    const principal = actorId(engine);
    const families = getLegalActions(engine, TURN_ID, principal).map((action) => action.family);

    expect(families).not.toContain("STAND");
    expect(families).not.toContain("NEXT_BLIND_LEVEL");
    expect(families).not.toContain("SIT");
    expect(families).not.toContain("ADD_CHIPS");
  });

  it("advertises exact, tight betting bounds (one below the minimum is illegal)", () => {
    const engine = seatedEngine([1000, 1000, 1000]);
    const principal = actorId(engine);

    const actions = getLegalActions(engine, TURN_ID, principal);
    const raise = familyOf(actions, "RAISE" as ActionType)!;
    expect(raise.minAmount).toBe(engine.state.minRaise);
    expect(raise.maxAmount).toBe(1000);
    expect(
      engine.validate({ type: "RAISE", playerId: principal, amount: raise.minAmount! }).valid
    ).toBe(true);
    expect(
      engine.validate({ type: "RAISE", playerId: principal, amount: raise.minAmount! - 1 }).valid
    ).toBe(false);
  });

  it("offers server-resolved SHOW/MUCK with a turn-scoped id at a showdown boundary", () => {
    const engine = seatedEngine([1000, 1000, 1000]);
    advanceToShowdown(engine);

    expect(engine.state.street).toBe("SHOWDOWN");
    expect(engine.state.actionTo).toBeNull();

    for (const seat of [0, 1, 2]) {
      const principal = `p${seat}`;
      const actions = getLegalActions(engine, TURN_ID, principal);
      const show = familyOf(actions, "SHOW" as ActionType);
      if (!show) continue;

      expect(show.actionId).toBe(`${TURN_ID}:SHOW`);
      // The server issues the option; the client never selects card indices.
      expect("cardIndices" in show).toBe(false);
      expect(engine.validate({ type: "SHOW", playerId: principal }).valid).toBe(true);
    }

    // SHOW/MUCK are never offered before the showdown boundary.
    const preflop = seatedEngine([1000, 1000, 1000]);
    const preflopFamilies = getLegalActions(preflop, TURN_ID, actorId(preflop)).map(
      (action) => action.family
    );
    expect(preflopFamilies).not.toContain("SHOW");
    expect(preflopFamilies).not.toContain("MUCK");
  });
});

/**
 * Check/call every pending decision until the hand reaches the showdown
 * boundary (`street === "SHOWDOWN"`, `actionTo === null`).
 */
function advanceToShowdown(engine: PokerEngine): void {
  for (let guard = 0; guard < 500; guard += 1) {
    if (engine.state.street === "SHOWDOWN") return;
    const seat = engine.state.actionTo;
    if (seat === null) {
      engine.act({ type: "DEAL" as ActionType });
      continue;
    }
    const principal = engine.state.players[seat]!.id;
    const currentBet = Math.max(0, ...engine.state.currentBets.values());
    const playerBet = engine.state.currentBets.get(seat) ?? 0;
    if (currentBet > playerBet) {
      engine.act({ type: "CALL" as ActionType, playerId: principal });
    } else {
      engine.act({ type: "CHECK" as ActionType, playerId: principal });
    }
  }
  throw new Error("Failed to reach showdown");
}
