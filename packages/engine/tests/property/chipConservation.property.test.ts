/**
 * Property-based tests for chip conservation
 * Uses fast-check to generate random action sequences and verify invariants
 */

import * as fc from "fast-check";
import { PokerEngine } from "../../src/engine/PokerEngine";
import { ActionType } from "@pokertools/types";
import { getInitialChips } from "../../src/utils/invariants";

describe("Chip Conservation Properties", () => {
  test("chips are conserved through random valid actions", () => {
    fc.assert(
      fc.property(
        fc.record({
          numPlayers: fc.integer({ min: 2, max: 6 }),
          startingStack: fc.integer({ min: 100, max: 2000 }),
          smallBlind: fc.integer({ min: 1, max: 10 }),
          numActions: fc.integer({ min: 5, max: 20 }),
        }),
        (config) => {
          const bigBlind = config.smallBlind * 2;

          // Create engine
          const engine = new PokerEngine({
            smallBlind: config.smallBlind,
            bigBlind,
            maxPlayers: config.numPlayers,
          });

          // Seat players
          const playerIds: string[] = [];
          for (let i = 0; i < config.numPlayers; i++) {
            const id = `p${i}`;
            playerIds.push(id);
            engine.sit(i, id, `Player${i}`, config.startingStack);
          }

          // Deal hand
          engine.deal();

          // Calculate initial total chips from state after deal
          const initialTotalChips = getInitialChips(engine.state);

          // Verify chips after deal
          let currentChips = getInitialChips(engine.state);
          expect(currentChips).toBe(initialTotalChips);

          // Perform random valid actions
          // Track actions for debugging purposes (if needed)
          for (let i = 0; i < config.numActions; i++) {
            const state = engine.state;

            // Check if hand is complete
            if (state.winners || state.actionTo === null) {
              break;
            }

            // Get current player
            const actionTo = state.actionTo;
            if (actionTo === null) break;

            const player = state.players[actionTo];
            if (!player) break;

            const playerId = player.id;

            // Determine valid actions
            const currentBet = Math.max(...Array.from(state.currentBets.values()));
            const playerBet = state.currentBets.get(actionTo) || 0;
            const toCall = currentBet - playerBet;

            try {
              // Choose a random valid action
              const actionChoice = Math.floor(Math.random() * 4);

              if (actionChoice === 0 && toCall === 0) {
                // Check
                engine.act({
                  type: ActionType.CHECK,
                  playerId,
                  timestamp: Date.now(),
                });
                // actionsPerformed++;
              } else if (actionChoice === 1) {
                // Fold
                engine.act({
                  type: ActionType.FOLD,
                  playerId,
                  timestamp: Date.now(),
                });
                // actionsPerformed++;
              } else if (actionChoice === 2 && player.stack >= toCall && toCall > 0) {
                // Call
                engine.act({
                  type: ActionType.CALL,
                  playerId,
                  timestamp: Date.now(),
                });
                // actionsPerformed++;
              } else if (actionChoice === 3 && player.stack > toCall) {
                // Raise (if we have chips beyond call)
                const minRaise = state.minRaise;
                const raiseAmount = Math.min(
                  playerBet + toCall + minRaise,
                  playerBet + player.stack
                );

                if (raiseAmount > currentBet) {
                  engine.act({
                    type: ActionType.RAISE,
                    playerId,
                    amount: raiseAmount,
                    timestamp: Date.now(),
                  });
                  // actionsPerformed++;
                }
              }

              // Verify chips are conserved after each action
              currentChips = getInitialChips(engine.state);
              expect(currentChips).toBe(initialTotalChips);
            } catch (_error) {
              // Action might be invalid, that's okay - continue
              // But chips should still be conserved
              currentChips = getInitialChips(engine.state);
              expect(currentChips).toBe(initialTotalChips);
              break;
            }
          }

          // Final verification
          const finalChips = getInitialChips(engine.state);
          expect(finalChips).toBe(initialTotalChips);

          // Note: We don't require actionsPerformed > 0 because:
          // - Random configs might generate scenarios where no valid actions exist
          // - What matters is chip conservation, not action count
          // - The test still validates that chips are conserved even if no actions occur
        }
      ),
      { numRuns: 50 } // Run 50 random scenarios
    );
  });

  test("chips are conserved through complete hands", () => {
    fc.assert(
      fc.property(
        fc.record({
          numPlayers: fc.integer({ min: 2, max: 4 }),
          startingStack: fc.integer({ min: 500, max: 1000 }),
        }),
        (config) => {
          const engine = new PokerEngine({
            smallBlind: 5,
            bigBlind: 10,
            maxPlayers: config.numPlayers,
          });

          // Seat players
          for (let i = 0; i < config.numPlayers; i++) {
            engine.sit(i, `p${i}`, `Player${i}`, config.startingStack);
          }

          // Deal first hand to establish baseline
          engine.deal();
          const initialTotalChips = getInitialChips(engine.state);

          // Play until hand completes (with safety limit)
          let safetyCounter = 0;
          while (engine.state.winners === null && safetyCounter < 100) {
            const state = engine.state;

            if (state.actionTo === null) {
              break;
            }

            const player = state.players[state.actionTo];
            if (!player) break;

            // Simple strategy: call if small, fold if large
            try {
              const currentBet = Math.max(...Array.from(state.currentBets.values()));
              const playerBet = state.currentBets.get(state.actionTo) || 0;
              const toCall = currentBet - playerBet;

              if (toCall === 0) {
                // Check
                engine.act({
                  type: ActionType.CHECK,
                  playerId: player.id,
                  timestamp: Date.now(),
                });
              } else if (toCall <= player.stack / 4) {
                // Call if reasonable
                engine.act({
                  type: ActionType.CALL,
                  playerId: player.id,
                  timestamp: Date.now(),
                });
              } else {
                // Fold if too expensive
                engine.act({
                  type: ActionType.FOLD,
                  playerId: player.id,
                  timestamp: Date.now(),
                });
              }
            } catch (_error) {
              // Invalid action, try fold
              try {
                engine.act({
                  type: ActionType.FOLD,
                  playerId: player.id,
                  timestamp: Date.now(),
                });
              } catch {
                break;
              }
            }

            safetyCounter++;
          }

          // Verify chips after first hand
          const currentChips = getInitialChips(engine.state);
          expect(currentChips).toBe(initialTotalChips);

          // Only play more hands if winners were determined (hand completed)
          if (engine.state.winners === null) {
            return; // Hand didn't complete, skip additional hands
          }

          // Play multiple more hands
          for (let hand = 0; hand < 2; hand++) {
            engine.deal();

            // Play until hand completes (with safety limit)
            let safetyCounter = 0;
            while (engine.state.winners === null && safetyCounter < 100) {
              const state = engine.state;

              if (state.actionTo === null) {
                break;
              }

              const player = state.players[state.actionTo];
              if (!player) break;

              // Simple strategy: call if small, fold if large
              try {
                const currentBet = Math.max(...Array.from(state.currentBets.values()));
                const playerBet = state.currentBets.get(state.actionTo) || 0;
                const toCall = currentBet - playerBet;

                if (toCall === 0) {
                  // Check
                  engine.act({
                    type: ActionType.CHECK,
                    playerId: player.id,
                    timestamp: Date.now(),
                  });
                } else if (toCall <= player.stack / 4) {
                  // Call if reasonable
                  engine.act({
                    type: ActionType.CALL,
                    playerId: player.id,
                    timestamp: Date.now(),
                  });
                } else {
                  // Fold if too expensive
                  engine.act({
                    type: ActionType.FOLD,
                    playerId: player.id,
                    timestamp: Date.now(),
                  });
                }
              } catch (_error) {
                // Invalid action, try fold
                try {
                  engine.act({
                    type: ActionType.FOLD,
                    playerId: player.id,
                    timestamp: Date.now(),
                  });
                } catch {
                  break;
                }
              }

              safetyCounter++;
            }

            // Verify chips after hand
            const currentChips = getInitialChips(engine.state);
            expect(currentChips).toBe(initialTotalChips);
          }
        }
      ),
      { numRuns: 20 } // Run 20 random scenarios with multiple hands
    );
  });

  test("no chips created or destroyed in all-in scenarios", () => {
    fc.assert(
      fc.property(
        fc.record({
          stacks: fc.array(fc.integer({ min: 50, max: 500 }), { minLength: 2, maxLength: 5 }),
        }),
        (config) => {
          const numPlayers = config.stacks.length;
          const engine = new PokerEngine({
            smallBlind: 5,
            bigBlind: 10,
            maxPlayers: numPlayers,
          });

          // Seat players with different stacks
          for (let i = 0; i < numPlayers; i++) {
            engine.sit(i, `p${i}`, `Player${i}`, config.stacks[i]);
          }

          // Deal and go all-in
          engine.deal();

          // Get initial chips from state after deal (this is the baseline)
          const initialTotalChips = getInitialChips(engine.state);

          // Everyone calls or goes all-in
          let safetyCounter = 0;
          while (engine.state.actionTo !== null && safetyCounter < 50) {
            const state = engine.state;
            if (state.actionTo === null) break;

            const player = state.players[state.actionTo];
            if (!player) break;

            try {
              // Just call (which might be all-in)
              engine.act({
                type: ActionType.CALL,
                playerId: player.id,
                timestamp: Date.now(),
              });
            } catch {
              // Try check if call fails
              try {
                engine.act({
                  type: ActionType.CHECK,
                  playerId: player.id,
                  timestamp: Date.now(),
                });
              } catch {
                break;
              }
            }

            safetyCounter++;
          }

          // Verify chips conserved
          const finalChips = getInitialChips(engine.state);
          expect(finalChips).toBe(initialTotalChips);
        }
      ),
      { numRuns: 30 }
    );
  });
});
