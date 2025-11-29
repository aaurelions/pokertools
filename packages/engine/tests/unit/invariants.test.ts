import { calculateTotalChips, auditChipConservation } from "../../src/utils/invariants";
import { GameState, Player } from "@pokertools/types";
import { CriticalStateError } from "../../src/errors/CriticalStateError";

function createTestState(stacks: number[], pots: number[], bets: number[]): GameState {
  const players: Array<Player | null> = stacks.map((stack, i) => ({
    id: `p${i}`,
    name: `Player${i}`,
    seat: i,
    stack,
    hand: null,
    shownCards: null,
    status: "ACTIVE" as any,
    betThisStreet: 0,
    totalInvestedThisHand: 0,
    isSittingOut: false,
    timeBank: 30,
  }));

  const potsArray = pots.map((amount, i) => ({
    amount,
    eligibleSeats: [0, 1],
    type: i === 0 ? ("MAIN" as const) : ("SIDE" as const),
    capPerPlayer: 0,
  }));

  const currentBets = new Map<number, number>();
  bets.forEach((bet, i) => {
    if (bet > 0) currentBets.set(i, bet);
  });

  return {
    config: { smallBlind: 5, bigBlind: 10 },
    players,
    maxPlayers: players.length,
    handNumber: 1,
    buttonSeat: 0,
    deck: [],
    board: [],
    street: "PREFLOP" as any,
    pots: potsArray,
    currentBets,
    minRaise: 10,
    lastRaiseAmount: 10,
    actionTo: null,
    lastAggressorSeat: null,
    activePlayers: players.map((_, i) => i),
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

describe("Chip Conservation", () => {
  test("calculates total chips correctly", () => {
    const state = createTestState(
      [1000, 1000], // Stacks
      [100], // Pots
      [50, 50] // Current bets
    );

    const total = calculateTotalChips(state);
    // Stack + pot + currentBets = 1000 + 1000 + 100 + 50 + 50 = 2200
    expect(total).toBe(2200);
  });

  test("audit passes when chips match", () => {
    // Create a realistic state: 2 players, each started with 1000
    // Player 0 has invested 100 (stack 900, invested 100)
    // Player 1 has invested 50 (stack 950, invested 50)
    // Pots contain 100, current bets contain 50
    const players: Array<Player | null> = [
      {
        id: "p0",
        name: "Player0",
        seat: 0,
        stack: 900,
        hand: null,
        shownCards: null,
        status: "ACTIVE" as any,
        betThisStreet: 0,
        totalInvestedThisHand: 100,
        isSittingOut: false,
        timeBank: 30,
      },
      {
        id: "p1",
        name: "Player1",
        seat: 1,
        stack: 950,
        hand: null,
        shownCards: null,
        status: "ACTIVE" as any,
        betThisStreet: 0,
        totalInvestedThisHand: 50,
        isSittingOut: false,
        timeBank: 30,
      },
    ];

    const state = {
      ...createTestState([900, 950], [100], [50, 0]),
      players,
    };

    const initialChips = 2000; // 900+100 + 950+50 = 2000

    expect(() => {
      auditChipConservation(state, initialChips);
    }).not.toThrow();
  });

  test("audit fails when chips missing", () => {
    // Players missing 100 chips total
    const players: Array<Player | null> = [
      {
        id: "p0",
        name: "Player0",
        seat: 0,
        stack: 850, // Should be 900
        hand: null,
        shownCards: null,
        status: "ACTIVE" as any,
        betThisStreet: 0,
        totalInvestedThisHand: 100,
        isSittingOut: false,
        timeBank: 30,
      },
      {
        id: "p1",
        name: "Player1",
        seat: 1,
        stack: 950,
        hand: null,
        shownCards: null,
        status: "ACTIVE" as any,
        betThisStreet: 0,
        totalInvestedThisHand: 50,
        isSittingOut: false,
        timeBank: 30,
      },
    ];

    const state = {
      ...createTestState([850, 950], [100], [50, 0]),
      players,
    };

    const initialChips = 2000;

    expect(() => {
      auditChipConservation(state, initialChips);
    }).toThrow(CriticalStateError);
  });

  test("audit fails when chips duplicated", () => {
    // Players have 100 extra chips
    const players: Array<Player | null> = [
      {
        id: "p0",
        name: "Player0",
        seat: 0,
        stack: 1000, // Should be 900
        hand: null,
        shownCards: null,
        status: "ACTIVE" as any,
        betThisStreet: 0,
        totalInvestedThisHand: 100,
        isSittingOut: false,
        timeBank: 30,
      },
      {
        id: "p1",
        name: "Player1",
        seat: 1,
        stack: 950,
        hand: null,
        shownCards: null,
        status: "ACTIVE" as any,
        betThisStreet: 0,
        totalInvestedThisHand: 50,
        isSittingOut: false,
        timeBank: 30,
      },
    ];

    const state = {
      ...createTestState([1000, 950], [100], [50, 0]),
      players,
    };

    const initialChips = 2000;

    expect(() => {
      auditChipConservation(state, initialChips);
    }).toThrow(CriticalStateError);
  });

  test("complex scenario with side pots", () => {
    // Create realistic scenario: 3 players
    // Player 0: started with 600, invested 100 (stack 500, invested 100, current bet 50)
    // Player 1: started with 600, invested 200 (stack 400, invested 200, current bet 100)
    // Player 2: started with 400, invested 100 (stack 300, invested 100, current bet 0)
    // Total chips: 600 + 600 + 400 = 1600
    // Pots contain 250 (from previous streets), current bets 150
    const players: Array<Player | null> = [
      {
        id: "p0",
        name: "Player0",
        seat: 0,
        stack: 500,
        hand: null,
        shownCards: null,
        status: "ACTIVE" as any,
        betThisStreet: 50,
        totalInvestedThisHand: 100,
        isSittingOut: false,
        timeBank: 30,
      },
      {
        id: "p1",
        name: "Player1",
        seat: 1,
        stack: 400,
        hand: null,
        shownCards: null,
        status: "ACTIVE" as any,
        betThisStreet: 100,
        totalInvestedThisHand: 200,
        isSittingOut: false,
        timeBank: 30,
      },
      {
        id: "p2",
        name: "Player2",
        seat: 2,
        stack: 300,
        hand: null,
        shownCards: null,
        status: "ACTIVE" as any,
        betThisStreet: 0,
        totalInvestedThisHand: 100,
        isSittingOut: false,
        timeBank: 30,
      },
    ];

    const state = {
      ...createTestState([500, 400, 300], [150, 100], [50, 100, 0]),
      players,
    };

    const totalChips = calculateTotalChips(state);
    // Stacks: 500 + 400 + 300 = 1200
    // Pots: 150 + 100 = 250
    // Bets: 50 + 100 + 0 = 150
    // Total: 1600
    expect(totalChips).toBe(1600);

    // Should pass audit using getInitialChips
    // getInitialChips = stacks + totalInvested = 1200 + 400 = 1600
    expect(() => {
      auditChipConservation(state, 1600);
    }).not.toThrow();
  });
});
