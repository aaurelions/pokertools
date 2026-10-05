import type { Prisma } from "../../generated/prisma/index.js";
import { ActionType } from "@pokertools/types";
import { MAX_RECONCILE_ITERATIONS } from "../utils/tournaments.js";
import { AppError } from "../utils/errors.js";
import { loadAuthoritativeTable, type Snapshot } from "./game-repository.js";
import {
  acquireTournamentLockBestEffort,
  lockTableRows,
  lockTournamentRow,
  type TournamentDirectorContext,
} from "./tournament-lifecycle.js";
import { recordTournamentEvent, tournamentStateFingerprint } from "./tournament-events.js";

/**
 * Tournament director reconciliation.
 *
 * Detects live stacks across all tournament tables, updates eliminated entries
 * with unique placements, rebalances tables, breaks short tables and merges to
 * the final table when remaining players fit on one table.
 *
 * PostgreSQL is the sole authority: one serialized transaction on the
 * tournament row (plus sorted table row locks) re-reads the relational entries
 * and the authoritative `Table.state` snapshots through the same transaction.
 * Every STAND/SIT move and the first DEAL go through
 * `GameManager.applyManagementMutationInTx`, so engine CAS, ordered events and
 * the transactional outbox commit together with the placement/assignment
 * updates. There is no cache read and no manual compensation path: a failure
 * anywhere rolls the whole reconciliation back and no player is ever stranded.
 *
 * Redis (Redlock) is only a best-effort contention optimization; correctness
 * does not depend on it being available.
 */

type Tx = Prisma.TransactionClient;

interface LivePlayer {
  entryId: string;
  userId: string;
  username: string;
  stack: number;
  tableId: string;
  seat: number;
}

async function readSnapshotInTx(tx: Tx, tableId: string): Promise<Snapshot> {
  const record = await loadAuthoritativeTable(tx, tableId);
  if (!record || !record.snapshot) {
    throw Object.assign(new Error(`Unable to read tournament table state for ${tableId}`), {
      statusCode: 503,
      code: "TOURNAMENT_STATE_UNAVAILABLE",
    });
  }
  return record.snapshot;
}

/**
 * A table can accept or release players only at a settled hand boundary:
 * either no hand was ever dealt, or the last hand has winners and no pending
 * action. A zero uncommitted stack may be all-in, not busted.
 */
async function canMovePlayerInTx(tx: Tx, tableId: string): Promise<boolean> {
  try {
    const snapshot = await readSnapshotInTx(tx, tableId);
    if (snapshot.handNumber === 0 && snapshot.actionTo == null) return true;
    return Boolean(snapshot.winners && snapshot.winners.length > 0 && snapshot.actionTo == null);
  } catch {
    return false;
  }
}

async function findOpenSeatInTx(tx: Tx, tableId: string): Promise<number> {
  const snapshot = await readSnapshotInTx(tx, tableId);
  for (let seat = 0; seat < snapshot.players.length; seat++) {
    if (snapshot.players[seat] === null) return seat;
  }
  throw new Error(`No open seats on table ${tableId}`);
}

/**
 * Move a player between tables inside the director transaction. A failure
 * aborts the whole transaction, so there is no partial STAND and no stranded
 * player to compensate for.
 */
async function movePlayerInTx(
  context: TournamentDirectorContext,
  tx: Tx,
  player: LivePlayer,
  destTableId: string,
  destSeat: number,
  actorUserId: string
): Promise<void> {
  await context.gameManager.applyManagementMutationInTx(
    tx,
    player.tableId,
    actorUserId,
    { type: ActionType.STAND, playerId: player.userId },
    { skipIdentity: true }
  );
  await context.gameManager.applyManagementMutationInTx(
    tx,
    destTableId,
    actorUserId,
    {
      type: ActionType.SIT,
      playerId: player.userId,
      playerName: player.username,
      seat: destSeat,
      stack: player.stack,
    },
    { skipIdentity: true }
  );
  await tx.tournamentEntry.update({
    where: { id: player.entryId },
    data: { currentTableId: destTableId, currentSeat: destSeat },
  });
}

/**
 * Close a table only when no ACTIVE entry is assigned to it and its
 * authoritative snapshot holds no live stack. The close and its durable audit
 * event commit in the director transaction.
 */
async function closeEmptyTournamentTableInTx(tx: Tx, tableId: string): Promise<boolean> {
  const assigned = await tx.tournamentEntry.count({
    where: { currentTableId: tableId, status: "ACTIVE" },
  });
  if (assigned > 0) return false;
  const snapshot = await readSnapshotInTx(tx, tableId);
  if (snapshot.players.some((player) => player && player.stack > 0)) return false;
  const table = await tx.table.findUnique({
    where: { id: tableId },
    select: { tournamentId: true, status: true },
  });
  if (!table || table.status === "CLOSED") return true;
  await tx.table.update({ where: { id: tableId }, data: { status: "CLOSED" } });
  if (table.tournamentId) {
    await recordTournamentEvent(tx, {
      tournamentId: table.tournamentId,
      type: "TABLE_CLOSED",
      payload: { tableId },
      stateFingerprint: `table-closed:${tableId}`,
      requestRef: null,
    });
  }
  return true;
}

/**
 * One reconciliation pass against the authoritative transaction state.
 * Returns `"retry"` when the caller should run another bounded pass (a move or
 * table break changed the layout), `"done"` otherwise.
 */
async function reconcileOnce(
  context: TournamentDirectorContext,
  tx: Tx,
  tournamentId: string,
  actorUserId: string
): Promise<"retry" | "done"> {
  const t = await tx.tournament.findUniqueOrThrow({
    where: { id: tournamentId },
    include: { entries: true, tables: true },
  });
  if (t.status !== "RUNNING") return "done";

  const tableMax = t.tableMaxPlayers;
  const tolerance = t.balancingTolerance;

  const allLivePlayers: LivePlayer[] = [];
  const tablePlayerCounts = new Map<string, number>();
  const seenActiveUsers = new Set<string>();
  const eliminatedUserIds = new Set<string>();
  const completedTables = new Set<string>();

  for (const table of t.tables) {
    const state = await readSnapshotInTx(tx, table.id);
    let liveCount = 0;
    const players = state.players;
    const completed = Boolean(state.winners?.length && state.actionTo == null);
    if (completed) completedTables.add(table.id);
    for (let seatIdx = 0; seatIdx < players.length; seatIdx++) {
      const player = players[seatIdx];
      if (!player) continue;
      const entry = t.entries.find(
        (candidate) => candidate.userId === player.id && candidate.status === "ACTIVE"
      );
      if (!entry) continue;
      if (seenActiveUsers.has(player.id)) {
        throw new Error("Duplicate tournament seat assignment");
      }
      seenActiveUsers.add(player.id);
      // An all-in player with no uncommitted stack is still competing.
      // Elimination is authoritative only after chips have been awarded.
      if (completed && player.stack === 0) {
        eliminatedUserIds.add(player.id);
        continue;
      }
      allLivePlayers.push({
        entryId: entry.id,
        userId: player.id,
        username: player.name,
        stack: player.stack,
        tableId: table.id,
        seat: seatIdx,
      });
      liveCount++;
    }
    tablePlayerCounts.set(table.id, liveCount);
  }

  for (const entry of t.entries) {
    if (
      entry.status === "ACTIVE" &&
      !seenActiveUsers.has(entry.userId) &&
      entry.currentTableId &&
      completedTables.has(entry.currentTableId)
    ) {
      // Settled pending departures may already have been removed by the engine.
      eliminatedUserIds.add(entry.userId);
    }
  }
  if (
    allLivePlayers.length === 0 ||
    t.entries.some(
      (entry) =>
        entry.status === "ACTIVE" &&
        !seenActiveUsers.has(entry.userId) &&
        !eliminatedUserIds.has(entry.userId)
    )
  ) {
    throw Object.assign(new Error("Tournament seat assignments are inconsistent"), {
      statusCode: 503,
      code: "TOURNAMENT_STATE_UNAVAILABLE",
    });
  }

  // 1. Update eliminated entries with unique placements, computed against the
  // fresh relational state inside this transaction. Placements already
  // assigned are never reused.
  const eliminatedEntries = t.entries.filter(
    (entry) => entry.status === "ACTIVE" && eliminatedUserIds.has(entry.userId)
  );
  if (eliminatedEntries.length > 0) {
    const usedPlacements = new Set(
      t.entries.filter((entry) => entry.placement != null).map((entry) => entry.placement!)
    );
    let candidate = t.entries.length;
    for (const entry of eliminatedEntries) {
      while (usedPlacements.has(candidate)) candidate--;
      if (candidate < 1) {
        throw new Error(`No tournament placement available for entry ${entry.id}`);
      }
      usedPlacements.add(candidate);
      await tx.tournamentEntry.update({
        where: { id: entry.id },
        data: { status: "ELIMINATED", placement: candidate },
      });
    }
  }

  // 2. Clear settled busted seats through the engine, not by editing
  // snapshots. This preserves chip conservation and frees the seat.
  for (const table of t.tables) {
    const state = await readSnapshotInTx(tx, table.id);
    if (!state.winners?.length || state.actionTo != null) continue;
    for (const player of state.players) {
      if (player && player.stack === 0) {
        await context.gameManager.applyManagementMutationInTx(
          tx,
          table.id,
          actorUserId,
          { type: ActionType.STAND, playerId: player.id },
          { skipIdentity: true }
        );
      }
    }
  }

  const liveCount = allLivePlayers.length;
  if (liveCount === 0) return "done";

  // 3. If live players fit on one table, merge to the primary/final table.
  if (liveCount <= tableMax) {
    const finalTableId = t.tableId;
    const primaryTable = t.tables.find((table) => table.id === finalTableId);
    if (!primaryTable) {
      await tx.table.update({
        where: { id: finalTableId },
        data: { status: "ACTIVE" },
      });
    }

    for (const player of allLivePlayers) {
      if (player.tableId === finalTableId) continue;
      if (!(await canMovePlayerInTx(tx, player.tableId))) continue;
      if (!(await canMovePlayerInTx(tx, finalTableId))) continue;

      let destSeat: number;
      try {
        destSeat = await findOpenSeatInTx(tx, finalTableId);
      } catch {
        context.log.warn(
          { tournamentId, playerId: player.userId, finalTableId },
          "Cannot merge player to final table: no open seat available"
        );
        continue;
      }
      await movePlayerInTx(context, tx, player, finalTableId, destSeat, actorUserId);
    }

    // Never close a table with players still assigned to it (including deferred
    // moves while either hand is in progress).
    for (const table of t.tables) {
      if (table.id !== finalTableId) {
        await closeEmptyTournamentTableInTx(tx, table.id);
      }
    }
    return "done";
  }

  // 4. Rebalance: break short tables and balance player counts. Only act on
  // tables that have completed their current hand.
  const movableTables = new Set<string>();
  for (const tableId of tablePlayerCounts.keys()) {
    if (await canMovePlayerInTx(tx, tableId)) movableTables.add(tableId);
  }

  const tablesWithLivePlayers = Array.from(tablePlayerCounts.entries()).filter(
    ([, count]) => count > 0
  );

  // Consolidate completed tables to the minimum capacity, not just tables with
  // one survivor. Four half-full tables must become two, then one final table.
  const requiredTables = Math.ceil(liveCount / tableMax);
  const orderedTables = [...tablesWithLivePlayers].sort(
    (a, b) =>
      Number(b[0] === t.tableId) - Number(a[0] === t.tableId) ||
      b[1] - a[1] ||
      a[0].localeCompare(b[0])
  );
  const destinations = orderedTables.slice(0, requiredTables);
  for (const [sourceId] of orderedTables.slice(requiredTables)) {
    if (!movableTables.has(sourceId)) continue;
    let moved = false;
    for (const player of allLivePlayers.filter((candidate) => candidate.tableId === sourceId)) {
      const target = destinations.find(
        ([id]) => movableTables.has(id) && (tablePlayerCounts.get(id) ?? 0) < tableMax
      );
      if (!target) break;
      let seat: number;
      try {
        seat = await findOpenSeatInTx(tx, target[0]);
      } catch {
        context.log.warn(
          { tournamentId, playerId: player.userId, targetTableId: target[0] },
          "Cannot consolidate player: no open seat on destination table"
        );
        break;
      }
      await movePlayerInTx(context, tx, player, target[0], seat, actorUserId);
      moved = true;
      tablePlayerCounts.set(target[0], (tablePlayerCounts.get(target[0]) ?? 0) + 1);
      tablePlayerCounts.set(sourceId, (tablePlayerCounts.get(sourceId) ?? 0) - 1);
    }
    await closeEmptyTournamentTableInTx(tx, sourceId);
    if (moved) return "retry";
  }
  for (const [id, count] of tablePlayerCounts) {
    if (count === 0) await closeEmptyTournamentTableInTx(tx, id);
  }

  // Find max and min player counts from the current (post-move) layout.
  let maxCount = 0;
  let minCount = Infinity;
  let maxTableId = "";
  let minTableId = "";
  for (const [tableId, count] of tablePlayerCounts) {
    if (count <= 0) continue;
    if (count > maxCount) {
      maxCount = count;
      maxTableId = tableId;
    }
    if (count < minCount) {
      minCount = count;
      minTableId = tableId;
    }
  }

  // 5. Break short tables: if a table has only 1 live player, move them.
  for (const [tableId, count] of tablePlayerCounts) {
    if (count > 1 || count <= 0 || !movableTables.has(tableId)) continue;
    const targetTable = t.tables.find(
      (table) =>
        table.id !== tableId &&
        table.status !== "CLOSED" &&
        movableTables.has(table.id) &&
        (tablePlayerCounts.get(table.id) ?? 0) < tableMax
    );
    if (!targetTable) continue;
    let moved = false;
    for (const player of allLivePlayers.filter((candidate) => candidate.tableId === tableId)) {
      let openSeat: number;
      try {
        openSeat = await findOpenSeatInTx(tx, targetTable.id);
      } catch {
        context.log.warn(
          { tournamentId, playerId: player.userId, targetTableId: targetTable.id },
          "Cannot break short table: no open seat on target table"
        );
        continue;
      }
      await movePlayerInTx(context, tx, player, targetTable.id, openSeat, actorUserId);
      moved = true;
      tablePlayerCounts.set(targetTable.id, (tablePlayerCounts.get(targetTable.id) ?? 0) + 1);
      tablePlayerCounts.set(tableId, (tablePlayerCounts.get(tableId) ?? 0) - 1);
    }
    const closed = await closeEmptyTournamentTableInTx(tx, tableId);
    if (closed && moved) return "retry";
  }

  // 6. Rebalance if max - min > tolerance.
  if (
    maxCount - minCount > tolerance &&
    movableTables.has(maxTableId) &&
    movableTables.has(minTableId) &&
    maxTableId !== minTableId
  ) {
    const playerToMove = allLivePlayers.find((player) => player.tableId === maxTableId);
    if (playerToMove) {
      let destSeat: number;
      try {
        destSeat = await findOpenSeatInTx(tx, minTableId);
      } catch {
        context.log.warn(
          { tournamentId, maxTableId, minTableId },
          "Cannot rebalance: no open seat on min table"
        );
        return "done";
      }
      await movePlayerInTx(context, tx, playerToMove, minTableId, destSeat, actorUserId);
    }
  }

  return "done";
}

/**
 * Authoritative reconciliation entry point. Runs bounded passes inside one
 * serialized database transaction; repeated reconciles accepting the same
 * facts produce the same stable audit fingerprint and append no spurious event.
 */
export async function reconcileTournament(
  context: TournamentDirectorContext,
  tournamentId: string,
  actorUserId: string
): Promise<{ converged: boolean }> {
  const lock = await acquireTournamentLockBestEffort(context, tournamentId);
  // `false` only when the bounded iteration cap deferred work: durable callers
  // must retry instead of acknowledging a partially reconciled tournament.
  let converged = true;
  try {
    await context.prisma.$transaction(
      async (tx) => {
        await lockTournamentRow(tx, tournamentId);

        const existing = await tx.tournament.findUnique({
          where: { id: tournamentId },
          select: { status: true },
        });
        if (!existing) throw new AppError("Tournament not found", 404, "TOURNAMENT_NOT_FOUND");
        if (existing.status !== "RUNNING") return;

        // Sorted table row locks: freeze every table this decision may read or
        // mutate for the duration of the transaction.
        const tables = await tx.table.findMany({
          where: { tournamentId },
          select: { id: true },
        });
        await lockTableRows(
          tx,
          tables.map((table) => table.id)
        );

        let remaining = MAX_RECONCILE_ITERATIONS;
        while (remaining > 0) {
          const outcome = await reconcileOnce(context, tx, tournamentId, actorUserId);
          if (outcome === "done") break;
          remaining--;
        }
        if (remaining <= 0) {
          converged = false;
          context.log.warn(
            { tournamentId, iterations: MAX_RECONCILE_ITERATIONS },
            "Reconciliation iteration limit reached; deferring remaining work to next reconcile call"
          );
        }

        // Durable append-only audit of the accepted reconciliation state,
        // committed with the accepted director work.
        const after = await tx.tournament.findUnique({
          where: { id: tournamentId },
          select: {
            status: true,
            entries: {
              select: {
                id: true,
                status: true,
                placement: true,
                currentTableId: true,
                currentSeat: true,
              },
            },
            tables: { select: { id: true, status: true } },
          },
        });
        if (after && after.status === "RUNNING") {
          await recordTournamentEvent(tx, {
            tournamentId,
            type: "TOURNAMENT_RECONCILED",
            payload: {
              status: after.status,
              tables: after.tables,
              entries: after.entries,
            },
            stateFingerprint: tournamentStateFingerprint(after),
            requestRef: actorUserId,
          });
        }
      },
      { maxWait: 10_000, timeout: 20_000 }
    );
  } finally {
    if (lock) await lock.unlock().catch(() => undefined);
  }
  return { converged };
}
