/// <reference types="vitest/globals" />
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import type { FastifyInstance } from "fastify";
import {
  CanonicalClient,
  PACKAGE_DIR,
  bootApp,
  cleanupFixtures,
  createTable,
  grantChips,
  loginWallet,
  seatPrincipal,
  startHand,
  type AcceptanceApp,
  type WalletPrincipal,
} from "./harness.js";

// Keep the scheduled action timeout short for the race.
process.env.ACTION_TIMEOUT_SECONDS = "1";

function waitForOutput(child: ChildProcess, marker: string, timeoutMs = 30_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`worker did not report ${marker}`)), timeoutMs);
    const onData = (chunk: Buffer) => {
      if (chunk.toString().includes(marker)) {
        clearTimeout(timer);
        child.stdout?.off("data", onData);
        resolve();
      }
    };
    child.stdout?.on("data", onData);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`worker exited early with code ${code}`));
    });
  });
}

/**
 * Timeout / action race acceptance.
 *
 * A real client action races the scheduled player-timeout worker running in a
 * SEPARATE OS process for the same canonical turn. Exactly one mutation may
 * apply; the turn may not advance twice and no duplicate event may exist.
 */
describe("canonical timeout/action race acceptance", () => {
  let ctx: AcceptanceApp;
  let app: FastifyInstance;
  let playerA: WalletPrincipal;
  let playerB: WalletPrincipal;
  let tableId: string;
  let worker: ChildProcess;

  beforeAll(async () => {
    ctx = await bootApp();
    app = ctx.app;
    worker = spawn(
      process.execPath,
      ["--import", "tsx", "tests/acceptance/canonical/timeout-worker-main.ts"],
      {
        cwd: PACKAGE_DIR,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
    await waitForOutput(worker, "canonical-timeout-worker:started");

    playerA = await loginWallet(ctx.baseUrl);
    playerB = await loginWallet(ctx.baseUrl);
    tableId = await createTable(ctx.baseUrl, playerA.token, {
      name: "race-table",
      smallBlind: 1,
      bigBlind: 2,
      maxPlayers: 2,
    });
    await grantChips(app, playerA.id, 2000);
    await grantChips(app, playerB.id, 2000);
    await seatPrincipal(ctx.baseUrl, playerA, tableId, 0, 1000);
    await seatPrincipal(ctx.baseUrl, playerB, tableId, 1, 1000);
  }, 60_000);

  afterAll(async () => {
    worker?.kill("SIGKILL");
    if (app) {
      await cleanupFixtures(app, {
        tableIds: [tableId],
        userIds: [playerA?.id, playerB?.id].filter((id): id is string => Boolean(id)),
      }).catch(() => undefined);
      await ctx.close().catch(() => undefined);
    }
  });

  it("applies exactly one mutation when a client action races the timeout worker", async () => {
    const started = await startHand(ctx.baseUrl, tableId, [playerA, playerB]);
    const actorId = started.observation.state.players[started.observation.state.actionTo!]?.id;
    const actor = actorId === playerA.id ? playerA : playerB;
    const client = new CanonicalClient(ctx.baseUrl, actor);
    const turn = await client.observation(tableId);
    expect(turn.turnId).not.toBeNull();
    const baselineVersion = turn.version;
    const action = turn.legalActions.find((candidate) => candidate.family === "FOLD")!;
    const deadline = await app.prisma.gameOutbox.findFirstOrThrow({
      where: {
        tableId,
        kind: "player-timeout",
        dedupeKey: `timeout:${tableId}:${turn.state.actionTo}:${baselineVersion}`,
      },
    });
    expect(deadline.status, deadline.lastError ?? "timeout was not dispatched").toBe("DISPATCHED");
    const queued = await app.jobQueues["player-timeout"].getJob(deadline.id);
    expect(queued).not.toBeUndefined();
    // Redis is transport, not action identity authority. Even corrupt job data
    // must execute only the PostgreSQL-bound turn (or its stale-version no-op).
    await queued!.updateData({
      tableId: "wrong-table",
      playerId: "wrong-player",
      expectedVersion: -1,
    });
    const completed = waitForOutput(worker, `canonical-timeout-worker:completed:${deadline.id}`);
    // Synchronize against the persisted deadline, not an arbitrary startup sleep.
    await delay(Math.max(0, deadline.availableAt.getTime() - Date.now()));

    const raced = await client.act(tableId, {
      requestId: crypto.randomUUID(),
      turnId: turn.turnId!,
      expectedVersion: baselineVersion,
      actionId: action.actionId,
    });
    // Either the client won (200) or the timeout worker won first (409).
    expect([200, 409]).toContain(raced.status);

    await completed;

    const events = await app.prisma.gameEvent.findMany({
      where: { tableId },
      orderBy: { eventSeq: "asc" },
    });
    expect(events[0].eventSeq).toBe(1);
    // A single accepted action may emit more than one event at the same
    // version; the invariant is that the turn advanced by exactly one version
    // (one of client action / timeout applied, never both) and no version was
    // skipped or repeated.
    for (let index = 1; index < events.length; index++)
      expect(events[index].eventSeq).toBe(events[index - 1].eventSeq + 1);
    expect(events.every((event) => event.version <= baselineVersion + 1)).toBe(true);
    expect(events.some((event) => event.version === baselineVersion + 1)).toBe(true);

    const after = await client.observation(tableId);
    expect(after.version).toBe(baselineVersion + 1);
  }, 30_000);

  it("restores a lost dispatched deadline from PostgreSQL and makes the original client turn stale", async () => {
    // Start a new table so the prior race's outcome cannot pre-create this turn.
    const recoveredTable = await createTable(ctx.baseUrl, playerA.token, {
      name: "lost-timeout",
      smallBlind: 1,
      bigBlind: 2,
      maxPlayers: 2,
    });
    try {
      await seatPrincipal(ctx.baseUrl, playerA, recoveredTable, 0, 500);
      await seatPrincipal(ctx.baseUrl, playerB, recoveredTable, 1, 500);
      const started = await startHand(ctx.baseUrl, recoveredTable, [playerA, playerB]);
      const actorId = started.observation.state.players[started.observation.state.actionTo!]?.id;
      const client = new CanonicalClient(ctx.baseUrl, actorId === playerA.id ? playerA : playerB);
      const turn = await client.observation(recoveredTable);
      const action = turn.legalActions.find((candidate) => candidate.family === "FOLD")!;
      const deadline = await app.prisma.gameOutbox.findFirstOrThrow({
        where: { tableId: recoveredTable, kind: "player-timeout", status: "DISPATCHED" },
        orderBy: { createdAt: "desc" },
      });
      const job = await app.jobQueues["player-timeout"].getJob(deadline.id);
      expect(job).toBeDefined();
      // Actual Redis loss of a delivered queue job; the recovery sweep must
      // rebuild it from the original PostgreSQL deadline and version fence.
      await job!.remove();
      const completed = waitForOutput(worker, `canonical-timeout-worker:completed:${deadline.id}`);
      await completed;
      const after = await client.observation(recoveredTable);
      expect(after.version).toBe(turn.version + 1);
      const stale = await client.act(recoveredTable, {
        requestId: crypto.randomUUID(),
        turnId: turn.turnId!,
        expectedVersion: turn.version,
        actionId: action.actionId,
      });
      expect(stale.status).toBe(409);
      expect((await client.observation(recoveredTable)).version).toBe(after.version);
    } finally {
      await cleanupFixtures(app, { tableIds: [recoveredTable] });
    }
  });
});
