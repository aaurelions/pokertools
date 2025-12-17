import { ActionType } from "./Action";

/**
 * Whitelist of gameplay actions allowed through the main API endpoint.
 *
 * Management actions (SIT, ADD_CHIPS, RESERVE_SEAT) require financial checks
 * and must go through dedicated endpoints, not the raw action endpoint.
 *
 * **IMPORTANT**: When adding new action types to the engine, ensure they are
 * added to this whitelist if they should be accessible through the API.
 */
export const ALLOWED_GAMEPLAY_ACTIONS: readonly ActionType[] = [
  ActionType.DEAL,
  ActionType.CHECK,
  ActionType.CALL,
  ActionType.RAISE,
  ActionType.BET,
  ActionType.FOLD,
  ActionType.SHOW,
  ActionType.MUCK,
  ActionType.TIME_BANK,
  ActionType.STAND,
  ActionType.NEXT_BLIND_LEVEL, // Tournament blind progression
] as const;

/**
 * Type guard to check if an action type is allowed
 */
export function isAllowedGameplayAction(type: ActionType): boolean {
  return ALLOWED_GAMEPLAY_ACTIONS.includes(type);
}
