import { PokerEngine } from "../../src/engine/poker-engine";
import { ActionType, Street } from "@pokertools/types";
import { calculateTotalChips } from "../../src/utils/invariants";

describe("oversized blind regression", () => {
  test("the reported consecutive-hand sequence never leaves a hand without action or winners", () => {
    const engine = new PokerEngine({
      smallBlind: 2150,
      bigBlind: 4301,
      ante: 0,
      maxPlayers: 3,
      validateIntegrity: true,
    });

    engine.sit(0, "p0", "P1", 100);
    engine.sit(1, "p1", "P2", 100);
    engine.sit(2, "p2", "P3", 5800);

    engine.deal();
    engine.act({ type: ActionType.FOLD, playerId: "p0" });
    engine.act({ type: ActionType.FOLD, playerId: "p2" });

    expect(engine.state.winners).not.toBeNull();
    expect(engine.state.players.map((player) => player?.stack)).toEqual([100, 200, 5700]);

    engine.deal();

    expect(
      engine.state.actionTo === null &&
        !Array.isArray(engine.state.winners) &&
        engine.state.street !== Street.SHOWDOWN
    ).toBe(false);
    expect(engine.state.actionTo).toBe(1);
    expect(calculateTotalChips(engine.state)).toBe(6000);
  });

  test("returns an unmatched folded big blind instead of awarding it to the winner", () => {
    const engine = new PokerEngine({
      smallBlind: 2150,
      bigBlind: 4301,
      ante: 0,
      maxPlayers: 2,
      validateIntegrity: true,
    });

    engine.sit(0, "p0", "P0", 100);
    engine.sit(1, "p1", "P1", 5800);
    engine.deal();
    engine.act({ type: ActionType.FOLD, playerId: "p1" });

    expect(engine.state.players.map((player) => player?.stack)).toEqual([200, 5700]);
    expect(engine.state.winners).toEqual([expect.objectContaining({ seat: 0, amount: 200 })]);
    expect(calculateTotalChips(engine.state)).toBe(5900);
  });

  test("runs out a three-way short-stack hand and permits another deal", () => {
    const engine = new PokerEngine({
      smallBlind: 2150,
      bigBlind: 4301,
      ante: 0,
      maxPlayers: 3,
      validateIntegrity: true,
    });

    engine.sit(0, "p0", "P0", 100);
    engine.sit(1, "p1", "P1", 200);
    engine.sit(2, "p2", "P2", 300);
    engine.deal();

    expect(engine.state.actionTo).toBe(0);
    engine.act({ type: ActionType.CALL, playerId: "p0" });

    expect(engine.state.street).toBe(Street.SHOWDOWN);
    expect(engine.state.board).toHaveLength(5);
    expect(Array.isArray(engine.state.winners)).toBe(true);
    expect(calculateTotalChips(engine.state)).toBe(600);

    const betsFromFinishedHand = engine.state.currentBets;
    expect(betsFromFinishedHand.size).toBe(0);

    if (engine.state.players.filter((player) => player && player.stack > 0).length >= 2) {
      engine.deal();
      expect(engine.state.currentBets).not.toBe(betsFromFinishedHand);
      expect(engine.state.pots).toEqual([]);
      expect(engine.state.actionTo !== null || Array.isArray(engine.state.winners)).toBe(true);
    }
  });

  test("10,000 randomized hands terminate with oversized blinds and conserve chips", () => {
    let seed = 0x18_0b_1a;
    const random = (): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 0x1_0000_0000;
    };

    for (let hand = 0; hand < 10_000; hand++) {
      const playerCount = 2 + Math.floor(random() * 9);
      const stacks = Array.from({ length: playerCount }, () => 1 + Math.floor(random() * 6000));
      const maxStack = Math.max(...stacks);
      const bigBlind = 2 + Math.floor(random() * maxStack * 5);
      const smallBlind = 1 + Math.floor(random() * (bigBlind - 1));
      const initialChips = stacks.reduce((total, stack) => total + stack, 0);
      const engine = new PokerEngine({
        smallBlind,
        bigBlind,
        maxPlayers: playerCount,
        validateIntegrity: true,
        randomProvider: random,
      });

      stacks.forEach((stack, seat) => engine.sit(seat, `p${seat}`, `P${seat}`, stack));
      engine.deal();

      let actions = 0;
      while (engine.state.winners === null && actions < 500) {
        if (engine.state.actionTo === null) {
          throw new Error(
            `hand ${hand} stalled: ${JSON.stringify({
              smallBlind,
              bigBlind,
              stacks,
              street: engine.state.street,
              bets: Array.from(engine.state.currentBets),
              history: engine.state.actionHistory.map((record) => ({
                street: record.street,
                seat: record.seat,
                type: record.action.type,
              })),
              players: engine.state.players.map((player) =>
                player ? { seat: player.seat, stack: player.stack, status: player.status } : null
              ),
            })}`
          );
        }
        const seat = engine.state.actionTo!;
        const player = engine.state.players[seat]!;
        const highestBet = Math.max(0, ...engine.state.currentBets.values());
        const playerBet = engine.state.currentBets.get(seat) ?? 0;
        const activePlayers = engine.state.players.filter(
          (candidate) => candidate?.status === "ACTIVE"
        ).length;
        const action =
          random() < 0.2 && (highestBet > playerBet || activePlayers > 1)
            ? { type: ActionType.FOLD as const, playerId: player.id }
            : highestBet === playerBet
              ? { type: ActionType.CHECK as const, playerId: player.id }
              : { type: ActionType.CALL as const, playerId: player.id };

        const validation = engine.validate(action);
        if (!validation.valid) {
          throw new Error(
            `hand ${hand} rejected generated action: ${JSON.stringify({
              smallBlind,
              bigBlind,
              stacks,
              action,
              validation,
              street: engine.state.street,
              bets: Array.from(engine.state.currentBets),
              invested: engine.state.players.map((player) =>
                player
                  ? {
                      seat: player.seat,
                      status: player.status,
                      invested: player.totalInvestedThisHand,
                    }
                  : null
              ),
            })}`
          );
        }
        engine.act(action);
        expect(calculateTotalChips(engine.state)).toBe(initialChips);
        actions++;
      }

      expect(actions).toBeLessThan(500);
      expect(Array.isArray(engine.state.winners)).toBe(true);
      expect(calculateTotalChips(engine.state)).toBe(initialChips);
    }
  }, 30_000);
});
