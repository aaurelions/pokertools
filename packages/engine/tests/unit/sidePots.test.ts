import { calculateSidePots } from "../../src/rules/sidePots";
import { GameState, Player, PlayerStatus } from "@pokertools/types";

// Helper to create test state
function createTestState(
  players: Array<{ seat: number; invested: number; status: PlayerStatus }>,
  currentBets: Map<number, number>
): GameState {
  const playerArray: Array<Player | null> = Array(9).fill(null);

  for (const p of players) {
    playerArray[p.seat] = {
      id: `p${p.seat}`,
      name: `Player${p.seat}`,
      seat: p.seat,
      stack: 0,
      hand: null,
      shownCards: null,
      status: p.status,
      betThisStreet: 0,
      totalInvestedThisHand: p.invested,
      isSittingOut: false,
      timeBank: 30,
    };
  }

  return {
    config: { smallBlind: 5, bigBlind: 10 },
    players: playerArray,
    maxPlayers: 9,
    handNumber: 1,
    buttonSeat: 0,
    deck: [],
    board: [],
    street: "PREFLOP" as any,
    pots: [],
    currentBets,
    minRaise: 10,
    lastRaiseAmount: 10,
    actionTo: null,
    lastAggressorSeat: null,
    activePlayers: players.map((p) => p.seat),
    winners: null,
    rakeThisHand: 0,
    smallBlind: 5,
    bigBlind: 10,
    ante: 0,
    blindLevel: 0,
    timeBanks: new Map(),
    actionHistory: [],
    previousStates: [],
    timestamp: Date.now(),
    handId: "test-hand",
  } as GameState;
}

describe("Side Pot Calculation", () => {
  test("simple all-in creates main pot", () => {
    const players = [
      { seat: 0, invested: 100, status: PlayerStatus.ALL_IN },
      { seat: 1, invested: 100, status: PlayerStatus.ACTIVE },
    ];

    const state = createTestState(
      players,
      new Map([
        [0, 0],
        [1, 0],
      ])
    );
    const pots = calculateSidePots(state);

    expect(pots.length).toBe(1);
    expect(pots[0].amount).toBe(200);
    expect(pots[0].type).toBe("MAIN");
    expect(pots[0].eligibleSeats).toEqual([0, 1]);
  });

  test("2-way all-in with different stacks creates side pot", () => {
    const players = [
      { seat: 0, invested: 100, status: PlayerStatus.ALL_IN },
      { seat: 1, invested: 500, status: PlayerStatus.ACTIVE },
    ];

    const state = createTestState(players, new Map());
    const pots = calculateSidePots(state);

    // Main pot: 200 (100 * 2)
    // Side pot: 400 (500 - 100) for player 1 only
    expect(pots.length).toBe(2);

    expect(pots[0].amount).toBe(200);
    expect(pots[0].type).toBe("MAIN");
    expect(pots[0].eligibleSeats).toEqual([0, 1]);

    expect(pots[1].amount).toBe(400);
    expect(pots[1].type).toBe("SIDE");
    expect(pots[1].eligibleSeats).toEqual([1]);
  });

  test("3-way all-in creates multiple side pots", () => {
    const players = [
      { seat: 0, invested: 100, status: PlayerStatus.ALL_IN },
      { seat: 1, invested: 300, status: PlayerStatus.ALL_IN },
      { seat: 2, invested: 1000, status: PlayerStatus.ACTIVE },
    ];

    const state = createTestState(players, new Map());
    const pots = calculateSidePots(state);

    // Main pot: 300 (100 * 3)
    // Side pot 1: 400 (200 * 2) - players 1 and 2
    // Side pot 2: 700 (700 * 1) - player 2 only
    expect(pots.length).toBe(3);

    expect(pots[0].amount).toBe(300);
    expect(pots[0].eligibleSeats).toEqual([0, 1, 2]);

    expect(pots[1].amount).toBe(400);
    expect(pots[1].eligibleSeats).toEqual([1, 2]);

    expect(pots[2].amount).toBe(700);
    expect(pots[2].eligibleSeats).toEqual([2]);
  });

  test("4-way all-in with varied stacks", () => {
    const players = [
      { seat: 0, invested: 50, status: PlayerStatus.ALL_IN },
      { seat: 1, invested: 100, status: PlayerStatus.ALL_IN },
      { seat: 2, invested: 200, status: PlayerStatus.ALL_IN },
      { seat: 3, invested: 500, status: PlayerStatus.ACTIVE },
    ];

    const state = createTestState(players, new Map());
    const pots = calculateSidePots(state);

    expect(pots.length).toBe(4);

    // Main: 50 * 4 = 200
    expect(pots[0].amount).toBe(200);
    expect(pots[0].eligibleSeats.length).toBe(4);

    // Side 1: 50 * 3 = 150
    expect(pots[1].amount).toBe(150);
    expect(pots[1].eligibleSeats.length).toBe(3);

    // Side 2: 100 * 2 = 200
    expect(pots[2].amount).toBe(200);
    expect(pots[2].eligibleSeats.length).toBe(2);

    // Side 3: 300 * 1 = 300
    expect(pots[3].amount).toBe(300);
    expect(pots[3].eligibleSeats.length).toBe(1);

    // Total should match total invested
    const totalPot = pots.reduce((sum, pot) => sum + pot.amount, 0);
    const totalInvested = players.reduce((sum, p) => sum + p.invested, 0);
    expect(totalPot).toBe(totalInvested);
  });

  test("folded players' chips included in pots but not eligible", () => {
    const players = [
      { seat: 0, invested: 100, status: PlayerStatus.FOLDED },
      { seat: 1, invested: 100, status: PlayerStatus.ACTIVE },
      { seat: 2, invested: 100, status: PlayerStatus.ACTIVE },
    ];

    const state = createTestState(players, new Map());
    const pots = calculateSidePots(state);

    // Folded player's chips stay in pot, but they're not eligible to win
    expect(pots.length).toBe(1);
    expect(pots[0].amount).toBe(300); // All players' chips (including folded)
    expect(pots[0].eligibleSeats).toEqual([1, 2]); // Only active players can win
  });
});
