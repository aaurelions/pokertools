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

    // Sort winners by position for odd chip distribution.
    // TDA Rule: odd chips go to first player(s) clockwise from the button.
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

      // First N winners (worst position) each get one extra chip.
      if (i < remainder) {
        award += 1;
      }

      winnerSeats.add(evaluation.seat);

      const player = newPlayers[evaluation.seat]!;
      newPlayers[evaluation.seat] = {
        ...player,
        stack: player.stack + award,
      };

      // Record winner with hand description.
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
          shownCards: Array.from({ length: player.hand.length }, (_, i) => i),
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
  const eligible = pot.eligibleSeats
    .map((seat) => state.players[seat])
    .filter(
      (player) =>
        player && (player.status === PlayerStatus.ACTIVE || player.status === PlayerStatus.ALL_IN)
    );

  // Single remaining player wins uncontested.
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

  const evaluations: HandEvaluation[] = [];

  for (const player of eligible) {
    if (!player?.hand) continue;

    // Skip masked hands in client mode.
    if (player.hand.some((c) => c === null)) {
      continue;
    }

    const allCards = [...(player.hand as string[]), ...state.board];

    if (allCards.length < 5) continue;

    const cardCodes = getCardCodes(allCards);
    const score = evaluate(cardCodes);
    const handRank = rank(cardCodes);
    const description = rankDescription(handRank);

    evaluations.push({
      seat: player.seat,
      score,
      hand: getBestFiveCardHand(allCards),
      description,
    });
  }

  if (evaluations.length === 0) {
    return [];
  }

  const bestScore = Math.min(...evaluations.map((e) => e.score));
  return evaluations.filter((e) => e.score === bestScore);
}

/**
 * Return the concrete five cards that produce the best evaluator score.
 * The evaluator score is lower-is-better, so enumerate all 5-card subsets and
 * keep the first subset with the minimum score. Hold'em has at most 7 cards,
 * making this deterministic brute-force path only 21 evaluations per player.
 */
function getBestFiveCardHand(cards: readonly string[]): string[] {
  if (cards.length === 5) {
    return [...cards];
  }

  let bestHand: string[] | null = null;
  let bestScore = Number.POSITIVE_INFINITY;

  for (let a = 0; a < cards.length - 4; a++) {
    for (let b = a + 1; b < cards.length - 3; b++) {
      for (let c = b + 1; c < cards.length - 2; c++) {
        for (let d = c + 1; d < cards.length - 1; d++) {
          for (let e = d + 1; e < cards.length; e++) {
            const candidate = [cards[a], cards[b], cards[c], cards[d], cards[e]];
            const score = evaluate(getCardCodes(candidate));

            if (score < bestScore) {
              bestScore = score;
              bestHand = candidate;
            }
          }
        }
      }
    }
  }

  if (bestHand === null) {
    return [...cards.slice(0, 5)];
  }

  return bestHand;
}

/**
 * Check if hand should go to showdown
 */
export function shouldShowdown(state: GameState): boolean {
  if (state.street !== Street.SHOWDOWN) return false;
  if (state.winners !== null) return false;

  const activePlayers = state.players.filter(
    (p) => p && (p.status === PlayerStatus.ACTIVE || p.status === PlayerStatus.ALL_IN)
  );
  return activePlayers.length >= 2;
}
