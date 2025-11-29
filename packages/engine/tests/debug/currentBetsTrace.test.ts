import { PokerEngine } from "../../src/engine/PokerEngine";
import { ActionType } from "@pokertools/types";
import { getInitialChips } from "../../src/utils/invariants";

describe("CurrentBets Trace", () => {
  test("track currentBets through fold scenario", () => {
    const engine = new PokerEngine({
      smallBlind: 5,
      bigBlind: 10,
      maxPlayers: 3,
    });

    engine.sit(0, "p0", "Player0", 500);
    engine.sit(1, "p1", "Player1", 500);
    engine.sit(2, "p2", "Player2", 500);

    function snapshot(_label: string) {
      const state = engine.state;
      return getInitialChips(state);
    }

    snapshot("Initial");

    engine.deal();
    snapshot("After deal");

    // Preflop: P0 calls, P1 calls, P2 calls
    let player = engine.state.players[engine.state.actionTo!]!;
    engine.act({ type: ActionType.CALL, playerId: player.id, timestamp: Date.now() });
    snapshot("After P0 calls (preflop)");

    player = engine.state.players[engine.state.actionTo!]!;
    engine.act({ type: ActionType.CALL, playerId: player.id, timestamp: Date.now() });
    snapshot("After P1 calls (preflop)");

    player = engine.state.players[engine.state.actionTo!]!;
    engine.act({ type: ActionType.CHECK, playerId: player.id, timestamp: Date.now() });
    snapshot("After P2 checks (preflop) - should progress to flop");

    // Flop: P0 checks
    if (engine.state.actionTo !== null) {
      player = engine.state.players[engine.state.actionTo!]!;
      engine.act({ type: ActionType.CHECK, playerId: player.id, timestamp: Date.now() });
      snapshot("After P0 checks (flop)");
    }

    // P1 folds
    if (engine.state.actionTo !== null) {
      player = engine.state.players[engine.state.actionTo!]!;
      engine.act({ type: ActionType.FOLD, playerId: player.id, timestamp: Date.now() });
      snapshot("After P1 folds (flop)");
    }

    // P2 acts
    if (engine.state.actionTo !== null) {
      player = engine.state.players[engine.state.actionTo!]!;
      try {
        engine.act({ type: ActionType.CHECK, playerId: player.id, timestamp: Date.now() });
        snapshot("After P2 checks (flop)");
      } catch (_e) {
        // Expected to potentially fail
      }
    }

    const finalChips = getInitialChips(engine.state);

    if (finalChips !== 1500) {
      // Track chip loss
    }
  });
});
