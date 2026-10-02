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
    worker = spawn("npx", ["tsx", "tests/acceptance/canonical/timeout-worker-main.ts"], {
      cwd: PACKAGE_DIR,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
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

    const raced = await client.act(tableId, {
      requestId: crypto.randomUUID(),
      turnId: turn.turnId!,
      expectedVersion: baselineVersion,
      actionId: action.actionId,
    });
    // Either the client won (200) or the timeout worker won first (409).
    expect([200, 409]).toContain(raced.status);

    // Let the scheduled timeout fire well past its delay.
    await delay(2500);

    const events = await app.prisma.gameEvent.findMany({
      where: { tableId },
      orderBy: { eventSeq: "asc" },
    });
    // A single accepted action may emit more than one event at the same
    // version; the invariant is that the turn advanced by exactly one version
    // (one of client action / timeout applied, never both) and no version was
    // skipped or repeated.
    expect(events.map((event) => event.eventSeq)).toEqual(
      [...events.map((event) => event.eventSeq)].sort((left, right) => left - right)
    );
    expect(events.every((event) => event.version <= baselineVersion + 1)).toBe(true);
    expect(events.some((event) => event.version === baselineVersion + 1)).toBe(true);

    const after = await client.observation(tableId);
    expect(after.version).toBe(baselineVersion + 1);
  }, 30_000);
});
