import { GameState } from "./GameState";
import { Player } from "./Player";

/**
 * Public player with potentially masked cards
 * In public views, hand can have null elements to preserve positional context
 * Examples:
 * - ["As", "Kd"] - both cards visible
 * - [null, "Kd"] - only right card visible
 * - ["As", null] - only left card visible
 * - null - all cards hidden (mucked or pre-showdown)
 */
export interface PublicPlayer extends Omit<Player, "hand"> {
  readonly hand: ReadonlyArray<string | null> | null;
}

/**
 * Public view of game state with hidden information masked
 * Used to send to clients to prevent cheating
 */
export interface PublicState extends Omit<GameState, "deck" | "players"> {
  readonly deck: readonly number[]; // Always empty (hidden)
  readonly players: ReadonlyArray<PublicPlayer | null>; // Players with masked cards
  readonly viewingPlayerId: string | null; // null = spectator view
}
