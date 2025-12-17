/**
 * Main hand history exporter
 */

import { GameState, HandHistory, ExportOptions } from "@pokertools/types";
import { buildHandHistory } from "./handHistoryBuilder";
import { exportToPokerStars } from "./formats/pokerstars";
import { exportToJSON } from "./formats/json";

/**
 * Export hand history from game state
 *
 * @param state Final game state (after hand is complete)
 * @param options Export options
 * @returns Formatted hand history string
 */
export function exportHandHistory(
  state: GameState,
  options: ExportOptions = { format: "json" }
): string {
  // Build structured history
  const history = buildHandHistory(state);

  // Export to requested format
  switch (options.format) {
    case "pokerstars":
      return exportToPokerStars(history, options);
    case "json":
      return exportToJSON(history, options);
    case "compact":
      return exportToJSON(history, { ...options, format: "compact" });
    default:
      return exportToJSON(history, options);
  }
}

/**
 * Build hand history object without formatting
 *
 * @param state Final game state
 * @returns Structured hand history object
 */
export function getHandHistory(state: GameState): HandHistory {
  return buildHandHistory(state);
}

/**
 * Export multiple hands to a single file
 *
 * @param states Array of final game states
 * @param options Export options
 * @returns Formatted multi-hand history
 */
export function exportMultipleHands(
  states: GameState[],
  options: ExportOptions = { format: "json" }
): string {
  if (options.format === "pokerstars") {
    // PokerStars format: separate hands with blank lines
    return states.map((state) => exportHandHistory(state, options)).join("\n\n\n");
  } else {
    // JSON format: array of hands
    const histories = states.map((state) => buildHandHistory(state));
    return JSON.stringify(histories, null, options.format === "compact" ? 0 : 2);
  }
}
