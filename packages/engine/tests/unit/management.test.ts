import { PokerEngine } from "../../src/engine/PokerEngine";
import { ActionType, PlayerStatus, SitInOption } from "@pokertools/types";

describe("Management Actions", () => {
  describe("ADD_CHIPS", () => {
    test("adds chips to pendingAddOn without affecting current stack", () => {
      const engine = new PokerEngine({
        smallBlind: 10,
        bigBlind: 20,
        maxPlayers: 6,
      });

      engine.sit(0, "p1", "Alice", 1000);
      engine.sit(1, "p2", "Bob", 1000);

      // Add chips while not in a hand
      engine.act({
        type: ActionType.ADD_CHIPS,
        playerId: "p1",
        amount: 500,
        timestamp: Date.now(),
      });

      const player = engine.state.players[0]!;
      expect(player.stack).toBe(1000); // Stack unchanged
      expect(player.pendingAddOn).toBe(500); // Chips pending
    });

    test("merges pendingAddOn into stack at next deal", () => {
      const engine = new PokerEngine({
        smallBlind: 10,
        bigBlind: 20,
        maxPlayers: 6,
      });

      engine.sit(0, "p1", "Alice", 1000);
      engine.sit(1, "p2", "Bob", 1000);
      engine.sit(2, "p3", "Charlie", 1000);

      // Add chips
      engine.act({
        type: ActionType.ADD_CHIPS,
        playerId: "p1",
        amount: 500,
        timestamp: Date.now(),
      });

      // Deal hand
      engine.deal();

      const player = engine.state.players[0]!;
      expect(player.pendingAddOn).toBe(0); // Pending cleared
      // Total chips should be 1500 (including bets and stack)
      expect(player.stack + player.totalInvestedThisHand).toBe(1500);
    });

    test("allows multiple add-ons to accumulate", () => {
      const engine = new PokerEngine({
        smallBlind: 10,
        bigBlind: 20,
        maxPlayers: 6,
      });

      engine.sit(0, "p1", "Alice", 1000);
      engine.sit(1, "p2", "Bob", 1000);

      // Add chips twice
      engine.act({
        type: ActionType.ADD_CHIPS,
        playerId: "p1",
        amount: 300,
        timestamp: Date.now(),
      });

      engine.act({
        type: ActionType.ADD_CHIPS,
        playerId: "p1",
        amount: 200,
        timestamp: Date.now(),
      });

      const player = engine.state.players[0]!;
      expect(player.stack).toBe(1000);
      expect(player.pendingAddOn).toBe(500);
    });

    test("can add chips mid-hand", () => {
      const engine = new PokerEngine({
        smallBlind: 10,
        bigBlind: 20,
        maxPlayers: 6,
      });

      engine.sit(0, "p1", "Alice", 1000);
      engine.sit(1, "p2", "Bob", 1000);
      engine.sit(2, "p3", "Charlie", 1000);

      engine.deal();

      const stackBeforeAddChips = engine.state.players[0]!.stack;

      // Alice adds chips mid-hand
      engine.act({
        type: ActionType.ADD_CHIPS,
        playerId: "p1",
        amount: 1000,
        timestamp: Date.now(),
      });

      const player = engine.state.players[0]!;
      expect(player.pendingAddOn).toBe(1000);
      // Stack should not include pending chips yet
      expect(player.stack).toBe(stackBeforeAddChips);

      // Just fold Alice to complete the action (don't try to finish the hand)
      engine.act({
        type: ActionType.FOLD,
        playerId: "p1",
        timestamp: Date.now(),
      });

      // Verify pending chips remain during hand
      const aliceMidHand = engine.state.players[0]!;
      expect(aliceMidHand.pendingAddOn).toBe(1000);

      // Complete the hand by folding/checking others
      engine.act({
        type: ActionType.CALL,
        playerId: "p2",
        timestamp: Date.now(),
      });

      engine.act({
        type: ActionType.CHECK,
        playerId: "p3",
        timestamp: Date.now(),
      });

      // Now at flop - check everyone to river
      engine.act({
        type: ActionType.CHECK,
        playerId: "p2",
        timestamp: Date.now(),
      });
      engine.act({
        type: ActionType.CHECK,
        playerId: "p3",
        timestamp: Date.now(),
      });

      // Turn
      engine.act({
        type: ActionType.CHECK,
        playerId: "p2",
        timestamp: Date.now(),
      });
      engine.act({
        type: ActionType.CHECK,
        playerId: "p3",
        timestamp: Date.now(),
      });

      // River
      engine.act({
        type: ActionType.CHECK,
        playerId: "p2",
        timestamp: Date.now(),
      });
      engine.act({
        type: ActionType.CHECK,
        playerId: "p3",
        timestamp: Date.now(),
      });

      // Should be at showdown now
      expect(engine.state.street).toBe("SHOWDOWN");

      // Deal next hand
      engine.deal();

      // Pending chips should now be in Alice's stack
      const aliceAfter = engine.state.players[0]!;
      expect(aliceAfter.pendingAddOn).toBe(0);
      expect(aliceAfter.stack + aliceAfter.totalInvestedThisHand).toBeGreaterThan(1900);
    });
  });

  describe("RESERVE_SEAT", () => {
    test("reserves a seat with expiry timestamp", () => {
      const engine = new PokerEngine({
        smallBlind: 10,
        bigBlind: 20,
        maxPlayers: 6,
      });

      const now = Date.now();
      const expiry = now + 30000; // 30 seconds

      engine.act({
        type: ActionType.RESERVE_SEAT,
        playerId: "p1",
        playerName: "Alice",
        seat: 3,
        expiryTimestamp: expiry,
        timestamp: now,
      });

      const player = engine.state.players[3]!;
      expect(player.id).toBe("p1");
      expect(player.name).toBe("Alice");
      expect(player.status).toBe(PlayerStatus.RESERVED);
      expect(player.reservationExpiry).toBe(expiry);
      expect(player.stack).toBe(0);
    });

    test("prevents reserving occupied seat", () => {
      const engine = new PokerEngine({
        smallBlind: 10,
        bigBlind: 20,
        maxPlayers: 6,
      });

      // Player sits
      engine.sit(2, "p1", "Alice", 1000);

      // Try to reserve same seat
      const playerBefore = engine.state.players[2];
      expect(() => {
        engine.act({
          type: ActionType.RESERVE_SEAT,
          playerId: "p2",
          playerName: "Bob",
          seat: 2,
          expiryTimestamp: Date.now() + 30000,
          timestamp: Date.now(),
        });
      }).toThrow();

      // Seat should still be occupied by Alice
      expect(engine.state.players[2]).toBe(playerBefore);
      expect(engine.state.players[2]!.id).toBe("p1");
    });

    test("reserved player is not dealt in", () => {
      const engine = new PokerEngine({
        smallBlind: 10,
        bigBlind: 20,
        maxPlayers: 6,
      });

      const now = Date.now();
      const expiry = now + 30000;

      // Reserve seat
      engine.act({
        type: ActionType.RESERVE_SEAT,
        playerId: "p1",
        playerName: "Alice",
        seat: 3,
        expiryTimestamp: expiry,
        timestamp: now,
      });

      // Add other players
      engine.sit(0, "p2", "Bob", 1000);
      engine.sit(1, "p3", "Charlie", 1000);

      // Deal hand
      engine.deal();

      // Reserved player should not be dealt in
      const reservedPlayer = engine.state.players[3]!;
      expect(reservedPlayer.status).toBe(PlayerStatus.RESERVED);
      expect(reservedPlayer.hand).toBeNull();
    });

    test("can convert reservation to full sit", () => {
      const engine = new PokerEngine({
        smallBlind: 10,
        bigBlind: 20,
        maxPlayers: 6,
      });

      // Reserve seat
      engine.act({
        type: ActionType.RESERVE_SEAT,
        playerId: "p1",
        playerName: "Alice",
        seat: 3,
        expiryTimestamp: Date.now() + 30000,
        timestamp: Date.now(),
      });

      // Remove reservation (payment confirmed)
      engine.act({
        type: ActionType.STAND,
        playerId: "p1",
        timestamp: Date.now(),
      });

      // Full sit
      engine.sit(3, "p1", "Alice", 1000);

      const player = engine.state.players[3]!;
      expect(player.status).toBe(PlayerStatus.WAITING);
      expect(player.stack).toBe(1000);
    });
  });

  describe("Wait for Big Blind", () => {
    test("player with WAIT_FOR_BB sits out until BB position", () => {
      const engine = new PokerEngine({
        smallBlind: 10,
        bigBlind: 20,
        maxPlayers: 6,
      });

      // Seat players
      engine.sit(0, "p1", "Alice", 1000); // Button
      engine.sit(1, "p2", "Bob", 1000); // SB
      engine.sit(2, "p3", "Charlie", 1000); // BB

      // Late arrival at seat 3 (after button) with WAIT_FOR_BB
      engine.act({
        type: ActionType.SIT,
        playerId: "p4",
        playerName: "David",
        seat: 3,
        stack: 1000,
        sitInOption: SitInOption.WAIT_FOR_BB,
        timestamp: Date.now(),
      });

      // Deal hand
      engine.deal();

      const david = engine.state.players[3]!;
      // David should be sitting out (not in BB position yet)
      expect(david.isSittingOut).toBe(true);
      expect(david.hand).toBeNull();
    });

    test("player sits out until BB position with WAIT_FOR_BB", () => {
      const engine = new PokerEngine({
        smallBlind: 10,
        bigBlind: 20,
        maxPlayers: 6,
      });

      engine.sit(0, "p1", "Alice", 1000);
      engine.sit(1, "p2", "Bob", 1000);
      engine.sit(2, "p3", "Charlie", 1000);

      // David sits with WAIT_FOR_BB at seat 4
      engine.act({
        type: ActionType.SIT,
        playerId: "p4",
        playerName: "David",
        seat: 4,
        stack: 1000,
        sitInOption: SitInOption.WAIT_FOR_BB,
        timestamp: Date.now(),
      });

      // Deal first hand - David not in BB, should sit out
      engine.deal();

      const davidBefore = engine.state.players[4]!;
      expect(davidBefore.isSittingOut).toBe(true);
      expect(davidBefore.hand).toBeNull();
      expect(davidBefore.sitInOption).toBe(SitInOption.WAIT_FOR_BB);
    });

    test("IMMEDIATE option deals player in right away", () => {
      const engine = new PokerEngine({
        smallBlind: 10,
        bigBlind: 20,
        maxPlayers: 6,
      });

      engine.sit(0, "p1", "Alice", 1000);
      engine.sit(1, "p2", "Bob", 1000);
      engine.sit(2, "p3", "Charlie", 1000);

      // Seat with IMMEDIATE (default)
      engine.sit(3, "p4", "David", 1000);

      engine.deal();

      const david = engine.state.players[3]!;
      expect(david.isSittingOut).toBe(false);
      expect(david.hand).toBeTruthy();
    });

    test("sitInOption persists across hands", () => {
      const engine = new PokerEngine({
        smallBlind: 10,
        bigBlind: 20,
        maxPlayers: 6,
      });

      // Sit with WAIT_FOR_BB
      engine.sit(0, "p1", "Alice", 1000);
      engine.sit(1, "p2", "Bob", 1000);

      engine.act({
        type: ActionType.SIT,
        playerId: "p3",
        playerName: "Charlie",
        seat: 2,
        stack: 1000,
        sitInOption: SitInOption.WAIT_FOR_BB,
        timestamp: Date.now(),
      });

      // Deal hand
      engine.deal();

      const charlie = engine.state.players[2]!;
      // Charlie's sitInOption should be preserved
      expect(charlie.sitInOption).toBe(SitInOption.WAIT_FOR_BB);
    });
  });
});
