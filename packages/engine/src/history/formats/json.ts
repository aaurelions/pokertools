/**
 * JSON hand history format exporter
 *
 * Machine-readable format for analysis and storage
 */

import { HandHistory, ExportOptions } from "../types";

/**
 * Export hand history to JSON format
 */
export function exportToJSON(
  history: HandHistory,
  options: ExportOptions = { format: "json" }
): string {
  // Create sanitized version based on options
  const sanitized = sanitizeHandHistory(history, options);

  if (options.format === "compact") {
    return JSON.stringify(sanitized);
  }

  return JSON.stringify(sanitized, null, 2);
}

/**
 * Sanitize hand history based on export options
 */
function sanitizeHandHistory(history: HandHistory, options: ExportOptions): HandHistory {
  if (options.includeHoleCards) {
    return history;
  }

  // Remove hole cards for privacy
  return {
    ...history,
    players: history.players.map((player) => ({
      ...player,
      cards: undefined,
    })),
    winners: history.winners.map((winner) => ({
      ...winner,
      hand: winner.handRank ? winner.hand : undefined, // Keep if shown at showdown
    })),
  };
}

/**
 * Parse hand history from JSON
 */
export function parseFromJSON(json: string): HandHistory {
  return JSON.parse(json) as HandHistory;
}
