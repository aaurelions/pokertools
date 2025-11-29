import { GameState, SitAction, StandAction, Player, PlayerStatus } from "@pokertools/types";
import { getPlayerById } from "../utils/positioning";

/**
 * Handle SIT action - add player to table
 */
export function handleSit(state: GameState, action: SitAction): GameState {
  const newPlayer: Player = {
    id: action.playerId,
    name: action.playerName,
    seat: action.seat,
    stack: action.stack,
    hand: null,
    shownCards: null,
    status: PlayerStatus.WAITING,
    betThisStreet: 0,
    totalInvestedThisHand: 0,
    isSittingOut: false,
    timeBank: state.config.timeBankSeconds ?? 30,
  };

  const newPlayers = [...state.players];
  newPlayers[action.seat] = newPlayer;

  // Add to time banks
  const newTimeBanks = new Map(state.timeBanks);
  newTimeBanks.set(action.seat, newPlayer.timeBank);

  return {
    ...state,
    players: newPlayers,
    timeBanks: newTimeBanks,
    timestamp: action.timestamp!,
  };
}

/**
 * Handle STAND action - remove player from table
 */
export function handleStand(state: GameState, action: StandAction): GameState {
  const result = getPlayerById(state, action.playerId);
  if (!result) {
    return state;
  }

  const { seat } = result;
  const newPlayers = [...state.players];
  newPlayers[seat] = null;

  // Remove from time banks
  const newTimeBanks = new Map(state.timeBanks);
  newTimeBanks.delete(seat);

  // Remove from active players if present
  const newActivePlayers = state.activePlayers.filter((s) => s !== seat);

  return {
    ...state,
    players: newPlayers,
    activePlayers: newActivePlayers,
    timeBanks: newTimeBanks,
    timestamp: action.timestamp!,
  };
}
