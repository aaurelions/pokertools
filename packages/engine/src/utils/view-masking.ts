import { GameState, Street, PublicState, Player, PlayerStatus } from "@pokertools/types";

/**
 * Create public view of game state for a specific player
 * Masks opponent hole cards and deck to prevent cheating
 * Respects shownCards for granular card visibility
 *
 * @param state Full game state
 * @param playerId Player requesting view (null = spectator)
 * @param version State version number (defaults to 0 if not provided)
 * @returns Masked public state
 */
export function createPublicView(
  state: GameState,
  playerId: string | null = null,
  version = 0
): PublicState {
  const maskedPlayers = state.players.map((player, _seat) => {
    if (!player) return null;

    // Determine which cards to show (if any)
    const visibleHand = getVisibleHand(state, player, playerId);

    return {
      ...player,
      hand: visibleHand,
    };
  });

  const currentBets = createSerializableReadonlyMap(state.currentBets);

  return {
    ...state,
    deck: [], // Always hide deck
    players: maskedPlayers,
    currentBets,
    viewingPlayerId: playerId,
    version,
  };
}

function createSerializableReadonlyMap(
  source: ReadonlyMap<number, number>
): ReadonlyMap<number, number> {
  const map = new Map(source) as unknown as ReadonlyMap<number, number> & {
    toJSON: () => Record<number, number>;
  };

  Object.defineProperty(map, "toJSON", {
    value: () => {
      const record: Record<number, number> = {};
      for (const [seat, amount] of map.entries()) {
        record[seat] = amount;
      }
      return record;
    },
    enumerable: false,
  });

  return map;
}

/**
 * Get visible cards for a player based on shownCards and viewer permissions
 * Returns null (all hidden), full hand, or partial hand with positional context preserved
 *
 * Examples:
 * - Full hand: ["As", "Kd"]
 * - Mucked: null
 * - Right card only (index 1): [null, "Kd"]
 * - Left card only (index 0): ["As", null]
 */
function getVisibleHand(
  state: GameState,
  player: Player,
  viewerId: string | null
): ReadonlyArray<string | null> | null {
  // Always hide if player has no hand
  if (!player.hand || player.hand.length === 0) {
    return null;
  }

  // Show full hand to the player themselves
  if (viewerId === player.id) {
    return player.hand;
  }

  // For opponents/spectators, respect shownCards at showdown
  if (state.street === Street.SHOWDOWN) {
    if (player.status === PlayerStatus.ACTIVE || player.status === PlayerStatus.ALL_IN) {
      // Check shownCards to determine visibility
      if (player.shownCards === null) {
        // Mucked - hide all cards
        return null;
      } else if (player.shownCards && player.shownCards.length > 0) {
        // Map over original hand, showing only specified indices
        // Preserve positional context by using null for hidden cards
        const visibleCards = player.hand.map((card, idx) => {
          const isShown = player.shownCards!.includes(idx);
          return isShown ? card : null;
        });
        return visibleCards;
      }
      // If shownCards is empty array, hide all but preserve structure
      return player.hand.map(() => null);
    }
  }

  // Hide in all other cases (pre-showdown)
  return null;
}

/**
 * Create spectator view (no player-specific information)
 */
export function createSpectatorView(state: GameState): PublicState {
  return createPublicView(state, null);
}

/**
 * Sanitize action history to remove sensitive information
 * (Currently action history doesn't contain card info, but this is for future-proofing)
 */
export function sanitizeActionHistory(
  state: GameState,
  _viewerId: string | null
): typeof state.actionHistory {
  // For now, action history is safe to show
  // Future: might want to hide bet amounts in tournament play
  return state.actionHistory;
}
