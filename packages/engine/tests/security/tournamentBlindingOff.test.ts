import { PokerEngine } from "../../src/engine/PokerEngine";
import { ActionType, PlayerStatus } from "@pokertools/types";
import { getInitialChips } from "../../src/utils/invariants";

describe("Tournament Security: Blinding Off Exploit Prevention", () => {
  test("sitting-out players MUST pay small blind in tournaments", () => {
    const engine = new PokerEngine({
      smallBlind: 25,
      bigBlind: 50,
      maxPlayers: 3,
      blindStructure: [
        { smallBlind: 25, bigBlind: 50, ante: 0 },
        { smallBlind: 50, bigBlind: 100, ante: 0 },
      ],
    });

    engine.sit(0, "p0", "Player0", 1000);
    engine.sit(1, "p1", "Player1", 1000);
    engine.sit(2, "p2", "Player2", 1000);

    // Manually set P1 as sitting out (will be SB)
    (engine.state.players as any)[1] = {
      ...engine.state.players[1]!,
      isSittingOut: true,
    };

    const stackBeforeDeal = engine.state.players[1]!.stack;

    engine.deal();

    // P1 should have posted SB even though sitting out
    const p1 = engine.state.players[1]!;
    expect(p1.stack).toBe(stackBeforeDeal - 25); // Lost SB
    expect(p1.betThisStreet).toBe(25);
    expect(p1.status).toBe(PlayerStatus.FOLDED); // Auto-folded after posting
  });

  test("sitting-out players MUST pay big blind in tournaments", () => {
    const engine = new PokerEngine({
      smallBlind: 25,
      bigBlind: 50,
      maxPlayers: 3,
      blindStructure: [{ smallBlind: 25, bigBlind: 50, ante: 0 }],
    });

    engine.sit(0, "p0", "Player0", 1000);
    engine.sit(1, "p1", "Player1", 1000);
    engine.sit(2, "p2", "Player2", 1000);

    // Manually set P2 as sitting out (will be BB)
    (engine.state.players as any)[2] = {
      ...engine.state.players[2]!,
      isSittingOut: true,
    };

    const stackBeforeDeal = engine.state.players[2]!.stack;

    engine.deal();

    // P2 should have posted BB even though sitting out
    const p2 = engine.state.players[2]!;
    expect(p2.stack).toBe(stackBeforeDeal - 50); // Lost BB
    expect(p2.betThisStreet).toBe(50);
    expect(p2.status).toBe(PlayerStatus.FOLDED); // Auto-folded after posting
  });

  test("sitting-out players MUST pay antes in tournaments", () => {
    const engine = new PokerEngine({
      smallBlind: 25,
      bigBlind: 50,
      maxPlayers: 3,
      blindStructure: [{ smallBlind: 25, bigBlind: 50, ante: 10 }],
    });

    engine.sit(0, "p0", "Player0", 1000);
    engine.sit(1, "p1", "Player1", 1000);
    engine.sit(2, "p2", "Player2", 1000);

    // Manually set P0 as sitting out
    (engine.state.players as any)[0] = {
      ...engine.state.players[0]!,
      isSittingOut: true,
    };

    const stackBeforeDeal = engine.state.players[0]!.stack;

    engine.deal();

    // P0 should have posted ante even though sitting out
    const p0 = engine.state.players[0]!;
    expect(p0.stack).toBe(stackBeforeDeal - 10); // Lost ante
    expect(p0.betThisStreet).toBe(10);
    expect(p0.status).toBe(PlayerStatus.FOLDED); // Auto-folded after posting
  });

  test("cash game: sitting-out SB does NOT post (Dead Small Blind)", () => {
    const engine = new PokerEngine({
      smallBlind: 5,
      bigBlind: 10,
      maxPlayers: 3,
      // No blindStructure = cash game
    });

    engine.sit(0, "p0", "Player0", 1000);
    engine.sit(1, "p1", "Player1", 1000);
    engine.sit(2, "p2", "Player2", 1000);

    // Manually set P1 as sitting out (will be SB)
    (engine.state.players as any)[1] = {
      ...engine.state.players[1]!,
      isSittingOut: true,
    };

    const stackBeforeDeal = engine.state.players[1]!.stack;

    engine.deal();

    // In cash game, sitting-out SB does NOT post (Dead Small Blind rule)
    const p1 = engine.state.players[1]!;
    expect(p1.stack).toBe(stackBeforeDeal); // No blind posted
    expect(p1.betThisStreet).toBe(0);
  });

  test("tournament integrity: sitting-out player bleeds chips over multiple hands", () => {
    const engine = new PokerEngine({
      smallBlind: 50,
      bigBlind: 100,
      maxPlayers: 3,
      blindStructure: [{ smallBlind: 50, bigBlind: 100, ante: 25 }],
    });

    engine.sit(0, "p0", "Player0", 1000);
    engine.sit(1, "p1", "Player1", 1000);
    engine.sit(2, "p2", "Player2", 1000);

    // Manually set P2 as sitting out
    (engine.state.players as any)[2] = {
      ...engine.state.players[2]!,
      isSittingOut: true,
    };

    const initialStack = engine.state.players[2]!.stack;
    let chipsLost = 0;

    // Play 3 hands - P2 should pay blinds/antes each hand
    for (let i = 0; i < 3; i++) {
      const stackBefore = engine.state.players[2]!.stack;
      engine.deal();

      // Other players fold to end hand quickly
      const p0 = engine.state.players[0]!;
      const p1 = engine.state.players[1]!;

      if (engine.state.actionTo === 0) {
        engine.act({ type: ActionType.FOLD, playerId: p0.id });
      } else if (engine.state.actionTo === 1) {
        engine.act({ type: ActionType.FOLD, playerId: p1.id });
      }

      const stackAfter = engine.state.players[2]!.stack;
      chipsLost += stackBefore - stackAfter;
    }

    // P2 should have lost chips despite sitting out
    expect(chipsLost).toBeGreaterThan(0);
    expect(engine.state.players[2]!.stack).toBeLessThan(initialStack);

    // Chip conservation still holds
    expect(getInitialChips(engine.state)).toBe(3000);
  });
});
