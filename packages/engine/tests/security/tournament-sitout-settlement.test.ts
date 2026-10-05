import {
  ActionType,
  PlayerStatus,
  SitInOption,
  Street,
  type GameState,
  type Player,
} from "@pokertools/types";
import { PokerEngine } from "../../src/engine/poker-engine";
import { gameReducer } from "../../src/engine/game-reducer";
import { getInitialChips } from "../../src/utils/invariants";
import { createSeededRandom } from "../helpers/seeded-random";

/**
 * Tournament sit-out settlement regressions.
 *
 * Platform-reachable defect (NLHE h3 evidence): a player whose provider
 * attempts were exhausted is marked sitting out by a TIMEOUT. In a tournament
 * that player still posts forced blinds/antes and is folded. When the only
 * remaining live player then shoves (or checks down) with no caller, the hand
 * reached SHOWDOWN with `winners === null` and an undistributed pot, so no
 * HAND_COMPLETED/archive/next-hand intent was ever produced.
 *
 * Rule preserved here: the last non-folded eligible player (ACTIVE or ALL_IN)
 * wins the uncontested pot, excess uncalled bets are refunded, and chips are
 * conserved. Contested all-in runouts and ties must not regress.
 */

function tournamentEngine(
  stacks: readonly [number, number],
  options: { randomProvider?: () => number } = {}
): PokerEngine {
  const engine = new PokerEngine({
    smallBlind: 10,
    bigBlind: 20,
    maxPlayers: 2,
    blindStructure: [
      { smallBlind: 10, bigBlind: 20, ante: 0 },
      { smallBlind: 15, bigBlind: 30, ante: 0 },
    ],
    ...(options.randomProvider ? { randomProvider: options.randomProvider } : {}),
  });
  engine.sit(0, "p0", "Player 0", stacks[0]);
  engine.sit(1, "p1", "Player 1", stacks[1]);
  return engine;
}

function totalChips(engine: PokerEngine): number {
  const state = engine.state;
  return (
    state.players.reduce((sum, player) => sum + (player ? player.stack : 0), 0) +
    Array.from(state.currentBets.values()).reduce((sum, bet) => sum + bet, 0) +
    state.pots.reduce((sum, pot) => sum + pot.amount, 0)
  );
}

function actor(engine: PokerEngine): Player {
  return engine.state.players[engine.state.actionTo!]!;
}

/** Complete hand H1 so seat 1 is folded AND sitting out via a real TIMEOUT. */
function sitOutSeat1(engine: PokerEngine): void {
  engine.deal();
  engine.act({ type: ActionType.RAISE, playerId: "p0", amount: 40 });
  engine.act({ type: ActionType.TIMEOUT, playerId: "p1" });

  const p1 = engine.state.players[1]!;
  expect(p1.status).toBe(PlayerStatus.FOLDED);
  expect(p1.isSittingOut).toBe(true);
}

describe("Tournament sit-out settlement", () => {
  test("TIMEOUT sit-out then max RAISE settles the last all-in player uncontested", () => {
    const engine = tournamentEngine([1000, 1000]);
    sitOutSeat1(engine);
    expect(engine.state.winners).toEqual([{ seat: 0, amount: 40, hand: null, handRank: null }]);
    expect(totalChips(engine)).toBe(2000);

    // H2: the sitting-out player is the forced small blind (folded dead money).
    engine.deal();
    expect(engine.state.players[1]!.status).toBe(PlayerStatus.FOLDED);
    expect(engine.state.players[1]!.isSittingOut).toBe(true);
    let checks = 0;
    while (engine.state.actionTo !== null && checks < 10) {
      engine.act({ type: ActionType.CHECK, playerId: actor(engine).id });
      checks += 1;
    }

    expect(engine.state.street).toBe(Street.SHOWDOWN);
    expect(engine.state.winners).not.toBeNull();
    expect(engine.state.winners).toHaveLength(1);
    expect(engine.state.winners![0]).toMatchObject({
      seat: 0,
      amount: 20,
      handRank: "Uncontested",
    });
    expect(engine.state.players[0]!.stack).toBe(1030);
    expect(engine.state.players[1]!.stack).toBe(970);
    expect(totalChips(engine)).toBe(2000);

    // H3: the sitting-out player posts the big blind and is already folded when
    // the button shoves. The uncalled excess must come back and the matched pot
    // must settle to the only non-folded player.
    const p1Before = engine.state.players[1]!.stack;
    engine.deal();
    expect(engine.state.players[1]!.status).toBe(PlayerStatus.FOLDED);
    const p0 = engine.state.players[0]!;
    engine.act({
      type: ActionType.RAISE,
      playerId: p0.id,
      amount: p0.stack + (engine.state.currentBets.get(0) ?? 0),
    });

    expect(engine.state.street).toBe(Street.SHOWDOWN);
    expect(engine.state.winners).not.toBeNull();
    expect(engine.state.winners).toHaveLength(1);
    expect(engine.state.winners![0]).toMatchObject({
      seat: 0,
      amount: 40,
      handRank: "Uncontested",
    });
    expect(engine.state.pots).toEqual([]);
    expect(engine.state.players[0]!.stack).toBe(1050);
    expect(engine.state.players[1]!.stack).toBe(p1Before - 20);
    // The all-in wager was uncalled, so the excess returned and no chips remain.
    expect(engine.state.players[0]!.stack).toBeGreaterThan(0);
    expect(totalChips(engine)).toBe(2000);
    expect(getInitialChips(engine.state)).toBe(2000);
  });

  test("check-down path: the lone active player wins the folded sit-out dead blind", () => {
    const engine = tournamentEngine([1000, 1000]);
    sitOutSeat1(engine);

    engine.deal();
    expect(engine.state.players[0]!.status).toBe(PlayerStatus.ACTIVE);
    while (engine.state.actionTo !== null) {
      expect(actor(engine).status).toBe(PlayerStatus.ACTIVE);
      engine.act({ type: ActionType.CHECK, playerId: actor(engine).id });
    }

    expect(engine.state.street).toBe(Street.SHOWDOWN);
    expect(engine.state.players[0]!.status).toBe(PlayerStatus.ACTIVE);
    expect(engine.state.winners).toHaveLength(1);
    expect(engine.state.winners![0]).toMatchObject({
      seat: 0,
      amount: 20,
      handRank: "Uncontested",
    });
    expect(engine.state.players[0]!.stack).toBe(1030);
    expect(engine.state.players[1]!.stack).toBe(970);
    expect(totalChips(engine)).toBe(2000);
  });

  test("all-in versus all-in still runs the full board and evaluates a contested showdown", () => {
    const engine = tournamentEngine([1000, 1000], { randomProvider: createSeededRandom(1) });
    engine.deal();
    engine.act({ type: ActionType.RAISE, playerId: "p0", amount: 1000 });
    engine.act({ type: ActionType.CALL, playerId: "p1" });

    expect(engine.state.street).toBe(Street.SHOWDOWN);
    expect(engine.state.board).toHaveLength(5);
    expect(engine.state.winners).not.toBeNull();
    expect(engine.state.winners).toHaveLength(1);
    expect(engine.state.winners![0].handRank).not.toBe("Uncontested");
    expect(engine.state.winners![0].hand).toHaveLength(5);
    expect(engine.state.winners![0].amount).toBe(2000);
    expect(engine.state.players.map((player) => player?.stack).sort((a, b) => a! - b!)).toEqual([
      0, 2000,
    ]);
    expect(totalChips(engine)).toBe(2000);
  });

  test("a tie at showdown still splits the pot without losing chips", () => {
    const engine = tournamentEngine([1000, 1000], { randomProvider: createSeededRandom(4) });
    engine.deal();
    engine.act({ type: ActionType.CALL, playerId: "p0" });
    engine.act({ type: ActionType.CHECK, playerId: "p1" });
    while (engine.state.actionTo !== null) {
      engine.act({ type: ActionType.CHECK, playerId: actor(engine).id });
    }

    expect(engine.state.street).toBe(Street.SHOWDOWN);
    expect(engine.state.winners).not.toBeNull();
    expect(engine.state.winners).toHaveLength(2);
    expect(engine.state.winners!.map((winner) => winner.seat).sort()).toEqual([0, 1]);
    expect(engine.state.winners!.reduce((sum, winner) => sum + winner.amount, 0)).toBe(40);
    expect(engine.state.players[0]!.stack).toBe(1000);
    expect(engine.state.players[1]!.stack).toBe(1000);
    expect(totalChips(engine)).toBe(2000);
  });

  test("a shortstack forced blind all-in sit-out is eliminated with no false winner", () => {
    const engine = tournamentEngine([1000, 15]);
    (engine.state.players as Array<Player | null>)[1] = {
      ...engine.state.players[1]!,
      isSittingOut: true,
    };

    engine.deal();
    expect(engine.state.players[1]!.stack).toBe(0);
    expect(engine.state.players[1]!.status).toBe(PlayerStatus.ALL_IN);
    expect(engine.state.players[1]!.hand).toBeNull();

    // The lone active player calls the short all-in; the board runs out and the
    // live hand wins. A sitting-out all-in with no cards is never a winner.
    engine.act({ type: ActionType.CALL, playerId: "p0" });

    expect(engine.state.street).toBe(Street.SHOWDOWN);
    expect(engine.state.winners).not.toBeNull();
    expect(engine.state.winners!.map((winner) => winner.seat)).toEqual([0]);
    expect(engine.state.winners![0].amount).toBe(30);
    expect(engine.state.players[0]!.stack).toBe(1015);
    expect(engine.state.players[1]!.stack).toBe(0);
    expect(totalChips(engine)).toBe(1015);
  });

  test("a forced-blind all-in deal ends the final hand during DEAL with no client action", () => {
    // Both remaining players are all-in from their forced posts: the short
    // sitting-out big blind has no cards, the short human small blind does.
    // The DEAL itself must settle the final hand and eliminate the dead seat.
    const engine = tournamentEngine([10, 5]);
    (engine.state.players as Array<Player | null>)[1] = {
      ...engine.state.players[1]!,
      isSittingOut: true,
    };

    engine.deal();

    expect(engine.state.street).toBe(Street.SHOWDOWN);
    expect(engine.state.actionTo).toBeNull();
    expect(engine.state.board).toHaveLength(5);
    expect(engine.state.winners).not.toBeNull();
    expect(engine.state.winners!.map((winner) => winner.seat)).toEqual([0]);
    expect(engine.state.winners![0].amount).toBe(10);
    expect(engine.state.players[0]!.stack).toBe(15);
    expect(engine.state.players[1]!.stack).toBe(0);
    expect(totalChips(engine)).toBe(15);
  });
});

/**
 * Terminal fold with a sole eligible live contender (2.0.3 CASE2 / H11).
 *
 * External container evidence: a sitting-out opponent is already folded dead
 * (forced big blind 70 + ante 7) when the sole live player is asked to act.
 * The server-issued FOLD was accepted, but the hand then held zero live hands
 * at PREFLOP with 119 chips (14 ante + 35/70 current bets) undistributed, no
 * winner and no HAND_COMPLETED. A sole eligible live contender has ALREADY won
 * uncontested: the fold must settle that win instead of stranding the pot, and
 * must not refund the dead opponent's unmatched forced blind (dead money).
 * An ALL_IN opponent stays live eligible, so an ordinary fold still loses.
 */
describe("Terminal fold with a sole eligible live contender", () => {
  const blindStructure = [
    { smallBlind: 35, bigBlind: 70, ante: 7 },
    { smallBlind: 53, bigBlind: 106, ante: 11 },
  ];

  function terminalFoldEngine(): PokerEngine {
    const engine = new PokerEngine({
      smallBlind: 35,
      bigBlind: 70,
      maxPlayers: 2,
      blindStructure,
    });
    // Reported in-hand shape: human 1300 behind with 42 invested; sitting-out
    // opponent 581 behind with 77 invested (forced big blind + ante).
    engine.sit(0, "human", "Human", 1342);
    engine.sit(1, "agent", "Agent", 658);
    (engine.state.players as Array<Player | null>)[1] = {
      ...engine.state.players[1]!,
      isSittingOut: true,
    };
    return engine;
  }

  function expectReportedShape(engine: PokerEngine): void {
    engine.deal();
    const state = engine.state;

    expect(state.street).toBe(Street.PREFLOP);
    expect(state.actionTo).toBe(0);

    const human = state.players[0]!;
    expect(human.status).toBe(PlayerStatus.ACTIVE);
    expect(human.stack).toBe(1300);
    expect(human.betThisStreet).toBe(35);
    expect(human.totalInvestedThisHand).toBe(42);
    expect(human.isSittingOut).toBe(false);

    const deadOpponent = state.players[1]!;
    expect(deadOpponent.status).toBe(PlayerStatus.FOLDED);
    expect(deadOpponent.isSittingOut).toBe(true);
    expect(deadOpponent.stack).toBe(581);
    expect(deadOpponent.betThisStreet).toBe(70);
    expect(deadOpponent.totalInvestedThisHand).toBe(77);

    expect(state.pots).toEqual([{ amount: 14, eligibleSeats: [0], type: "MAIN", capPerPlayer: 7 }]);
    expect([...state.currentBets.entries()].sort((a, b) => a[0] - b[0])).toEqual([
      [0, 35],
      [1, 70],
    ]);
  }

  test("an accepted FOLD settles the prior sole contender instead of stranding the pot", () => {
    const engine = terminalFoldEngine();
    expectReportedShape(engine);

    // H11 blind bump between DEAL and FOLD: settings advance, but the in-hand
    // investments stay at the level they were posted at.
    engine.nextBlindLevel();
    expect(engine.state.blindLevel).toBe(1);
    expect(engine.state.smallBlind).toBe(53);
    expect(engine.state.bigBlind).toBe(106);
    expect(engine.state.ante).toBe(11);
    expect([...engine.state.currentBets.entries()].sort((a, b) => a[0] - b[0])).toEqual([
      [0, 35],
      [1, 70],
    ]);
    expect(engine.state.pots[0]!.amount).toBe(14);

    // The server-issued FOLD is accepted and recorded.
    engine.act({ type: ActionType.FOLD, playerId: "human" });

    const state = engine.state;
    expect(state.street).toBe(Street.SHOWDOWN);
    expect(state.actionTo).toBeNull();
    expect(state.pots).toEqual([]);
    expect(state.currentBets.size).toBe(0);
    expect(state.winners).not.toBeNull();
    expect(state.winners).toHaveLength(1);
    expect(state.winners![0]).toMatchObject({ seat: 0, amount: 119 });
    expect(state.actionHistory.some((record) => record.action.type === ActionType.FOLD)).toBe(true);

    // The prior sole contender remains the live owner: a fold cannot forfeit
    // eligibility that was already established.
    expect(state.players[0]!.status).toBe(PlayerStatus.ACTIVE);
    expect(state.players[0]!.stack).toBe(1419);

    // The dead sit-out loses its full forced stakes (70 + 7): the unmatched
    // forced big blind is dead money, not a live uncalled wager to refund.
    expect(state.players[1]!.status).toBe(PlayerStatus.FOLDED);
    expect(state.players[1]!.stack).toBe(581);

    expect(totalChips(engine)).toBe(2000);
    expect(getInitialChips(state)).toBe(2000);
  });

  test("a TIMEOUT of the sole contender settles the same uncontested win", () => {
    const engine = terminalFoldEngine();
    expectReportedShape(engine);
    engine.nextBlindLevel();

    engine.act({ type: ActionType.TIMEOUT, playerId: "human" });

    const state = engine.state;
    expect(state.street).toBe(Street.SHOWDOWN);
    expect(state.actionTo).toBeNull();
    expect(state.winners).toHaveLength(1);
    expect(state.winners![0]).toMatchObject({ seat: 0, amount: 119 });
    expect(state.players[0]!.stack).toBe(1419);
    expect(state.players[0]!.isSittingOut).toBe(true);
    expect(state.players[1]!.stack).toBe(581);
    expect(totalChips(engine)).toBe(2000);
    expect(getInitialChips(state)).toBe(2000);
  });

  test("an ordinary fold against an ALL_IN opponent still loses", () => {
    const engine = new PokerEngine({
      smallBlind: 10,
      bigBlind: 20,
      maxPlayers: 2,
      blindStructure: [
        { smallBlind: 10, bigBlind: 20, ante: 0 },
        { smallBlind: 15, bigBlind: 30, ante: 0 },
      ],
    });
    engine.sit(0, "p0", "Player 0", 1000);
    engine.sit(1, "p1", "Player 1", 1000);
    engine.deal();

    engine.act({ type: ActionType.RAISE, playerId: "p0", amount: 40 });
    const p1 = engine.state.players[1]!;
    engine.act({
      type: ActionType.RAISE,
      playerId: p1.id,
      amount: p1.stack + (engine.state.currentBets.get(1) ?? 0),
    });
    engine.act({ type: ActionType.FOLD, playerId: "p0" });

    const state = engine.state;
    expect(state.players[0]!.status).toBe(PlayerStatus.FOLDED);
    expect(state.winners).not.toBeNull();
    expect(state.winners!.map((winner) => winner.seat)).toEqual([1]);
    expect(state.players[0]!.stack).toBe(960);
    expect(state.players[1]!.stack).toBe(1040);
    expect(totalChips(engine)).toBe(2000);
    expect(getInitialChips(state)).toBe(2000);
  });
});

function makeUnsettledShowdownState(): GameState {
  const makePlayer = (
    seat: number,
    overrides: Partial<Player> & { hand: string[] | null }
  ): Player => ({
    id: `p${seat}`,
    name: `Player ${seat}`,
    seat,
    stack: 0,
    hand: null,
    shownCards: null,
    status: PlayerStatus.FOLDED,
    betThisStreet: 0,
    totalInvestedThisHand: 77,
    isSittingOut: false,
    timeBank: 30,
    pendingAddOn: 0,
    sitInOption: SitInOption.IMMEDIATE,
    reservationExpiry: null,
    ...overrides,
  });

  const players: Array<Player | null> = Array(2).fill(null);
  players[0] = makePlayer(0, { stack: 775, hand: ["6d", "4d"], status: PlayerStatus.ALL_IN });
  players[1] = makePlayer(1, { stack: 675, hand: null, isSittingOut: true });

  return {
    config: { smallBlind: 35, bigBlind: 70, ante: 7, validateIntegrity: false },
    players,
    maxPlayers: 2,
    handNumber: 11,
    buttonSeat: 0,
    bigBlindSeat: 1,
    deck: [],
    board: ["6s", "6c", "2c", "8c", "4c"],
    street: Street.SHOWDOWN,
    pots: [{ amount: 154, eligibleSeats: [0], type: "MAIN", capPerPlayer: 77 }],
    currentBets: new Map(),
    minRaise: 70,
    lastRaiseAmount: 70,
    actionTo: null,
    lastAggressorSeat: null,
    activePlayers: [0],
    winners: null,
    rakeThisHand: 0,
    smallBlind: 35,
    bigBlind: 70,
    ante: 7,
    blindLevel: 3,
    timeBanks: new Map([
      [0, 30],
      [1, 30],
    ]),
    timeBankActiveSeat: null,
    actionHistory: [],
    previousStates: [],
    timestamp: 1791171529568,
    handId: "hand-1791171527083-748776",
  };
}

describe("DEAL boundary validation", () => {
  test("DEAL of an unresolved showdown with chips at stake is rejected without mutation", () => {
    const state = makeUnsettledShowdownState();
    const chipsBefore = getInitialChips(state);
    const potBefore = state.pots.map((pot) => ({ ...pot }));

    expect(() =>
      gameReducer(state, { type: ActionType.DEAL, timestamp: state.timestamp + 1 })
    ).toThrow(/pot has not been awarded/);

    // The rejected DEAL never mutates the authoritative state: the pot is
    // intact and no chips are lost.
    expect(state.handNumber).toBe(11);
    expect(state.winners).toBeNull();
    expect(state.pots).toEqual(potBefore);
    expect(state.players[0]!.stack).toBe(775);
    expect(state.players[1]!.stack).toBe(675);
    expect(getInitialChips(state)).toBe(chipsBefore);
  });

  test("a settled showdown still accepts a manual DEAL (race safety preserved)", () => {
    const state = makeUnsettledShowdownState();
    const settled: GameState = {
      ...state,
      config: {
        smallBlind: 35,
        bigBlind: 70,
        ante: 7,
        validateIntegrity: false,
        blindStructure: [{ smallBlind: 35, bigBlind: 70, ante: 7 }],
      },
      players: [
        { ...state.players[0]!, stack: 929 },
        { ...state.players[1]!, stack: 675 },
      ],
      winners: [{ seat: 0, amount: 154, hand: null, handRank: "Uncontested" }],
      pots: [],
    };

    const afterDeal = gameReducer(settled, {
      type: ActionType.DEAL,
      timestamp: settled.timestamp + 1,
    });

    expect(afterDeal.handNumber).toBe(12);
    expect(afterDeal.street).toBe(Street.PREFLOP);
    expect(afterDeal.winners).toBeNull();
    expect(
      afterDeal.players.reduce((sum, player) => sum + (player ? player.stack : 0), 0) +
        Array.from(afterDeal.currentBets.values()).reduce((sum, bet) => sum + bet, 0) +
        afterDeal.pots.reduce((sum, pot) => sum + pot.amount, 0)
    ).toBe(1604);
  });
});

/**
 * The ordinary fold settlement's defensive eligible-0 pot fallback must stay
 * untouched by the sole-contender fix: a side pot whose listed eligible seats
 * have all folded still goes to the last listed seat exactly as before. The
 * award helper is private, so this pins the behavior through the public
 * reducer with the same synthetic-state pattern used by the DEAL tests.
 */
function makeOrdinaryFoldSidePotState(): GameState {
  const makePlayer = (
    seat: number,
    overrides: Partial<Player> & { hand: string[] | null }
  ): Player => ({
    id: `p${seat}`,
    name: `Player ${seat}`,
    seat,
    stack: 0,
    hand: null,
    shownCards: null,
    status: PlayerStatus.FOLDED,
    betThisStreet: 0,
    totalInvestedThisHand: 0,
    isSittingOut: false,
    timeBank: 30,
    pendingAddOn: 0,
    sitInOption: SitInOption.IMMEDIATE,
    reservationExpiry: null,
    ...overrides,
  });

  const players: Array<Player | null> = Array(3).fill(null);
  // Seat 0 is all-in for 50 and survives; it is not eligible for the side pot.
  players[0] = makePlayer(0, {
    stack: 0,
    hand: ["As", "Ks"],
    status: PlayerStatus.ALL_IN,
    totalInvestedThisHand: 50,
  });
  // Seat 1 is the last non-all-in player about to fold.
  players[1] = makePlayer(1, {
    stack: 500,
    hand: ["Qh", "Jh"],
    status: PlayerStatus.ACTIVE,
    totalInvestedThisHand: 500,
  });
  // Seat 2 already folded into the side pot.
  players[2] = makePlayer(2, {
    stack: 0,
    hand: null,
    status: PlayerStatus.FOLDED,
    totalInvestedThisHand: 500,
  });

  return {
    config: { smallBlind: 5, bigBlind: 10, validateIntegrity: true },
    players,
    maxPlayers: 3,
    handNumber: 3,
    buttonSeat: 0,
    bigBlindSeat: 2,
    deck: [],
    board: [],
    street: Street.PREFLOP,
    pots: [
      { amount: 150, eligibleSeats: [0, 1, 2], type: "MAIN", capPerPlayer: 50 },
      { amount: 900, eligibleSeats: [1, 2], type: "SIDE", capPerPlayer: 500 },
    ],
    currentBets: new Map(),
    minRaise: 10,
    lastRaiseAmount: 10,
    actionTo: 1,
    lastAggressorSeat: null,
    activePlayers: [1],
    winners: null,
    rakeThisHand: 0,
    smallBlind: 5,
    bigBlind: 10,
    ante: 0,
    blindLevel: 0,
    timeBanks: new Map([
      [0, 30],
      [1, 30],
      [2, 30],
    ]),
    timeBankActiveSeat: null,
    actionHistory: [],
    previousStates: [],
    timestamp: 1791171529568,
    handId: "hand-1791171527083-748777",
  };
}

describe("Ordinary fold settlement fallback (unchanged)", () => {
  test("an all-dead side pot still goes to its last listed eligible seat", () => {
    const state = makeOrdinaryFoldSidePotState();

    const result = gameReducer(state, {
      type: ActionType.FOLD,
      playerId: "p1",
      timestamp: state.timestamp + 1,
    });

    expect(result.street).toBe(Street.SHOWDOWN);
    expect(result.actionTo).toBeNull();
    expect(result.pots).toEqual([]);
    expect(result.currentBets.size).toBe(0);
    expect(result.winners).toEqual([
      { seat: 0, amount: 150, hand: null, handRank: null },
      { seat: 2, amount: 900, hand: null, handRank: null },
    ]);
    expect(result.players[0]!.stack).toBe(150);
    expect(result.players[1]!.stack).toBe(500);
    expect(result.players[2]!.stack).toBe(900);
    expect(getInitialChips(result)).toBe(1550);
  });
});
