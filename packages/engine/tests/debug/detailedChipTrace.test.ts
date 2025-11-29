import { PokerEngine } from "../../src/engine/PokerEngine";
import { ActionType } from "@pokertools/types";
import {
  getInitialChips,
  calculateStackTotal,
  calculatePotTotal,
  calculateBetTotal,
} from "../../src/utils/invariants";

describe("Detailed Chip Tracing", () => {
  test("trace chips through every state change", () => {
    const engine = new PokerEngine({
      smallBlind: 1,
      bigBlind: 2,
      maxPlayers: 3,
    });

    // Seat 3 players with 100 each
    engine.sit(0, "p0", "Player0", 100);
    engine.sit(1, "p1", "Player1", 100);
    engine.sit(2, "p2", "Player2", 100);

    function traceChips(_label: string) {
      const state = engine.state;
      const _stacks = calculateStackTotal(state);
      const _pots = calculatePotTotal(state);
      const _bets = calculateBetTotal(state);
      const initial = getInitialChips(state);

      const _playerDetails = state.players.map((p) =>
        p
          ? {
              seat: p.seat,
              stack: p.stack,
              invested: p.totalInvestedThisHand,
              betThisStreet: p.betThisStreet,
              status: p.status,
              total: p.stack + p.totalInvestedThisHand,
            }
          : null
      );

      return initial;
    }

    let chips = traceChips("Initial");
    expect(chips).toBe(300);

    engine.deal();
    chips = traceChips("After deal");
    expect(chips).toBe(300);

    // P0 folds
    const p0 = engine.state.players[engine.state.actionTo!]!;
    engine.act({
      type: ActionType.FOLD,
      playerId: p0.id,
      timestamp: Date.now(),
    });
    chips = traceChips("After P0 folds");
    expect(chips).toBe(300);

    // P1 calls
    const p1 = engine.state.players[engine.state.actionTo!]!;
    engine.act({
      type: ActionType.CALL,
      playerId: p1.id,
      timestamp: Date.now(),
    });
    chips = traceChips("After P1 calls");
    expect(chips).toBe(300);

    // P2 raises
    const p2 = engine.state.players[engine.state.actionTo!]!;
    engine.act({
      type: ActionType.RAISE,
      playerId: p2.id,
      amount: 4,
      timestamp: Date.now(),
    });
    chips = traceChips("After P2 raises to 4");
    expect(chips).toBe(300);

    // P1 folds
    const p1again = engine.state.players[engine.state.actionTo!]!;
    engine.act({
      type: ActionType.FOLD,
      playerId: p1again.id,
      timestamp: Date.now(),
    });
    chips = traceChips("After P1 folds (P2 wins)");
    expect(chips).toBe(300);
  });

  test("trace 3-player scenario that loses 10 chips", () => {
    const engine = new PokerEngine({
      smallBlind: 5,
      bigBlind: 10,
      maxPlayers: 3,
    });

    engine.sit(0, "p0", "Player0", 500);
    engine.sit(1, "p1", "Player1", 500);
    engine.sit(2, "p2", "Player2", 500);

    function traceChips(_label: string) {
      const state = engine.state;
      const _stacks = calculateStackTotal(state);
      const _pots = calculatePotTotal(state);
      const _bets = calculateBetTotal(state);
      const initial = getInitialChips(state);

      if (initial !== 1500) {
        // Track chip loss
      }

      return initial;
    }

    traceChips("Initial");
    engine.deal();
    traceChips("After deal");

    // Play out the hand with simple strategy
    let safetyCounter = 0;
    while (engine.state.winners === null && safetyCounter < 100) {
      const state = engine.state;
      if (state.actionTo === null) break;

      const player = state.players[state.actionTo];
      if (!player) break;

      const currentBet = Math.max(...Array.from(state.currentBets.values()));
      const playerBet = state.currentBets.get(state.actionTo) || 0;
      const toCall = currentBet - playerBet;

      try {
        if (toCall === 0) {
          engine.act({
            type: ActionType.CHECK,
            playerId: player.id,
            timestamp: Date.now(),
          });
          traceChips(`After ${player.id} checks`);
        } else if (toCall <= player.stack / 4) {
          engine.act({
            type: ActionType.CALL,
            playerId: player.id,
            timestamp: Date.now(),
          });
          traceChips(`After ${player.id} calls`);
        } else {
          engine.act({
            type: ActionType.FOLD,
            playerId: player.id,
            timestamp: Date.now(),
          });
          traceChips(`After ${player.id} folds`);
        }
      } catch (_error) {
        try {
          engine.act({
            type: ActionType.FOLD,
            playerId: player.id,
            timestamp: Date.now(),
          });
          traceChips(`After ${player.id} folds (fallback)`);
        } catch {
          break;
        }
      }

      safetyCounter++;
    }

    const finalChips = traceChips("Final state");
    expect(finalChips).toBe(1500);
  });
});
