/**
 * PokerStars hand history format exporter
 *
 * Format specification based on PokerStars hand history text format
 */

import { HandHistory, StreetHistory, ActionRecord, ExportOptions } from "../types";
import { Street, ActionType } from "@pokertools/types";

/**
 * Export hand history to PokerStars format
 */
export function exportToPokerStars(
  history: HandHistory,
  options: ExportOptions = { format: "pokerstars" }
): string {
  const lines: string[] = [];

  // Header line
  lines.push(buildHeader(history));
  lines.push(buildTableInfo(history));

  // Button and seats
  lines.push(`Button: seat #${history.buttonSeat + 1}`);
  lines.push("");

  // Player stacks
  for (const player of history.players) {
    lines.push(
      `Seat ${player.seat + 1}: ${player.name} ($${player.startingStack.toFixed(2)} in chips)`
    );
  }
  lines.push("");

  // Blinds and antes
  lines.push(buildBlindsLine(history));
  if (history.stakes.ante > 0) {
    lines.push(buildAntesLine(history));
  }

  // Hole cards (dealt to)
  lines.push(buildHoleCardsLine(history, options));

  // Each street
  for (const street of history.streets) {
    lines.push("");
    lines.push(buildStreetHeader(street));

    for (const action of street.actions) {
      lines.push(buildActionLine(action, history));
    }
  }

  // Summary
  lines.push("");
  lines.push(buildSummary(history));

  return lines.join("\n");
}

/**
 * Build header line
 */
function buildHeader(history: HandHistory): string {
  const date = new Date(history.timestamp);
  const dateStr = formatPokerStarsDate(date);

  return `PokerStars Hand #${history.handId}: Hold'em No Limit ($${history.stakes.smallBlind}/$${history.stakes.bigBlind}) - ${dateStr}`;
}

/**
 * Build table info line
 */
function buildTableInfo(history: HandHistory): string {
  return `Table '${history.tableName}' ${history.maxPlayers}-max`;
}

/**
 * Build blinds posting line
 */
function buildBlindsLine(history: HandHistory): string {
  const lines: string[] = [];

  // Find SB and BB seats (button+1 and button+2)
  const sbSeat = (history.buttonSeat + 1) % history.maxPlayers;
  const bbSeat = (history.buttonSeat + 2) % history.maxPlayers;

  const sbPlayer = history.players.find((p) => p.seat === sbSeat);
  const bbPlayer = history.players.find((p) => p.seat === bbSeat);

  if (sbPlayer) {
    lines.push(`${sbPlayer.name}: posts small blind $${history.stakes.smallBlind.toFixed(2)}`);
  }

  if (bbPlayer) {
    lines.push(`${bbPlayer.name}: posts big blind $${history.stakes.bigBlind.toFixed(2)}`);
  }

  return lines.join("\n");
}

/**
 * Build antes line
 */
function buildAntesLine(history: HandHistory): string {
  const lines: string[] = [];

  for (const player of history.players) {
    lines.push(`${player.name}: posts ante $${history.stakes.ante.toFixed(2)}`);
  }

  return lines.join("\n");
}

/**
 * Build hole cards line
 */
function buildHoleCardsLine(history: HandHistory, options: ExportOptions): string {
  // In PokerStars format, only show hero's cards
  // For analysis mode, show all cards
  if (options.includeHoleCards) {
    const lines: string[] = ["*** HOLE CARDS ***"];
    for (const player of history.players) {
      if (player.cards && player.cards.length > 0) {
        lines.push(`Dealt to ${player.name} [${player.cards.join(" ")}]`);
      }
    }
    return lines.join("\n");
  } else {
    return "*** HOLE CARDS ***";
  }
}

/**
 * Build street header
 */
function buildStreetHeader(street: StreetHistory): string {
  switch (street.street) {
    case Street.FLOP:
      return `*** FLOP *** [${street.board.join(" ")}]`;
    case Street.TURN:
      return `*** TURN *** [${street.board.slice(0, 3).join(" ")}] [${street.board[3]}]`;
    case Street.RIVER:
      return `*** RIVER *** [${street.board.slice(0, 4).join(" ")}] [${street.board[4]}]`;
    case Street.SHOWDOWN:
      return "*** SHOW DOWN ***";
    default:
      return "";
  }
}

/**
 * Build action line
 */
function buildActionLine(action: ActionRecord, history: HandHistory): string {
  const player = history.players.find((p) => p.seat === action.seat);
  const name = player?.name ?? `Player ${action.seat + 1}`;

  switch (action.action.type) {
    case ActionType.FOLD:
      return `${name}: folds`;

    case ActionType.CHECK:
      return `${name}: checks`;

    case ActionType.CALL:
      const callAmount = action.amount ?? 0;
      if (action.isAllIn) {
        return `${name}: calls $${callAmount.toFixed(2)} and is all-in`;
      }
      return `${name}: calls $${callAmount.toFixed(2)}`;

    case ActionType.BET:
      const betAmount = action.amount ?? 0;
      if (action.isAllIn) {
        return `${name}: bets $${betAmount.toFixed(2)} and is all-in`;
      }
      return `${name}: bets $${betAmount.toFixed(2)}`;

    case ActionType.RAISE:
      const raiseAmount = action.amount ?? 0;
      if (action.isAllIn) {
        return `${name}: raises to $${raiseAmount.toFixed(2)} and is all-in`;
      }
      return `${name}: raises to $${raiseAmount.toFixed(2)}`;

    default:
      return `${name}: ${action.action.type.toLowerCase()}`;
  }
}

/**
 * Build summary section
 */
function buildSummary(history: HandHistory): string {
  const lines: string[] = ["*** SUMMARY ***"];

  lines.push(`Total pot $${history.totalPot.toFixed(2)}`);
  lines.push(`Button: seat #${history.buttonSeat + 1}`);

  // Board
  const lastStreet = history.streets[history.streets.length - 1];
  if (lastStreet && lastStreet.board.length > 0) {
    lines.push(`Board [${lastStreet.board.join(" ")}]`);
  }

  // Winners
  for (const winner of history.winners) {
    const handInfo = winner.handRank ? ` with ${winner.handRank}` : "";
    lines.push(
      `Seat ${winner.seat + 1}: ${winner.playerName} won ($${winner.amount.toFixed(2)})${handInfo}`
    );
  }

  return lines.join("\n");
}

/**
 * Format date in PokerStars format
 */
function formatPokerStarsDate(date: Date): string {
  // Use UTC to avoid timezone misrepresentation
  // Server's local time zone should not affect hand history exports
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  const hours = String(date.getUTCHours()).padStart(2, "0");
  const minutes = String(date.getUTCMinutes()).padStart(2, "0");
  const seconds = String(date.getUTCSeconds()).padStart(2, "0");

  return `${year}/${month}/${day} ${hours}:${minutes}:${seconds} UTC`;
}
