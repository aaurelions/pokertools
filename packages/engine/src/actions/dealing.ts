import { GameState, Street, PlayerStatus, DealAction, Pot, SitInOption } from "@pokertools/types";
import { createDeck, shuffle, dealCards } from "../utils/deck";
import { cardCodesToStrings } from "../utils/card-utils";
import { getBlindPositions } from "../rules/blinds";
import { getFirstToAct } from "../rules/action-order";
import { getNextOccupiedSeat, getNextSeat } from "../utils/positioning";

/**
 * Deal a new hand
 * - Shuffles deck
 * - Posts blinds and antes
 * - Deals 2 cards to each active player
 * - Sets action to first to act
 */
export function handleDeal(state: GameState, action: DealAction): GameState {
  // Dead Button rule: advances to next seat index regardless of occupancy.
  let newButtonSeat = moveButton(state);

  const isTournament = !!state.config.blindStructure;
  const isClient = !!state.config.isClient;

  // Client mode: empty deck, cards dealt as masked (null).
  const rng = state.config.randomProvider ?? Math.random;
  const deck = isClient ? [] : shuffle(createDeck(), rng);

  const newTimeBanks = new Map(state.timeBanks);

  // Merge pending add-ons; expire stale reservations.
  const newPlayers = state.players.map((player) => {
    if (!player) return null;

    if (player.status === PlayerStatus.RESERVED) {
      if (player.reservationExpiry && action.timestamp! >= player.reservationExpiry) {
        newTimeBanks.delete(player.seat);
        return null;
      }
      return player;
    }

    const newStack = player.stack + player.pendingAddOn;

    return {
      ...player,
      stack: newStack,
      pendingAddOn: 0,
    };
  });

  newButtonSeat = moveHeadsUpButtonToOccupiedSeat(newButtonSeat, {
    ...state,
    players: newPlayers,
  });

  // Recompute blind positions with updated button/players.
  const blindPositions = getBlindPositions({
    ...state,
    buttonSeat: newButtonSeat,
    players: newPlayers,
  });

  // Determine which players receive cards.
  const playersToReceive: number[] = [];

  for (let seat = 0; seat < newPlayers.length; seat++) {
    const player = newPlayers[seat];

    if (!player || player.stack <= 0 || player.status === PlayerStatus.RESERVED) {
      continue;
    }

    // WAIT_FOR_BB check: sit player IN when they reach the Big Blind,
    // sit player OUT when they haven't reached it yet.
    let shouldPlay = true;

    if (!isTournament && player.sitInOption === SitInOption.WAIT_FOR_BB) {
      const isInBigBlind = blindPositions?.bigBlindSeat === seat;

      if (isInBigBlind) {
        // PLAYER RE-ENTRY: Force them active when they are in the Big Blind.
        newPlayers[seat] = {
          ...player,
          isSittingOut: false,
        };
        shouldPlay = true;
      } else {
        // Not yet in BB; force sit-out (avoids object churn if already sitting out).
        if (!player.isSittingOut) {
          newPlayers[seat] = {
            ...player,
            isSittingOut: true,
          };
        }
        shouldPlay = false;
      }
    } else if (player.isSittingOut) {
      shouldPlay = false;
    }

    if (shouldPlay) {
      playersToReceive.push(seat);
    }
  }

  let remainingDeck = deck;

  for (const seat of playersToReceive) {
    newPlayers[seat] = {
      ...newPlayers[seat]!,
      hand: [],
      shownCards: null,
      status: PlayerStatus.ACTIVE,
      betThisStreet: 0,
      totalInvestedThisHand: 0,
    };
  }

  // Tournament: sitting-out players initialized as FOLDED (must post blinds/antes).
  if (isTournament) {
    for (let seat = 0; seat < newPlayers.length; seat++) {
      const player = newPlayers[seat];
      if (player && player.stack > 0 && player.isSittingOut && !playersToReceive.includes(seat)) {
        newPlayers[seat] = {
          ...player,
          hand: null,
          shownCards: null,
          status: PlayerStatus.FOLDED,
          betThisStreet: 0,
          totalInvestedThisHand: 0,
        };
      }
    }
  }

  // Deal 2 hole cards, one at a time, clockwise.
  for (let round = 0; round < 2; round++) {
    for (const seat of playersToReceive) {
      let cardStrings: Array<string | null>;

      if (isClient) {
        cardStrings = [null];
      } else {
        const [cards, nextDeck] = dealCards(remainingDeck, 1);
        remainingDeck = nextDeck;
        cardStrings = cardCodesToStrings(cards);
      }

      const currentPlayer = newPlayers[seat]!;
      const currentHand = currentPlayer.hand ?? [];

      newPlayers[seat] = {
        ...currentPlayer,
        hand: [...currentHand, ...cardStrings],
      };
    }
  }

  // Post blinds and antes.
  const finalBlindPositions = getBlindPositions({
    ...state,
    buttonSeat: newButtonSeat,
    players: newPlayers,
  });

  const currentBets = new Map<number, number>();

  if (finalBlindPositions) {
    const { smallBlindSeat, bigBlindSeat } = finalBlindPositions;

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
                ? PlayerStatus.FOLDED
                : PlayerStatus.ACTIVE,
        };
      }
    }
    // Dead Small Blind: sbPlayer is null or (cash game && sitting out).

    const bbPlayer = newPlayers[bigBlindSeat];
    if (bbPlayer) {
      // In cash games sitting-out players are skipped by getBlindPositions.
      // In tournaments sitting-out players MUST post blinds (anti-blinding-off).
      const shouldPostBB = isTournament || !bbPlayer.isSittingOut;

      if (shouldPostBB) {
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
                ? PlayerStatus.FOLDED
                : PlayerStatus.ACTIVE,
        };
      }
    }
  }

  // Antes: tournament — all players with chips (incl. sitting-out); cash — active only.
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
                ? PlayerStatus.FOLDED
                : player.status,
        };
      }
    }
  }

  const pots: Pot[] = [];
  const activePlayers = playersToReceive.filter((seat) => {
    const player = newPlayers[seat]!;
    return player.status === PlayerStatus.ACTIVE;
  });

  const newState = {
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
    initialChips:
      newPlayers.reduce((sum, player) => sum + (player ? player.stack : 0), 0) +
      Array.from(currentBets.values()).reduce((sum, amount) => sum + amount, 0),
    minRaise: state.bigBlind,
    lastRaiseAmount: state.bigBlind,
    lastAggressorSeat: null,
    activePlayers,
    winners: null,
    rakeThisHand: 0,
    actionHistory: [],
    timestamp: action.timestamp!,
  } as GameState & { initialChips?: number };

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
    for (let seat = 0; seat < state.maxPlayers; seat++) {
      if (state.players[seat] !== null) {
        return seat;
      }
    }
    return 0;
  }

  // Dead Button: advance to next seat index regardless of occupancy.
  return getNextSeat(state.buttonSeat, state.maxPlayers);
}

function moveHeadsUpButtonToOccupiedSeat(buttonSeat: number, state: GameState): number {
  const occupiedSeats = state.players.filter((player) => player !== null && player.stack > 0);
  const buttonPlayer = state.players[buttonSeat];

  if (occupiedSeats.length !== 2 || (buttonPlayer !== null && buttonPlayer.stack > 0)) {
    return buttonSeat;
  }

  return getNextOccupiedSeat(buttonSeat, state.players, state.maxPlayers) ?? buttonSeat;
}
