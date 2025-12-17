import { GameState, Winner, PlayerStatus, Pot, Street } from "@pokertools/types";
import { evaluate, getCardCodes, rankDescription, rank } from "@pokertools/evaluator";
import { getDistanceFromButton } from "../utils/positioning";
import { calculateRake } from "../utils/rake";

/**
 * Hand evaluation result
 */
interface HandEvaluation {
  seat: number;
  score: number; // Lower is better
  hand: string[]; // Best 5-card hand
  description: string; // e.g., "Full House, Aces full of Kings"
}

/**
 * Determine winners and distribute pots
 */
export function determineWinners(state: GameState): GameState {
  const winners: Winner[] = [];
  const newPlayers = [...state.players];
  let totalRake = 0;
  const winnerSeats = new Set<number>();

  // Process each pot (side pots first, then main)
  const sortedPots = [...state.pots].sort((a, b) => {
    if (a.type === "SIDE" && b.type === "MAIN") return -1;
    if (a.type === "MAIN" && b.type === "SIDE") return 1;
    return 0;
  });

  for (const pot of sortedPots) {
    const potWinners = evaluatePot(state, pot);

    if (potWinners.length === 0) {
      continue;
    }

    // Calculate and deduct rake (cash games only)
    // Apply GLOBAL rake cap across all pots (per-hand, not per-pot)
    const { rake } = calculateRake(state, pot.amount, totalRake);
    totalRake += rake;
    const potAfterRake = pot.amount - rake;

    // Distribute pot among winners
    const share = Math.floor(potAfterRake / potWinners.length);
    const remainder = potAfterRake % potWinners.length;

    // Sort winners by position (worst to best) for odd chip distribution
    // TDA Rule: Odd chips go to first player(s) clockwise from button
    const sortedWinners = [...potWinners].sort((a, b) => {
      if (state.buttonSeat === null) return 0;

      const distA = getDistanceFromButton(a.seat, state.buttonSeat, state.maxPlayers);
      const distB = getDistanceFromButton(b.seat, state.buttonSeat, state.maxPlayers);

      return distA - distB;
    });

    // Distribute chips to all winners
    for (let i = 0; i < sortedWinners.length; i++) {
      const evaluation = sortedWinners[i];
      let award = share;

      // Distribute odd chips one at a time to worst positions
      // (first N winners in sorted order get the extra chips)
      if (i < remainder) {
        award += 1;
      }

      // Track winner seats
      winnerSeats.add(evaluation.seat);

      // Award chips to player
      const player = newPlayers[evaluation.seat]!;
      newPlayers[evaluation.seat] = {
        ...player,
        stack: player.stack + award,
      };

      // Record winner
      winners.push({
        seat: evaluation.seat,
        amount: award,
        hand: evaluation.hand,
        handRank: evaluation.description,
      });
    }
  }

  // Set shown cards for winners and losers
  for (let seat = 0; seat < newPlayers.length; seat++) {
    const player = newPlayers[seat];
    if (player && player.hand !== null) {
      if (winnerSeats.has(seat)) {
        // Winners must show all cards
        newPlayers[seat] = {
          ...player,
          shownCards: [0, 1], // Show both cards
        };
      } else {
        // Losers are mucked by default (can be changed via SHOW action)
        newPlayers[seat] = {
          ...player,
          shownCards: null, // Mucked - hand preserved but not shown
        };
      }
    }
  }

  // NOTE: We do NOT reset totalInvestedThisHand here because it's used by getInitialChips()
  // to calculate total chips in the game. It will be reset when a new hand is dealt.

  return {
    ...state,
    players: newPlayers,
    winners,
    rakeThisHand: totalRake,
    pots: [], // Pots distributed
    actionTo: null,
  };
}

/**
 * Evaluate a single pot and return winner(s)
 */
function evaluatePot(state: GameState, pot: Pot): HandEvaluation[] {
  // Get eligible players (not folded)
  const eligible = pot.eligibleSeats
    .map((seat) => state.players[seat])
    .filter(
      (player) =>
        player && (player.status === PlayerStatus.ACTIVE || player.status === PlayerStatus.ALL_IN)
    );

  // If only one player, they win without showing
  if (eligible.length === 1) {
    const player = eligible[0]!;
    return [
      {
        seat: player.seat,
        score: 0,
        hand: [],
        description: "Uncontested",
      },
    ];
  }

  // Evaluate all hands
  const evaluations: HandEvaluation[] = [];

  for (const player of eligible) {
    if (!player?.hand) continue;

    // Skip masked hands (client mode)
    if (player.hand.some((c) => c === null)) {
      continue;
    }

    // Combine hole cards + board (7 cards total for river)
    const allCards = [...(player.hand as string[]), ...state.board];

    if (allCards.length < 5) {
      // Not enough cards (shouldn't happen)
      continue;
    }

    // Evaluate using @pokertools/evaluator
    const cardCodes = getCardCodes(allCards);
    const score = evaluate(cardCodes);
    const handRank = rank(cardCodes);
    const description = rankDescription(handRank);

    evaluations.push({
      seat: player.seat,
      score,
      hand: [...(player.hand as string[])], // Store hole cards (copy to mutable array)
      description,
    });
  }

  if (evaluations.length === 0) {
    return [];
  }

  // Find best hand(s)
  const bestScore = Math.min(...evaluations.map((e) => e.score));
  const winners = evaluations.filter((e) => e.score === bestScore);

  return winners;
}

/**
 * Check if hand should go to showdown
 */
export function shouldShowdown(state: GameState): boolean {
  // Showdown if:
  // 1. We're at SHOWDOWN street
  // 2. Multiple players remain (not folded)
  // 3. Winners haven't been determined yet

  if (state.street !== Street.SHOWDOWN) {
    return false;
  }

  if (state.winners !== null) {
    return false; // Already determined winners
  }

  const activePlayers = state.players.filter(
    (p) => p && (p.status === PlayerStatus.ACTIVE || p.status === PlayerStatus.ALL_IN)
  );

  return activePlayers.length >= 2;
}
