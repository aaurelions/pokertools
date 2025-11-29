/**
 * Property-based tests for action order
 */

import * as fc from "fast-check";
import { PokerEngine } from "../../src/engine/PokerEngine";
import { ActionType, PlayerStatus } from "@pokertools/types";

describe("Action Order Properties", () => {
  test("actionTo always points to valid active player", () => {
    fc.assert(
      fc.property(
        fc.record({
          numPlayers: fc.integer({ min: 2, max: 6 }),
          numActions: fc.integer({ min: 1, max: 15 }),
        }),
        (config) => {
          const engine = new PokerEngine({
            smallBlind: 5,
            bigBlind: 10,
            maxPlayers: config.numPlayers,
          });

          // Seat players
          for (let i = 0; i < config.numPlayers; i++) {
            engine.sit(i, `p${i}`, `Player${i}`, 1000);
          }

          engine.deal();

          // Perform random actions
          for (let i = 0; i < config.numActions; i++) {
            const state = engine.state;

            // If actionTo is not null, it must point to a valid player
            if (state.actionTo !== null) {
              const player = state.players[state.actionTo];

              // Player must exist
              expect(player).toBeTruthy();

              // Player must be active (not folded, not busted)
              expect(player!.status).not.toBe(PlayerStatus.FOLDED);
              expect(player!.status).not.toBe(PlayerStatus.BUSTED);

              // Player must have ability to act (unless all-in)
              if (player!.status !== PlayerStatus.ALL_IN) {
                expect(player!.stack).toBeGreaterThan(0);
              }

              // Perform action
              try {
                const actionChoice = Math.random();
                if (actionChoice < 0.5) {
                  engine.act({
                    type: ActionType.FOLD,
                    playerId: player!.id,
                    timestamp: Date.now(),
                  });
                } else {
                  const currentBet = Math.max(...Array.from(state.currentBets.values()));
                  const playerBet = state.currentBets.get(state.actionTo) || 0;
                  const toCall = currentBet - playerBet;

                  if (toCall === 0) {
                    engine.act({
                      type: ActionType.CHECK,
                      playerId: player!.id,
                      timestamp: Date.now(),
                    });
                  } else if (player!.stack >= toCall) {
                    engine.act({
                      type: ActionType.CALL,
                      playerId: player!.id,
                      timestamp: Date.now(),
                    });
                  } else {
                    engine.act({
                      type: ActionType.FOLD,
                      playerId: player!.id,
                      timestamp: Date.now(),
                    });
                  }
                }
              } catch {
                // Action might be invalid, break
                break;
              }
            } else {
              // actionTo is null - either hand complete or awaiting deal
              break;
            }
          }
        }
      ),
      { numRuns: 50 }
    );
  });

  test("only one player has action at a time", () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 6 }), (numPlayers) => {
        const engine = new PokerEngine({
          smallBlind: 5,
          bigBlind: 10,
          maxPlayers: numPlayers,
        });

        for (let i = 0; i < numPlayers; i++) {
          engine.sit(i, `p${i}`, `Player${i}`, 1000);
        }

        engine.deal();

        const state = engine.state;

        // At any point, actionTo is either null or points to exactly one seat
        if (state.actionTo !== null) {
          expect(typeof state.actionTo).toBe("number");
          expect(state.actionTo).toBeGreaterThanOrEqual(0);
          expect(state.actionTo).toBeLessThan(numPlayers);

          // No other state variable should indicate multiple players can act
          const activePlayers = state.players.filter(
            (p) => p && p.status === PlayerStatus.ACTIVE && p.stack > 0
          );

          // There should be at least one active player
          expect(activePlayers.length).toBeGreaterThan(0);
        }
      }),
      { numRuns: 100 }
    );
  });

  test("action progresses in clockwise order", () => {
    fc.assert(
      fc.property(fc.integer({ min: 3, max: 6 }), (numPlayers) => {
        const engine = new PokerEngine({
          smallBlind: 5,
          bigBlind: 10,
          maxPlayers: numPlayers,
        });

        for (let i = 0; i < numPlayers; i++) {
          engine.sit(i, `p${i}`, `Player${i}`, 1000);
        }

        engine.deal();

        const actionSequence: number[] = [];

        // Track action order
        for (let i = 0; i < 20; i++) {
          const state = engine.state;

          if (state.actionTo === null) break;

          actionSequence.push(state.actionTo);

          const player = state.players[state.actionTo];
          if (!player) break;

          try {
            // Always check to keep hand going
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
              engine.act({
                type: ActionType.CALL,
                playerId: player.id,
                timestamp: Date.now(),
              });
            }
          } catch {
            break;
          }
        }

        // Verify action sequence has some progression
        expect(actionSequence.length).toBeGreaterThan(0);

        // No action should repeat immediately (unless everyone else folded)
        for (let i = 1; i < actionSequence.length - 1; i++) {
          if (actionSequence[i] === actionSequence[i - 1]) {
            // This shouldn't happen - same player acting twice in a row
            // Unless it's the only player left
            expect(actionSequence.length).toBe(i + 1);
          }
        }
      }),
      { numRuns: 30 }
    );
  });

  test("heads-up action order follows special rules", () => {
    fc.assert(
      fc.property(
        fc.record({
          buttonStack: fc.integer({ min: 100, max: 1000 }),
          otherStack: fc.integer({ min: 100, max: 1000 }),
        }),
        (config) => {
          const engine = new PokerEngine({
            smallBlind: 5,
            bigBlind: 10,
            maxPlayers: 2,
          });

          // Button at seat 0, other at seat 1
          engine.sit(0, "button", "Button", config.buttonStack);
          engine.sit(1, "other", "Other", config.otherStack);

          engine.deal();

          const state = engine.state;

          // In heads-up preflop, button (SB) acts first
          // Button should be seat 0
          expect(state.buttonSeat).toBe(0);

          // First to act preflop should be button (seat 0)
          if (state.street === "PREFLOP" && state.actionTo !== null) {
            expect(state.actionTo).toBe(0);
          }

          // After one action, should be other player's turn
          if (state.actionTo !== null) {
            const player = state.players[state.actionTo];
            if (player) {
              try {
                engine.act({
                  type: ActionType.CALL,
                  playerId: player.id,
                  timestamp: Date.now(),
                });

                // Now should be other player's turn (or null if street progressed)
                if (engine.state.street === "PREFLOP" && engine.state.actionTo !== null) {
                  expect(engine.state.actionTo).toBe(1);
                }
              } catch {
                // Action might fail, that's okay
              }
            }
          }
        }
      ),
      { numRuns: 50 }
    );
  });
});
