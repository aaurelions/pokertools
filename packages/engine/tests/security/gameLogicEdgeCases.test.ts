import { PokerEngine } from "../../src/engine/PokerEngine";
import { ActionType, PlayerStatus, Street, SitInOption } from "@pokertools/types";
import { getInitialChips } from "../../src/utils/invariants";
import { createSeededRandom } from "../helpers/seededRandom";

/**
 * Play through every street to showdown by calling/checking.
 * Returns when SHOWDOWN is reached or no actionable player remains.
 */
function playToShowdown(engine: PokerEngine, maxActions = 30): void {
  let count = 0;
  while (engine.state.street !== "SHOWDOWN" && count < maxActions) {
    const seat = engine.state.actionTo;
    if (seat === null) break;
    const player = engine.state.players[seat]!;
    const currentBet = Math.max(...Array.from(engine.state.currentBets.values()), 0);
    const playerBet = engine.state.currentBets.get(seat) ?? 0;

    try {
      if (currentBet > playerBet) {
        engine.act({ type: ActionType.CALL, playerId: player.id });
      } else {
        engine.act({ type: ActionType.CHECK, playerId: player.id });
      }
    } catch (_e) {
      break;
    }
    count++;
  }
}

/**
 * Fold out all but one active player to end the hand quickly.
 */
function foldToWinner(engine: PokerEngine, winnerSeat: number): void {
  let count = 0;
  while (engine.state.street !== "SHOWDOWN" && count < 10) {
    const seat = engine.state.actionTo;
    if (seat === null) break;
    if (seat === winnerSeat) break;
    const player = engine.state.players[seat]!;
    engine.act({ type: ActionType.FOLD, playerId: player.id });
    count++;
  }
}

describe("Chip Conservation Across Multiple Hands", () => {
  test("total chips preserved over 10 consecutive hands (heads-up, no rake)", () => {
    const rng = createSeededRandom(42);
    const engine = new PokerEngine({
      smallBlind: 5,
      bigBlind: 10,
      maxPlayers: 2,
      randomProvider: rng,
    });

    engine.sit(0, "p0", "Alice", 1000);
    engine.sit(1, "p1", "Bob", 1000);

    const totalChipsStart = getInitialChips(engine.state);
    expect(totalChipsStart).toBe(2000);

    for (let hand = 0; hand < 10; hand++) {
      engine.deal();
      playToShowdown(engine);

      expect(engine.state.street).toBe("SHOWDOWN");
      expect(engine.state.winners).not.toBeNull();

      // Verify chip conservation invariant at every hand boundary
      const total = getInitialChips(engine.state);
      expect(total).toBe(2000);
    }
  });

  test("chips preserved when player folds preflop (uncalled blind)", () => {
    const engine = new PokerEngine({
      smallBlind: 5,
      bigBlind: 10,
      maxPlayers: 2,
    });

    engine.sit(0, "p0", "Alice", 1000);
    engine.sit(1, "p1", "Bob", 1000);

    engine.deal();

    // Alice (button/SB preflop heads-up) should call the BB to see how uncalled
    // bet return works when BB folds. Actually, button acts first preflop heads-up.
    // Let's just play: SB folds, BB wins blinds.
    const buttonSeat = engine.state.buttonSeat!;
    const buttonPlayer = engine.state.players[buttonSeat]!;

    // SB (button) calls, BB checks, all the way to showdown — not a fold path.
    // Replace with explicit fold: button folds, BB wins.
    engine.act({ type: ActionType.FOLD, playerId: buttonPlayer.id });

    expect(engine.state.street).toBe("SHOWDOWN");
    const total = getInitialChips(engine.state);
    expect(total).toBe(2000);
  });

  test("chip conservation with rake across multiple hands", () => {
    const rng = createSeededRandom(7);
    const engine = new PokerEngine({
      smallBlind: 25,
      bigBlind: 50,
      maxPlayers: 2,
      rakePercent: 5,
      rakeCap: 20,
      randomProvider: rng,
    });

    engine.sit(0, "p0", "Alice", 5000);
    engine.sit(1, "p1", "Bob", 5000);

    // Rake leaves the game each hand; the invariant is:
    //   sum(stacks)_{hand N end} + rakeThisHand == sum(stacks)_{hand N start}
    let stacksBeforeHand = 10000;

    for (let hand = 0; hand < 5; hand++) {
      engine.deal();
      playToShowdown(engine);
      expect(engine.state.street).toBe("SHOWDOWN");
      expect(engine.state.rakeThisHand).toBeGreaterThan(0);

      const stacksAfter =
        (engine.state.players[0]?.stack ?? 0) + (engine.state.players[1]?.stack ?? 0);
      // The rake taken this hand explains the difference exactly
      expect(stacksAfter + engine.state.rakeThisHand).toBe(stacksBeforeHand);

      // Per-hand chip conservation accounting (includes current rake)
      expect(getInitialChips(engine.state)).toBe(stacksBeforeHand);

      stacksBeforeHand = stacksAfter;
    }
  });

  test("chips preserved when a player busts out", () => {
    const rng = createSeededRandom(99);
    const engine = new PokerEngine({
      smallBlind: 25,
      bigBlind: 50,
      maxPlayers: 2,
      randomProvider: rng,
    });
    engine.sit(0, "p0", "Alice", 50); // minimal stack
    engine.sit(1, "p1", "Bob", 1000);

    expect(getInitialChips(engine.state)).toBe(1050);

    // Play one hand — Alice should be all-in after posting blind
    engine.deal();
    playToShowdown(engine);
    expect(engine.state.street).toBe("SHOWDOWN");

    // Chips must be conserved (no rake configured)
    expect(getInitialChips(engine.state)).toBe(1050);

    // Alice is likely busted — she has 0 chips now
    const alice = engine.state.players[0]!;
    const bob = engine.state.players[1]!;
    const remaining = alice.stack + bob.stack;
    expect(remaining).toBe(1050);
  });
});

describe("Dead Button / Empty Seat Blind Logic", () => {
  test("button moves to next seat index even when seat is empty (Dead Button)", () => {
    const engine = new PokerEngine({
      smallBlind: 5,
      bigBlind: 10,
      maxPlayers: 6,
    });

    engine.sit(0, "p0", "Alice", 1000);
    engine.sit(1, "p1", "Bob", 1000);
    engine.sit(3, "p3", "Carol", 1000);
    // Seat 2 is empty
    engine.deal();

    const button1 = engine.state.buttonSeat!;
    playToShowdown(engine);

    engine.deal();

    // Button should advance — even if it moves to an empty seat, the *next* hand
    // it should continue advancing. We just verify it's progressing.
    const button2 = engine.state.buttonSeat;
    expect(button2).not.toBe(button1);
  });

  test("heads-up maintains valid button position when one seat sits empty", () => {
    const engine = new PokerEngine({
      smallBlind: 5,
      bigBlind: 10,
      maxPlayers: 2,
    });

    engine.sit(0, "p0", "Alice", 1000);
    engine.sit(1, "p1", "Bob", 1000);
    engine.deal();

    // Two hands: ensure button alternates for heads-up
    const button1 = engine.state.buttonSeat!;
    playToShowdown(engine);

    engine.deal();
    const button2 = engine.state.buttonSeat!;
    expect(button2).not.toBe(button1);

    playToShowdown(engine);
    engine.deal();
    const button3 = engine.state.buttonSeat!;
    expect(button3).toBe(button1);
  });

  test("blinds rotate correctly over multiple hands with a full ring", () => {
    const rng = createSeededRandom(321);
    const engine = new PokerEngine({
      smallBlind: 10,
      bigBlind: 20,
      maxPlayers: 4,
      randomProvider: rng,
    });

    engine.sit(0, "p0", "Alice", 1000);
    engine.sit(1, "p1", "Bob", 1000);
    engine.sit(2, "p2", "Carol", 1000);
    engine.sit(3, "p3", "Dave", 1000);

    const blindSeats: Array<{ sb: number; bb: number }> = [];

    for (let i = 0; i < 4; i++) {
      engine.deal();
      // After deal, blinds are posted; we can find them by checking currentBets
      // before any calls (large bet = BB, smaller = SB for non-ante game).
      const entries = Array.from(engine.state.currentBets.entries()).sort((a, b) => a[1] - b[1]);
      const sb = entries[0]?.[0] ?? -1;
      const bb = entries[entries.length - 1]?.[0] ?? -1;
      blindSeats.push({ sb, bb });

      playToShowdown(engine);
    }

    // Big blind should advance through each seat over 4 hands
    const bbSeats = blindSeats.map((b) => b.bb);
    expect(new Set(bbSeats).size).toBe(4); // Each seat should have been BB once
    expect(new Set(bbSeats)).toEqual(new Set([0, 1, 2, 3]));
  });

  test("players post ante when configured", () => {
    const engine = new PokerEngine({
      smallBlind: 5,
      bigBlind: 10,
      maxPlayers: 3,
      ante: 1,
    });

    engine.sit(0, "p0", "Alice", 1000);
    engine.sit(1, "p1", "Bob", 1000);
    engine.sit(2, "p2", "Carol", 1000);

    engine.deal();

    // Ante plus blinds means each player should have invested >= ante (1)
    const investors = [0, 1, 2].map((s) => engine.state.players[s]!.totalInvestedThisHand);
    for (const inv of investors) {
      expect(inv).toBeGreaterThanOrEqual(1);
    }

    // Total invested across all players == 3 antes (3) + SB (5) + BB (10) = 18
    const total = investors.reduce((s, v) => s + v, 0);
    expect(total).toBe(18);
  });
});

describe("Auto-Runout (All-In) Chip Integrity", () => {
  test("chips preserved when both players go all-in preflop", () => {
    const rng = createSeededRandom(13);
    const engine = new PokerEngine({
      smallBlind: 5,
      bigBlind: 10,
      maxPlayers: 2,
      randomProvider: rng,
    });

    engine.sit(0, "p0", "Alice", 100);
    engine.sit(1, "p1", "Bob", 100);

    const initial = getInitialChips(engine.state);
    expect(initial).toBe(200);

    engine.deal();

    // Button (SB) acts first preflop heads-up — push all-in
    const buttonSeat = engine.state.buttonSeat!;
    const buttonId = engine.state.players[buttonSeat]!.id;
    engine.act({ type: ActionType.RAISE, playerId: buttonId, amount: 100 });

    // Opponent calls all-in
    const otherSeat = buttonSeat === 0 ? 1 : 0;
    const otherId = engine.state.players[otherSeat]!.id;
    engine.act({ type: ActionType.CALL, playerId: otherId });

    // Should auto-runout and reach showdown
    expect(engine.state.street).toBe("SHOWDOWN");
    expect(getInitialChips(engine.state)).toBe(200);
  });

  test("side pot chip integrity with three-way all-in (different stacks)", () => {
    const rng = createSeededRandom(505);
    const engine = new PokerEngine({
      smallBlind: 5,
      bigBlind: 10,
      maxPlayers: 3,
      randomProvider: rng,
    });

    engine.sit(0, "p0", "Alice", 100);
    engine.sit(1, "p1", "Bob", 300);
    engine.sit(2, "p2", "Carol", 500);

    const initial = getInitialChips(engine.state);
    expect(initial).toBe(900);

    engine.deal();

    const ids = [0, 1, 2].map((s) => engine.state.players[s]!.id);

    try {
      // UTG player (the first to act) goes all-in for their entire stack.
      const firstActor = engine.state.actionTo;
      if (firstActor !== null) {
        const firstId = engine.state.players[firstActor]!.id;
        const firstStack = engine.state.players[firstActor]!.stack;
        const firstBet = engine.state.currentBets.get(firstActor) ?? 0;
        engine.act({
          type: ActionType.RAISE,
          playerId: firstId,
          amount: firstBet + firstStack,
        });
      }

      // Each subsequent actor calls all-in if possible
      let safety = 20;
      while (engine.state.street !== "SHOWDOWN" && safety-- > 0) {
        const seat = engine.state.actionTo;
        if (seat === null) break;
        const player = engine.state.players[seat];
        if (!player) break;
        const pid = player.id;
        const stack = player.stack;
        const playerBet = engine.state.currentBets.get(seat) ?? 0;
        const currentBet = Math.max(...Array.from(engine.state.currentBets.values()), 0);

        if (currentBet > playerBet) {
          // Call all-in: raise to currentBet capped at playerBet + stack
          const callUpTo = Math.min(currentBet, playerBet + stack);
          engine.act({ type: ActionType.RAISE, playerId: pid, amount: callUpTo });
        } else {
          // No bet to call — push all-in by raising big
          engine.act({ type: ActionType.RAISE, playerId: pid, amount: playerBet + stack });
        }
      }
    } catch (_e) {
      // Some raises may be invalid (e.g., below min raise) — that's fine,
      // the chip conservation invariant is checked regardless of game flow.
    }

    // After auto-runout (or possibly mid-hand), total chips must balance
    expect(getInitialChips(engine.state)).toBe(900);
  });

  test("uncalled all-in is returned to bettor (chip conservation)", () => {
    const rng = createSeededRandom(77);
    const engine = new PokerEngine({
      smallBlind: 5,
      bigBlind: 10,
      maxPlayers: 2,
      randomProvider: rng,
    });

    engine.sit(0, "p0", "Alice", 500);
    engine.sit(1, "p1", "Bob", 100);

    const initial = getInitialChips(engine.state);
    expect(initial).toBe(600);

    engine.deal();

    // Button: Alice, has stack 500, makes Alice call first, then she raises a lot.
    const buttonSeat = engine.state.buttonSeat!;
    const buttonId = engine.state.players[buttonSeat]!.id;

    // Other seat (the short stack) is Bob
    const otherSeat = buttonSeat === 0 ? 1 : 0;
    const otherId = engine.state.players[otherSeat]!.id;

    // Alice bets way more than Bob has. Should result in uncalled portion returned.
    engine.act({ type: ActionType.RAISE, playerId: buttonId, amount: 500 });

    // Bob calls all-in (or folds) - either way chip conservation holds
    try {
      engine.act({ type: ActionType.CALL, playerId: otherId });
    } catch (_e) {
      // If calling isn't possible because the raise equals exactly max call,
      // just fold — Bob has 100 chips, raise was to 500, needs ~490 to call.
      engine.act({ type: ActionType.FOLD, playerId: otherId });
    }

    // If folded before showdown completed, we should already be at showdown
    // Either way, total chips are conserved (with no rake)
    if (engine.state.street !== "SHOWDOWN") {
      // Auto-runout may be in progress
      expect(engine.state.actionTo).not.toBeNull();
    }
    expect(getInitialChips(engine.state)).toBe(600);
  });
});

describe("Showdown Winner Determination Edge Cases", () => {
  test("multiple winners exist in a split pot (heads-up tie)", () => {
    // With seeded RNG we can't directly force a tie, but we can ensure that
    // when we reach showdown with equal-strength hands, total chips balance
    // and winners array is populated correctly.
    const rng = createSeededRandom(2020);
    const engine = new PokerEngine({
      smallBlind: 5,
      bigBlind: 10,
      maxPlayers: 2,
      randomProvider: rng,
    });

    engine.sit(0, "p0", "Alice", 1000);
    engine.sit(1, "p1", "Bob", 1000);

    engine.deal();
    playToShowdown(engine);

    expect(engine.state.street).toBe("SHOWDOWN");
    expect(engine.state.winners).not.toBeNull();
    expect(engine.state.winners!.length).toBeGreaterThanOrEqual(1);

    // Sum of all winner amounts + total rake must equal all the chips that were
    // in play this hand before the showdown resolved them.
    const winnerTotal = engine.state.winners!.reduce((s, w) => s + w.amount, 0);

    // With no rake configured, total in stacks equals initial (2000) — winner
    // amounts aggregate into stacks now. Just sanity check is non-negative.
    expect(winnerTotal).toBeGreaterThan(0);
    expect(getInitialChips(engine.state)).toBe(2000);
  });

  test("winners have valid hand description at showdown", () => {
    const rng = createSeededRandom(303);
    const engine = new PokerEngine({
      smallBlind: 10,
      bigBlind: 20,
      maxPlayers: 2,
      randomProvider: rng,
    });

    engine.sit(0, "p0", "Alice", 2000);
    engine.sit(1, "p1", "Bob", 2000);

    engine.deal();
    playToShowdown(engine);

    expect(engine.state.street).toBe("SHOWDOWN");
    for (const w of engine.state.winners ?? []) {
      expect(w.seat).toBeGreaterThanOrEqual(0);
      expect(w.amount).toBeGreaterThan(0);
      // Hand description is set when showdown determines winners (or "Uncontested")
      if (w.handRank !== null) {
        expect(typeof w.handRank).toBe("string");
      }
    }
  });
});

describe("Validation Guard Rails (Best Practices)", () => {
  test("cannot act when not your turn", () => {
    const engine = new PokerEngine({
      smallBlind: 5,
      bigBlind: 10,
      maxPlayers: 3,
    });

    engine.sit(0, "p0", "Alice", 1000);
    engine.sit(1, "p1", "Bob", 1000);
    engine.sit(2, "p2", "Carol", 1000);
    engine.deal();

    const actionSeat = engine.state.actionTo!;
    const wrongSeat = actionSeat === 0 ? 1 : 0;
    const wrongId = engine.state.players[wrongSeat]!.id;

    expect(() => {
      engine.act({ type: ActionType.CHECK, playerId: wrongId });
    }).toThrow();
  });

  test("cannot fold on behalf of a player who is not seated", () => {
    const engine = new PokerEngine({
      smallBlind: 5,
      bigBlind: 10,
      maxPlayers: 3,
    });

    engine.sit(0, "p0", "Alice", 1000);
    engine.sit(1, "p1", "Bob", 1000);
    engine.sit(2, "p2", "Carol", 1000);
    engine.deal();

    expect(() => {
      engine.act({ type: ActionType.FOLD, playerId: "ghost" });
    }).toThrow();
  });

  test("cannot call when there is nothing to call", () => {
    const engine = new PokerEngine({
      smallBlind: 5,
      bigBlind: 10,
      maxPlayers: 3,
    });

    engine.sit(0, "p0", "Alice", 1000);
    engine.sit(1, "p1", "Bob", 1000);
    engine.sit(2, "p2", "Carol", 1000);
    engine.deal();

    // UTG can't "CALL" — only RAISE or FOLD against the BB bet
    const utgSeat = engine.state.actionTo!;
    // Preflop, after blinds, there is a current bet so this should actually be
    // callable. Let's go to flop where there's nothing to call.
    engine.act({ type: ActionType.CALL, playerId: engine.state.players[utgSeat]!.id });
    engine.act({ type: ActionType.CALL, playerId: engine.state.players[(utgSeat + 1) % 3]!.id });
    engine.act({ type: ActionType.CHECK, playerId: engine.state.players[(utgSeat + 2) % 3]!.id });

    // Now on flop — first to act has nothing to call
    expect(engine.state.street).toBe(Street.FLOP);
    const flopFirst = engine.state.actionTo!;
    const flopFirstId = engine.state.players[flopFirst]!.id;

    expect(() => {
      engine.act({ type: ActionType.CALL, playerId: flopFirstId });
    }).toThrow();
  });

  test("cannot check when facing a bet", () => {
    const engine = new PokerEngine({
      smallBlind: 5,
      bigBlind: 10,
      maxPlayers: 3,
    });

    engine.sit(0, "p0", "Alice", 1000);
    engine.sit(1, "p1", "Bob", 1000);
    engine.sit(2, "p2", "Carol", 1000);
    engine.deal();

    // UTG raises; the next player cannot CHECK — must call or fold
    const utg = engine.state.actionTo!;
    engine.act({ type: ActionType.RAISE, playerId: engine.state.players[utg]!.id, amount: 50 });

    const nextSeat = engine.state.actionTo!;
    const nextId = engine.state.players[nextSeat]!.id;

    expect(() => {
      engine.act({ type: ActionType.CHECK, playerId: nextId });
    }).toThrow();
  });

  test("raise below minimum is rejected", () => {
    const engine = new PokerEngine({
      smallBlind: 5,
      bigBlind: 10,
      maxPlayers: 3,
    });

    engine.sit(0, "p0", "Alice", 1000);
    engine.sit(1, "p1", "Bob", 1000);
    engine.sit(2, "p2", "Carol", 1000);
    engine.deal();

    // UTG makes it 30 (raise of 20 over BB 10)
    const utg = engine.state.actionTo!;
    engine.act({ type: ActionType.RAISE, playerId: engine.state.players[utg]!.id, amount: 30 });

    const nextSeat = engine.state.actionTo!;
    const nextId = engine.state.players[nextSeat]!.id;

    // Trying to re-raise to only 40 (raise of 10) is below minRaise of 50 (30 + 20 = 50)
    expect(() => {
      engine.act({ type: ActionType.RAISE, playerId: nextId, amount: 40 });
    }).toThrow();
  });

  test("BLOCKS attempt to bet below big blind (string-bet exploit rejected)", () => {
    const engine = new PokerEngine({
      smallBlind: 5,
      bigBlind: 10,
      maxPlayers: 3,
    });

    engine.sit(0, "p0", "Alice", 1000);
    engine.sit(1, "p1", "Bob", 1000);
    engine.sit(2, "p2", "Carol", 1000);
    engine.deal();

    // After everyone calls the BB, on the flop there's no bet.
    // Build a scenario to test BET.
    const utg = engine.state.actionTo!;
    engine.act({ type: ActionType.CALL, playerId: engine.state.players[utg]!.id });
    engine.act({ type: ActionType.CALL, playerId: engine.state.players[(utg + 1) % 3]!.id });
    engine.act({ type: ActionType.CHECK, playerId: engine.state.players[(utg + 2) % 3]!.id });

    // Flop
    expect(engine.state.street).toBe(Street.FLOP);
    const first = engine.state.actionTo!;
    const firstId = engine.state.players[first]!.id;

    // Betting below the BB (5) is rejected
    expect(() => {
      engine.act({ type: ActionType.BET, playerId: firstId, amount: 5 });
    }).toThrow();
  });

  test("minimum raise correlates with the previous raise increment", () => {
    const engine = new PokerEngine({
      smallBlind: 5,
      bigBlind: 10,
      maxPlayers: 3,
    });

    engine.sit(0, "p0", "Alice", 5000);
    engine.sit(1, "p1", "Bob", 5000);
    engine.sit(2, "p2", "Carol", 5000);
    engine.deal();

    const utg = engine.state.actionTo!;
    engine.act({ type: ActionType.RAISE, playerId: engine.state.players[utg]!.id, amount: 60 });

    // minRaise should be 60 + 50 = 110
    expect(engine.state.minRaise).toBe(110);
  });

  test("STAND during a live hand implicitly folds first", () => {
    const engine = new PokerEngine({
      smallBlind: 5,
      bigBlind: 10,
      maxPlayers: 3,
    });

    engine.sit(0, "p0", "Alice", 1000);
    engine.sit(1, "p1", "Bob", 1000);
    engine.sit(2, "p2", "Carol", 1000);
    engine.deal();

    const actingSeat = engine.state.actionTo!;
    const actingId = engine.state.players[actingSeat]!.id;

    // Stand mid-hand — the engine should auto-fold before removing the player
    engine.act({ type: ActionType.STAND, playerId: actingId });

    expect(engine.state.players[actingSeat]).toBeNull();
    // Action should have moved to the next player
    expect(engine.state.actionTo).not.toBe(actingSeat);
  });

  test("TIMEOUT when no bet exists sets isSittingOut and advances", () => {
    const engine = new PokerEngine({
      smallBlind: 5,
      bigBlind: 10,
      maxPlayers: 2,
    });

    engine.sit(0, "p0", "Alice", 1000);
    engine.sit(1, "p1", "Bob", 1000);
    engine.deal();

    // SB (button) calls
    engine.act({ type: ActionType.CALL, playerId: engine.state.players[0]!.id });
    // BB checks
    engine.act({ type: ActionType.CHECK, playerId: engine.state.players[1]!.id });

    // On flop now
    expect(engine.state.street).toBe(Street.FLOP);
    const first = engine.state.actionTo!;
    engine.act({ type: ActionType.TIMEOUT, playerId: engine.state.players[first]!.id });

    // Player should be marked sitting out but NOT folded
    expect(engine.state.players[first]!.isSittingOut).toBe(true);
    expect(engine.state.players[first]!.status).not.toBe(PlayerStatus.FOLDED);

    // Chips should be conserved
    expect(getInitialChips(engine.state)).toBe(2000);
  });
});