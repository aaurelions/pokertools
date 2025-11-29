import { GameState, Street, PlayerStatus, DealAction, Pot } from "@pokertools/types";
import { createDeck, shuffle, dealCards } from "../utils/deck";
import { cardCodesToStrings } from "../utils/cardUtils";
import { getBlindPositions } from "../rules/blinds";
import { getFirstToAct } from "../rules/actionOrder";
import { getNextSeat } from "../utils/positioning";

/**
 * Deal a new hand
 * - Shuffles deck
 * - Posts blinds and antes
 * - Deals 2 cards to each active player
 * - Sets action to first to act
 */
export function handleDeal(state: GameState, action: DealAction): GameState {
  // Move button (Dead Button logic: moves to next seat index regardless of occupancy)
  const newButtonSeat = moveButton(state);

  // Determine if this is a tournament
  const isTournament = !!state.config.blindStructure;

  // Create and shuffle deck
  const rng = state.config.randomProvider ?? Math.random;
  const deck = shuffle(createDeck(), rng);

  // Get players who will be dealt in
  const playersToReceive: number[] = [];
  for (let seat = 0; seat < state.players.length; seat++) {
    const player = state.players[seat];
    if (player && player.stack > 0 && !player.isSittingOut) {
      playersToReceive.push(seat);
    }
  }

  // Deal 2 cards to each player
  let remainingDeck = deck;
  const newPlayers = [...state.players];

  // Initialize hands for receiving players (active, not sitting out)
  for (const seat of playersToReceive) {
    newPlayers[seat] = {
      ...newPlayers[seat]!,
      hand: [], // Initialize empty array
      shownCards: null, // Reset from previous hand
      status: PlayerStatus.ACTIVE,
      betThisStreet: 0,
      totalInvestedThisHand: 0,
    };
  }

  // In tournaments, initialize sitting-out players too (they must post blinds/antes)
  if (isTournament) {
    for (let seat = 0; seat < newPlayers.length; seat++) {
      const player = newPlayers[seat];
      if (player && player.stack > 0 && player.isSittingOut && !playersToReceive.includes(seat)) {
        newPlayers[seat] = {
          ...player,
          hand: null, // No cards dealt
          shownCards: null,
          status: PlayerStatus.FOLDED, // Start as folded
          betThisStreet: 0,
          totalInvestedThisHand: 0,
        };
      }
    }
  }

  // Deal 2 cards, one by one, in circle (standard poker procedure)
  for (let round = 0; round < 2; round++) {
    for (const seat of playersToReceive) {
      // Deal 1 card
      const [cards, nextDeck] = dealCards(remainingDeck, 1);
      remainingDeck = nextDeck;

      const cardStrings = cardCodesToStrings(cards);

      // Append to existing hand
      const currentPlayer = newPlayers[seat]!;
      const currentHand = currentPlayer.hand ?? []; // Should be [] from initialization

      newPlayers[seat] = {
        ...currentPlayer,
        hand: [...currentHand, ...cardStrings],
      };
    }
  }

  // Post blinds and antes
  const blindPositions = getBlindPositions({
    ...state,
    buttonSeat: newButtonSeat,
    players: newPlayers,
  });

  const currentBets = new Map<number, number>();

  if (blindPositions) {
    const { smallBlindSeat, bigBlindSeat } = blindPositions;

    // Post small blind
    // In tournaments: sitting-out players MUST post to prevent "blinding off" exploit
    // In cash games: sitting-out SB is treated as "Dead Small Blind" (no post)
    const sbPlayer = newPlayers[smallBlindSeat];
    if (sbPlayer && sbPlayer.stack > 0) {
      const shouldPostSB = isTournament || !sbPlayer.isSittingOut;
      if (shouldPostSB) {
        const sbAmount = Math.min(sbPlayer.stack, state.smallBlind);
        currentBets.set(smallBlindSeat, sbAmount);
        newPlayers[smallBlindSeat] = {
          ...sbPlayer,
          stack: sbPlayer.stack - sbAmount,
          betThisStreet: sbAmount,
          totalInvestedThisHand: sbAmount,
          status:
            sbAmount === sbPlayer.stack
              ? PlayerStatus.ALL_IN
              : sbPlayer.isSittingOut
                ? PlayerStatus.FOLDED // Sitting-out player posts blind then auto-folds
                : PlayerStatus.ACTIVE,
        };
      }
    }
    // If sbPlayer is null or (cash game && sitting out), Dead Small Blind applies

    // Post big blind (Must exist for hand to start)
    const bbPlayer = newPlayers[bigBlindSeat];
    if (bbPlayer) {
      const bbAmount = Math.min(bbPlayer.stack, state.bigBlind);
      currentBets.set(bigBlindSeat, bbAmount);
      newPlayers[bigBlindSeat] = {
        ...bbPlayer,
        stack: bbPlayer.stack - bbAmount,
        betThisStreet: bbAmount,
        totalInvestedThisHand: bbAmount,
        status:
          bbAmount === bbPlayer.stack
            ? PlayerStatus.ALL_IN
            : bbPlayer.isSittingOut
              ? PlayerStatus.FOLDED // Sitting-out player posts blind then auto-folds
              : PlayerStatus.ACTIVE,
      };
    }
  }

  // Post antes if configured
  // In tournaments: ALL players with chips must post (including sitting-out)
  // In cash games: Only active players post
  if (state.ante > 0) {
    const playersToAnteFrom = isTournament
      ? state.players.map((p, idx) => (p && p.stack > 0 ? idx : -1)).filter((idx) => idx >= 0)
      : playersToReceive;

    for (const seat of playersToAnteFrom) {
      const player = newPlayers[seat]!;
      const anteAmount = Math.min(player.stack, state.ante);

      if (anteAmount > 0) {
        const currentBet = currentBets.get(seat) ?? 0;
        currentBets.set(seat, currentBet + anteAmount);

        const newStack = player.stack - anteAmount;
        newPlayers[seat] = {
          ...player,
          stack: newStack,
          betThisStreet: player.betThisStreet + anteAmount,
          totalInvestedThisHand: player.totalInvestedThisHand + anteAmount,
          status:
            newStack === 0
              ? PlayerStatus.ALL_IN
              : player.isSittingOut && isTournament
                ? PlayerStatus.FOLDED // Sitting-out tournament player posts ante then auto-folds
                : player.status,
        };
      }
    }
  }

  // Start with empty pots (bets will be collected when street progresses)
  const pots: Pot[] = [];

  // Get active players
  const activePlayers = playersToReceive.filter((seat) => {
    const player = newPlayers[seat]!;
    return player.status === PlayerStatus.ACTIVE;
  });

  const newState: GameState = {
    ...state,
    handNumber: state.handNumber + 1,
    handId: `hand-${action.timestamp!}-${Math.floor(rng() * 1000000)}`,
    buttonSeat: newButtonSeat,
    deck: remainingDeck,
    board: [],
    street: Street.PREFLOP,
    players: newPlayers,
    pots,
    currentBets,
    minRaise: state.bigBlind,
    lastRaiseAmount: state.bigBlind,
    activePlayers,
    winners: null,
    rakeThisHand: 0,
    actionHistory: [],
    timestamp: action.timestamp!,
  };

  // Set first to act
  const firstToAct = getFirstToAct(newState);

  return {
    ...newState,
    actionTo: firstToAct,
  };
}

/**
 * Move button to next seat
 * Dead Button Rule: Moves to next index regardless of player presence
 */
function moveButton(state: GameState): number {
  if (state.buttonSeat === null) {
    // First hand, find first seated player
    for (let seat = 0; seat < state.maxPlayers; seat++) {
      if (state.players[seat] !== null) {
        return seat;
      }
    }
    return 0;
  }

  // Simply increment seat index (Dead Button)
  // We do not skip empty seats here.
  return getNextSeat(state.buttonSeat, state.maxPlayers);
}
