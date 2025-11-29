/**
 * Property-based tests for side pot calculation
 */

import * as fc from "fast-check";
import { PokerEngine } from "../../src/engine/PokerEngine";
import { ActionType } from "@pokertools/types";

describe("Side Pot Properties", () => {
  test("total of all pots equals total investments", () => {
    fc.assert(
      fc.property(
        fc.record({
          numPlayers: fc.integer({ min: 2, max: 5 }),
          stacks: fc.array(fc.integer({ min: 50, max: 500 }), { minLength: 2, maxLength: 5 }),
        }),
        (config) => {
          const numPlayers = Math.min(config.numPlayers, config.stacks.length);

          const engine = new PokerEngine({
            smallBlind: 5,
            bigBlind: 10,
            maxPlayers: numPlayers,
          });

          // Seat players with different stacks
          let totalInvested = 0;
          for (let i = 0; i < numPlayers; i++) {
            engine.sit(i, `p${i}`, `Player${i}`, config.stacks[i]);
          }

          engine.deal();

          // Everyone goes all-in or calls
          let safetyCounter = 0;
          while (engine.state.actionTo !== null && safetyCounter < 50) {
            const state = engine.state;
            if (state.actionTo === null) break;

            const player = state.players[state.actionTo];
            if (!player) break;

            try {
              const currentBet = Math.max(...Array.from(state.currentBets.values()));
              const playerBet = state.currentBets.get(state.actionTo) || 0;
              const toCall = currentBet - playerBet;

              if (toCall === 0) {
                engine.act({
                  type: ActionType.CHECK,
                  playerId: player.id,
                  timestamp: Date.now(),
                });
              } else {
                // Call (which might be all-in)
                engine.act({
                  type: ActionType.CALL,
                  playerId: player.id,
                  timestamp: Date.now(),
                });
              }
            } catch {
              break;
            }

            safetyCounter++;
          }

          // Calculate total invested by all players
          const state = engine.state;
          totalInvested = 0;
          for (const player of state.players) {
            if (player) {
              totalInvested += player.totalInvestedThisHand;
            }
          }

          // Calculate total in pots
          const totalInPots = state.pots.reduce((sum, pot) => sum + pot.amount, 0);

          // Total in pots should equal total invested (minus current bets)
          const totalInBets = Array.from(state.currentBets.values()).reduce(
            (sum, bet) => sum + bet,
            0
          );

          // Total invested should equal pots + current bets
          expect(totalInvested).toBe(totalInPots + totalInBets);
        }
      ),
      { numRuns: 50 }
    );
  });

  test("side pots are ordered correctly (main first, then side pots)", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 50, max: 500 }), { minLength: 3, maxLength: 5 }),
        (stacks) => {
          const numPlayers = stacks.length;

          const engine = new PokerEngine({
            smallBlind: 5,
            bigBlind: 10,
            maxPlayers: numPlayers,
          });

          for (let i = 0; i < numPlayers; i++) {
            engine.sit(i, `p${i}`, `Player${i}`, stacks[i]);
          }

          engine.deal();

          // Everyone goes all-in
          let safetyCounter = 0;
          while (engine.state.actionTo !== null && safetyCounter < 50) {
            const state = engine.state;
            if (state.actionTo === null) break;

            const player = state.players[state.actionTo];
            if (!player) break;

            try {
              engine.act({
                type: ActionType.CALL,
                playerId: player.id,
                timestamp: Date.now(),
              });
            } catch {
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

          const state = engine.state;

          // Check pot ordering
          if (state.pots.length > 1) {
            // First pot should be MAIN
            expect(state.pots[0].type).toBe("MAIN");

            // Main pot should have most eligible players
            const _mainPotEligible = state.pots[0].eligibleSeats.length;

            // Each subsequent side pot should have fewer or equal eligible players
            for (let i = 1; i < state.pots.length; i++) {
              expect(state.pots[i].type).toBe("SIDE");
              expect(state.pots[i].eligibleSeats.length).toBeLessThanOrEqual(
                state.pots[i - 1].eligibleSeats.length
              );
            }
          }
        }
      ),
      { numRuns: 30 }
    );
  });

  test("each pot has at least one eligible player", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 50, max: 500 }), { minLength: 2, maxLength: 5 }),
        (stacks) => {
          const numPlayers = stacks.length;

          const engine = new PokerEngine({
            smallBlind: 5,
            bigBlind: 10,
            maxPlayers: numPlayers,
          });

          for (let i = 0; i < numPlayers; i++) {
            engine.sit(i, `p${i}`, `Player${i}`, stacks[i]);
          }

          engine.deal();

          // Play out the hand
          let safetyCounter = 0;
          while (engine.state.actionTo !== null && safetyCounter < 50) {
            const state = engine.state;
            if (state.actionTo === null) break;

            const player = state.players[state.actionTo];
            if (!player) break;

            try {
              const actionChoice = Math.random();
              if (actionChoice < 0.3) {
                engine.act({
                  type: ActionType.FOLD,
                  playerId: player.id,
                  timestamp: Date.now(),
                });
              } else {
                const currentBet = Math.max(...Array.from(state.currentBets.values()));
                const playerBet = state.currentBets.get(state.actionTo) || 0;
                const toCall = currentBet - playerBet;

                if (toCall === 0) {
                  engine.act({
                    type: ActionType.CHECK,
                    playerId: player.id,
                    timestamp: Date.now(),
                  });
                } else if (player.stack >= toCall) {
                  engine.act({
                    type: ActionType.CALL,
                    playerId: player.id,
                    timestamp: Date.now(),
                  });
                } else {
                  engine.act({
                    type: ActionType.FOLD,
                    playerId: player.id,
                    timestamp: Date.now(),
                  });
                }
              }
            } catch {
              break;
            }

            safetyCounter++;
          }

          const state = engine.state;

          // Every pot must have at least one eligible player
          for (const pot of state.pots) {
            expect(pot.eligibleSeats.length).toBeGreaterThan(0);

            // All eligible seats must have valid players
            for (const seat of pot.eligibleSeats) {
              expect(state.players[seat]).toBeTruthy();
            }
          }
        }
      ),
      { numRuns: 50 }
    );
  });

  test("side pot calculation is deterministic", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 50, max: 300 }), { minLength: 3, maxLength: 4 }),
        (stacks) => {
          const numPlayers = stacks.length;

          // Create two identical scenarios
          const engine1 = new PokerEngine({
            smallBlind: 5,
            bigBlind: 10,
            maxPlayers: numPlayers,
            randomProvider: () => 0.5, // Deterministic RNG
          });

          const engine2 = new PokerEngine({
            smallBlind: 5,
            bigBlind: 10,
            maxPlayers: numPlayers,
            randomProvider: () => 0.5, // Same RNG
          });

          // Seat same players
          for (let i = 0; i < numPlayers; i++) {
            engine1.sit(i, `p${i}`, `Player${i}`, stacks[i]);
            engine2.sit(i, `p${i}`, `Player${i}`, stacks[i]);
          }

          // Deal and play identical actions
          engine1.deal();
          engine2.deal();

          // Perform same actions on both engines
          for (let i = 0; i < 3 && engine1.state.actionTo !== null; i++) {
            const player1 = engine1.state.players[engine1.state.actionTo!];
            const player2 = engine2.state.players[engine2.state.actionTo!];

            if (!player1 || !player2) break;

            try {
              // Determine action based on state
              const currentBet = Math.max(...Array.from(engine1.state.currentBets.values()));
              const playerBet = engine1.state.currentBets.get(engine1.state.actionTo!) || 0;
              const toCall = currentBet - playerBet;

              if (toCall === 0) {
                engine1.act({
                  type: ActionType.CHECK,
                  playerId: player1.id,
                  timestamp: Date.now(),
                });
                engine2.act({
                  type: ActionType.CHECK,
                  playerId: player2.id,
                  timestamp: Date.now(),
                });
              } else {
                engine1.act({
                  type: ActionType.CALL,
                  playerId: player1.id,
                  timestamp: Date.now(),
                });
                engine2.act({
                  type: ActionType.CALL,
                  playerId: player2.id,
                  timestamp: Date.now(),
                });
              }
            } catch {
              break;
            }
          }

          // Pot structures should be identical
          expect(engine1.state.pots.length).toBe(engine2.state.pots.length);

          for (let i = 0; i < engine1.state.pots.length; i++) {
            expect(engine1.state.pots[i].amount).toBe(engine2.state.pots[i].amount);
            expect(engine1.state.pots[i].type).toBe(engine2.state.pots[i].type);
            expect(engine1.state.pots[i].eligibleSeats).toEqual(
              engine2.state.pots[i].eligibleSeats
            );
          }
        }
      ),
      { numRuns: 30 }
    );
  });
});
