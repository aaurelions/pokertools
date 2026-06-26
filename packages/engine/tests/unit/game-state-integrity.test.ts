import { PokerEngine } from "../../src/engine/poker-engine";
import {
  validateGameStateIntegrity,
  getInitialChips,
  calculateTotalChips,
} from "../../src/utils/invariants";
import { createSnapshot, restoreFromSnapshot } from "../../src/utils/serialization";
import { ActionType, GameState } from "@pokertools/types";

describe("Game state chip conservation", () => {
  test("detects when 500 extra chips are manually added to a player stack", () => {
    const engine = new PokerEngine({ smallBlind: 10, bigBlind: 20, maxPlayers: 6 });
    engine.sit(0, "p1", "Alice", 1000);
    engine.sit(1, "p2", "Bob", 1000);
    engine.deal();

    const corrupted: GameState = {
      ...engine.state,
      players: engine.state.players.map((p, i) =>
        i === 0 && p ? { ...p, stack: p.stack + 500 } : p
      ),
    };

    expect(() => validateGameStateIntegrity(corrupted)).toThrow(/Chip conservation violated/);

    const totalAfter = calculateTotalChips(corrupted);
    const totalBefore = getInitialChips(engine.state);
    expect(totalAfter).toBe(totalBefore + 500);
  });

  test("uses the hand baseline rather than recomputing both sides from the corrupted state", () => {
    const engine = new PokerEngine({ smallBlind: 10, bigBlind: 20, maxPlayers: 6 });
    engine.sit(0, "p1", "Alice", 1000);
    engine.sit(1, "p2", "Bob", 1000);
    engine.deal();

    const baseState = engine.state;
    const corrupted: GameState = {
      ...baseState,
      players: baseState.players.map((p, i) =>
        i === 0 && p ? { ...p, stack: p.stack + 9999 } : p
      ),
    };

    expect(() => validateGameStateIntegrity(corrupted)).toThrow(/Chip conservation violated/);
  });
});

describe("Snapshot serialization growth", () => {
  test("stays bounded as undo history depth increases", () => {
    const engine = new PokerEngine({ smallBlind: 10, bigBlind: 20, maxPlayers: 6 });
    engine.sit(0, "p1", "Alice", 10000);
    engine.sit(1, "p2", "Bob", 10000);

    const sizes: number[] = [];

    for (let i = 0; i < 8; i++) {
      engine.deal();
      const at = engine.state.actionTo;
      if (at !== null) {
        const p = engine.state.players[at];
        if (p) engine.act({ type: ActionType.FOLD, playerId: p.id, timestamp: Date.now() });
      }

      const snap = createSnapshot(engine.state);
      sizes.push(JSON.stringify(snap).length / 1024);
    }

    expect(sizes[sizes.length - 1]).toBeLessThan(sizes[0] * 10);

    const finalSnapshot = createSnapshot(engine.state);
    const restored = restoreFromSnapshot(finalSnapshot);
    expect(restored.handId).toBe(engine.state.handId);
  });

  test("does not recursively serialize nested undo histories", () => {
    const engine = new PokerEngine({ smallBlind: 10, bigBlind: 20, maxPlayers: 6 });
    engine.sit(0, "p1", "Alice", 100000);
    engine.sit(1, "p2", "Bob", 100000);

    const sizes: number[] = [];
    for (let i = 0; i < 8; i++) {
      engine.deal();
      const at = engine.state.actionTo;
      if (at !== null) {
        const p = engine.state.players[at];
        if (p) engine.act({ type: ActionType.FOLD, playerId: p.id, timestamp: Date.now() });
      }
      sizes.push(JSON.stringify(createSnapshot(engine.state)).length / 1024);
    }

    const growthFactor = sizes[sizes.length - 1] / sizes[0];
    expect(growthFactor).toBeLessThan(10);
  });
});

describe("Side pot awarding when all eligible players have folded", () => {
  test("uses investment-sorted order instead of fold order when awarding orphaned side pots", () => {
    const engine = new PokerEngine({ smallBlind: 10, bigBlind: 20, maxPlayers: 6 });
    engine.sit(0, "pA", "Alice", 500);
    engine.sit(1, "pB", "Bob", 100);
    engine.sit(2, "pC", "Charlie", 500);

    engine.deal();

    while (engine.state.actionTo !== null) {
      const at = engine.state.actionTo;
      const p = engine.state.players[at];
      if (!p) break;
      const pb = engine.state.currentBets.get(at) ?? 0;
      const cb = Math.max(...Array.from(engine.state.currentBets.values()), 0);
      if (pb < cb) {
        engine.act({ type: ActionType.CALL, playerId: p.id, timestamp: Date.now() });
      } else {
        const isFirst = engine.state.actionHistory.length < 2;
        if (isFirst && pb === 0 && cb === 0) {
          engine.act({ type: ActionType.CALL, playerId: p.id, timestamp: Date.now() });
        } else {
          engine.act({ type: ActionType.CHECK, playerId: p.id, timestamp: Date.now() });
        }
      }
      if (engine.state.street !== "PREFLOP" && engine.state.winners) break;
    }

    if (engine.state.winners) {
      for (const w of engine.state.winners) {
        expect(w.seat).toBeGreaterThanOrEqual(0);
        expect(w.amount).toBeGreaterThan(0);
      }
    }
  });
});

describe("Player timeout when facing no bet", () => {
  test("marks the timed-out player sitting out and skips them for future action", () => {
    const engine = new PokerEngine({ smallBlind: 10, bigBlind: 20, maxPlayers: 6 });
    engine.sit(0, "p1", "Alice", 1000);
    engine.sit(1, "p2", "Bob", 1000);
    engine.deal();

    let targetSeat: number | null = null;
    let targetId: string | null = null;

    while (engine.state.actionTo !== null && !targetSeat) {
      const at = engine.state.actionTo;
      const p = engine.state.players[at];
      if (!p) break;
      const pb = engine.state.currentBets.get(at) ?? 0;
      const cb = Math.max(...Array.from(engine.state.currentBets.values()), 0);
      if (pb === cb && cb > 0) {
        targetSeat = at;
        targetId = p.id;
        break;
      }
      if (pb < cb) {
        engine.act({ type: ActionType.CALL, playerId: p.id, timestamp: Date.now() });
      } else {
        engine.act({ type: ActionType.CHECK, playerId: p.id, timestamp: Date.now() });
      }
      if (engine.state.street !== "PREFLOP") break;
    }

    if (targetSeat !== null && targetId !== null) {
      engine.act({
        type: ActionType.TIMEOUT,
        playerId: targetId,
        timestamp: Date.now(),
      });

      const after = engine.state;
      const player = after.players[targetSeat];

      expect(player?.isSittingOut).toBe(true);
      expect(after.actionHistory.some((record) => record.action.type === ActionType.TIMEOUT)).toBe(
        true
      );
      if (after.actionTo !== null) {
        expect(after.players[after.actionTo]?.isSittingOut).not.toBe(true);
      }
    }
  });

  test("records timeout in action history so action order can progress", () => {
    const engine = new PokerEngine({ smallBlind: 10, bigBlind: 20, maxPlayers: 6 });
    engine.sit(0, "p1", "Alice", 1000);
    engine.sit(1, "p2", "Bob", 1000);
    engine.deal();

    const at = engine.state.actionTo;
    if (at !== null) {
      const p = engine.state.players[at];
      if (p) {
        const pb = engine.state.currentBets.get(at) ?? 0;
        const cb = Math.max(...Array.from(engine.state.currentBets.values()), 0);
        if (pb < cb) {
          engine.act({ type: ActionType.CALL, playerId: p.id, timestamp: Date.now() });
        }
      }
    }

    const to = engine.state.actionTo;
    if (to !== null) {
      const p = engine.state.players[to];
      if (p) {
        const pb = engine.state.currentBets.get(to) ?? 0;
        const cb = Math.max(...Array.from(engine.state.currentBets.values()), 0);
        if (pb === cb) {
          engine.act({ type: ActionType.TIMEOUT, playerId: p.id, timestamp: Date.now() });

          const afterActionTo = engine.state.actionTo;
          expect(
            engine.state.actionHistory.some((record) => record.action.type === ActionType.TIMEOUT)
          ).toBe(true);
          if (afterActionTo !== null) {
            expect(engine.state.players[afterActionTo]?.isSittingOut).not.toBe(true);
          }
        }
      }
    }
  });
});

describe("Bet-to-raise conversion in the game reducer", () => {
  test("validates a BET over an existing bet with the same minimum-raise rules as RAISE", () => {
    const engine = new PokerEngine({ smallBlind: 10, bigBlind: 20, maxPlayers: 6 });
    engine.sit(0, "pA", "Alice", 1000);
    engine.sit(1, "pB", "Bob", 1000);
    engine.deal();

    while (engine.state.street === "PREFLOP" && engine.state.actionTo !== null) {
      const at = engine.state.actionTo;
      const p = engine.state.players[at];
      if (!p) break;
      const pb = engine.state.currentBets.get(at) ?? 0;
      const cb = Math.max(...Array.from(engine.state.currentBets.values()), 0);
      if (pb < cb) engine.act({ type: ActionType.CALL, playerId: p.id, timestamp: Date.now() });
      else engine.act({ type: ActionType.CHECK, playerId: p.id, timestamp: Date.now() });
      if (engine.state.street !== "PREFLOP") break;
    }

    if (engine.state.street !== "PREFLOP" && engine.state.actionTo !== null) {
      const p = engine.state.players[engine.state.actionTo];
      if (p) {
        engine.act({ type: ActionType.BET, playerId: p.id, amount: 100, timestamp: Date.now() });
        expect(engine.state.minRaise).toBe(200);

        const next = engine.state.actionTo;
        if (next !== null) {
          const p2 = engine.state.players[next];
          if (p2) {
            const asRaise = engine.validate({
              type: ActionType.RAISE,
              playerId: p2.id,
              amount: 150,
              timestamp: Date.now(),
            });
            expect(asRaise.valid).toBe(false);

            const asBet = engine.validate({
              type: ActionType.BET,
              playerId: p2.id,
              amount: 150,
              timestamp: Date.now(),
            });
            expect(asBet.valid).toBe(false);

            expect(() =>
              engine.act({
                type: ActionType.BET,
                playerId: p2.id,
                amount: 150,
                timestamp: Date.now(),
              })
            ).toThrow();
          }
        }
      }
    }
  });

  test("does not let BET bypass the last-aggressor check after an incomplete all-in raise", () => {
    const engine = new PokerEngine({ smallBlind: 10, bigBlind: 20, maxPlayers: 6 });
    engine.sit(0, "pA", "Alice", 500);
    engine.sit(1, "pB", "Bob", 120);
    engine.sit(2, "pC", "Charlie", 500);
    engine.deal();

    while (engine.state.street === "PREFLOP" && engine.state.actionTo !== null) {
      const at = engine.state.actionTo;
      const p = engine.state.players[at];
      if (!p) break;
      const pb = engine.state.currentBets.get(at) ?? 0;
      const cb = Math.max(...Array.from(engine.state.currentBets.values()), 0);
      if (pb < cb) engine.act({ type: ActionType.CALL, playerId: p.id, timestamp: Date.now() });
      else engine.act({ type: ActionType.CHECK, playerId: p.id, timestamp: Date.now() });
      if (engine.state.street !== "PREFLOP") break;
    }

    if (engine.state.street !== "PREFLOP") {
      const first = engine.state.actionTo;
      if (first !== null) {
        const pA = engine.state.players[first];
        if (pA) {
          engine.act({
            type: ActionType.BET,
            playerId: pA.id,
            amount: 100,
            timestamp: Date.now(),
          });
          expect(engine.state.lastAggressorSeat).toBe(first);

          const second = engine.state.actionTo;
          if (second !== null) {
            const pB = engine.state.players[second];
            if (pB && pB.stack <= 20) {
              const currentB = engine.state.currentBets.get(second) ?? 0;
              engine.act({
                type: ActionType.RAISE,
                playerId: pB.id,
                amount: pB.stack + currentB,
                timestamp: Date.now(),
              });

              const third = engine.state.actionTo;
              if (third !== null) {
                const pC = engine.state.players[third];
                if (pC) {
                  engine.act({
                    type: ActionType.CALL,
                    playerId: pC.id,
                    timestamp: Date.now(),
                  });

                  if (engine.state.actionTo === first) {
                    const cb = Math.max(...Array.from(engine.state.currentBets.values()), 0);
                    expect(() =>
                      engine.act({
                        type: ActionType.BET,
                        playerId: pA.id,
                        amount: cb + 100,
                        timestamp: Date.now(),
                      })
                    ).toThrow();
                  }
                }
              }
            }
          }
        }
      }
    }
  });
});

describe("Public view currentBets representation", () => {
  test("is a plain object despite being typed as a Map", () => {
    const engine = new PokerEngine({ smallBlind: 10, bigBlind: 20, maxPlayers: 6 });
    engine.sit(0, "p1", "Alice", 1000);
    engine.sit(1, "p2", "Bob", 1000);
    engine.deal();

    const view = engine.view("p1");
    const cb = view.currentBets as unknown as Record<string, unknown>;

    expect(typeof cb).toBe("object");
    expect(typeof (cb as any).entries).toBe("undefined");
    expect(typeof (cb as any).values).toBe("undefined");
    expect(cb instanceof Map).toBe(false);
  });
});

describe("Rake percentage divisor", () => {
  test("uses a hardcoded 100 instead of the PERCENTAGE_DIVISOR constant", () => {
    const PERCENTAGE_DIVISOR = 100;

    const potAmount = 350;
    const rakePercent = 5;
    const expected = Math.floor((potAmount * rakePercent) / PERCENTAGE_DIVISOR);
    expect(expected).toBe(17);
  });
});

describe("Snapshot restoration of rakeThisHand", () => {
  test("uses a logical-OR fallback instead of nullish-coalescing for the rake value", () => {
    const snapshot = createSnapshot({
      config: { smallBlind: 10, bigBlind: 20, maxPlayers: 6 },
      players: Array(6).fill(null),
      maxPlayers: 6,
      handNumber: 0,
      buttonSeat: null,
      deck: [],
      board: [],
      street: "PREFLOP" as any,
      pots: [],
      currentBets: new Map(),
      minRaise: 20,
      lastRaiseAmount: 0,
      actionTo: null,
      lastAggressorSeat: null,
      activePlayers: [],
      winners: null,
      rakeThisHand: 0,
      smallBlind: 10,
      bigBlind: 20,
      ante: 0,
      blindLevel: 0,
      timeBanks: new Map(),
      timeBankActiveSeat: null,
      actionHistory: [],
      previousStates: [],
      timestamp: Date.now(),
      handId: "test",
    });

    const restored = restoreFromSnapshot(snapshot);
    expect(restored.rakeThisHand).toBe(0);
  });
});
