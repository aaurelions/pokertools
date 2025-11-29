import { PokerEngine } from "../../src/engine/PokerEngine";
import { ActionType } from "@pokertools/types";
import { getInitialChips } from "../../src/utils/invariants";

describe("Debug 298 chip bug", () => {
  test("reproduce 3 player 298 chip bug", () => {
    const engine = new PokerEngine({
      smallBlind: 1,
      bigBlind: 2,
      maxPlayers: 3,
      randomProvider: () => 0.5, // Deterministic
    });

    // Seat 3 players with 100 each
    engine.sit(0, "p0", "Player0", 100);
    engine.sit(1, "p1", "Player1", 100);
    engine.sit(2, "p2", "Player2", 100);

    expect(getInitialChips(engine.state)).toBe(300);

    engine.deal();
    expect(getInitialChips(engine.state)).toBe(300);

    // Perform some actions
    for (let i = 0; i < 17 && engine.state.actionTo !== null; i++) {
      const state = engine.state;
      const actionTo = state.actionTo;
      if (actionTo === null) break;

      const player = state.players[actionTo];
      if (!player) break;

      // Randomly choose actions
      const actionChoice = i % 4;
      const currentBet = Math.max(...Array.from(state.currentBets.values()));
      const playerBet = state.currentBets.get(actionTo) || 0;
      const toCall = currentBet - playerBet;

      try {
        if (actionChoice === 0 && toCall === 0) {
          // Check
          engine.act({
            type: ActionType.CHECK,
            playerId: player.id,
            timestamp: Date.now(),
          });
        } else if (actionChoice === 1) {
          // Fold
          engine.act({
            type: ActionType.FOLD,
            playerId: player.id,
            timestamp: Date.now(),
          });
        } else if (actionChoice === 2 && player.stack >= toCall && toCall > 0) {
          // Call
          engine.act({
            type: ActionType.CALL,
            playerId: player.id,
            timestamp: Date.now(),
          });
        } else if (actionChoice === 3 && player.stack > toCall) {
          // Raise
          const minRaise = state.minRaise;
          const raiseAmount = Math.min(playerBet + toCall + minRaise, playerBet + player.stack);

          if (raiseAmount > currentBet) {
            engine.act({
              type: ActionType.RAISE,
              playerId: player.id,
              amount: raiseAmount,
              timestamp: Date.now(),
            });
          } else {
            continue;
          }
        } else {
          continue;
        }

        // Check chips after each action
        const chipsNow = getInitialChips(engine.state);
        if (chipsNow !== 300) {
          throw new Error(`Chips lost: ${300 - chipsNow}`);
        }
      } catch (_error) {
        break;
      }
    }

    const finalChips = getInitialChips(engine.state);
    expect(finalChips).toBe(300);
  });
});
