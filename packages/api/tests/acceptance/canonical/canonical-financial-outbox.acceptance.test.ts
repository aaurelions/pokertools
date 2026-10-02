import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { expect, it } from "vitest";
import {
  bootApp,
  cleanupFixtures,
  createTable,
  grantChips,
  loginWallet,
  PACKAGE_DIR,
  playHand,
  seatPrincipal,
  acceptanceEnv,
} from "./harness.js";
import { flushRedis } from "./infra.js";

function output(child: ChildProcess, marker: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`production worker did not report ${marker}`)),
      30_000
    );
    child.stdout!.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes(marker)) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`worker exited: ${code}`));
    });
  });
}

it("recovers real settlement after Redis loss and a crash at the journal-before-outbox-ack boundary", async () => {
  const ctx = await bootApp();
  const app = ctx.app;
  const players = [await loginWallet(ctx.baseUrl), await loginWallet(ctx.baseUrl)];
  // Operator bootstrap is configuration, not a financial grant. Settlement
  // discovers the same HOUSE principal required by the deployment seed.
  const house = await loginWallet(ctx.baseUrl);
  await app.prisma.user.update({
    where: { id: house.id },
    data: { username: "HOUSE", role: "ADMIN" },
  });
  const tableId = await createTable(ctx.baseUrl, players[0].token, {
    name: "durable settlement",
    smallBlind: 1,
    bigBlind: 2,
    maxPlayers: 2,
  });
  let worker: ChildProcess | null = null;
  const unexpectedFailures: string[] = [];
  let expectedFailureId = "";
  async function stop() {
    if (worker && worker.exitCode === null) {
      const exited = once(worker, "exit");
      worker.kill("SIGKILL");
      await exited;
    }
    worker = null;
  }
  function start() {
    worker = spawn(
      process.execPath,
      ["--import", "tsx", "tests/acceptance/canonical/timeout-worker-main.ts"],
      {
        cwd: PACKAGE_DIR,
        env: { ...process.env, POKERTOOLS_ACCEPTANCE_HAND_WORKERS: "true" },
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
    worker.stderr!.on("data", (chunk) => process.stderr.write(chunk));
    worker.stdout!.on("data", (chunk) => {
      const text = chunk.toString();
      process.stdout.write(chunk);
      for (const match of text.matchAll(/canonical-hand-worker:failed:([^:]+):/g)) {
        if (match[1] !== expectedFailureId) unexpectedFailures.push(match[1]);
      }
    });
    return worker;
  }
  try {
    for (let seat = 0; seat < 2; seat++) {
      await grantChips(app, players[seat].id, 2000);
      await seatPrincipal(ctx.baseUrl, players[seat], tableId, seat, 1000);
    }
    const settled = await playHand(ctx.baseUrl, tableId, players);
    const handId = `${tableId}_${settled.state.handId}`;
    const intent = await app.prisma.gameOutbox.findUniqueOrThrow({
      where: { dedupeKey: `settle:${handId}` },
    });
    const archive = await app.prisma.gameOutbox.findUniqueOrThrow({
      where: { dedupeKey: `archive:${handId}` },
    });
    expectedFailureId = intent.id;
    expect(intent.status, intent.lastError ?? "").toBe("DISPATCHED");
    expect(await app.prisma.chipLedgerEntry.count({ where: { referenceId: handId } })).toBe(0);
    // Real PostgreSQL failure AFTER the financial transaction commits but
    // BEFORE its durable outbox acknowledgement. No financial state is seeded.
    expect(intent.id).toMatch(/^[a-z0-9]+$/i);
    await app.prisma.$executeRawUnsafe(
      `CREATE FUNCTION acceptance_ack_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id = '${intent.id}' AND NEW.status = 'COMPLETED' THEN RAISE EXCEPTION 'acceptance lost acknowledgement'; END IF; RETURN NEW; END $$`
    );
    await app.prisma.$executeRawUnsafe(
      `CREATE TRIGGER acceptance_ack_failure BEFORE UPDATE ON "GameOutbox" FOR EACH ROW EXECUTE FUNCTION acceptance_ack_failure()`
    );
    await flushRedis(acceptanceEnv().redisUrl);
    expect(await app.jobQueues["settle-hand"].getJob(intent.id)).toBeUndefined();
    expect(await app.jobQueues["archive-hand"].getJob(archive.id)).toBeUndefined();
    const child = start();
    await Promise.all([
      output(child, `canonical-hand-worker:failed:${intent.id}`),
      output(child, `canonical-hand-worker:completed:${archive.id}`),
    ]);
    await stop();

    const postings = await app.prisma.chipLedgerEntry.findMany({
      where: { referenceId: handId },
      orderBy: { id: "asc" },
    });
    expect(postings.length).toBeGreaterThan(0);
    expect(postings.reduce((sum, row) => sum + row.amount, 0n)).toBe(0n);
    const accounts = await app.prisma.chipAccount.findMany({
      where: { scopeKey: tableId },
      orderBy: { id: "asc" },
    });
    for (const player of settled.state.players.filter((player) => player !== null)) {
      expect(accounts.find((account) => account.principalId === player.id)?.balance).toBe(
        BigInt(player.stack)
      );
    }
    expect(
      (await app.prisma.gameOutbox.findUniqueOrThrow({ where: { id: intent.id } })).status
    ).toBe("DISPATCHED");
    await app.prisma.$executeRawUnsafe(`DROP TRIGGER acceptance_ack_failure ON "GameOutbox"`);
    await app.prisma.$executeRawUnsafe(`DROP FUNCTION acceptance_ack_failure()`);
    await flushRedis(acceptanceEnv().redisUrl);
    expect(await app.jobQueues["settle-hand"].getJob(intent.id)).toBeUndefined();
    await output(start(), `canonical-hand-worker:completed:${intent.id}`);
    await stop();
    expect(
      (await app.prisma.gameOutbox.findUniqueOrThrow({ where: { id: intent.id } })).status
    ).toBe("COMPLETED");
    expect(
      await app.prisma.chipLedgerEntry.findMany({
        where: { referenceId: handId },
        orderBy: { id: "asc" },
      })
    ).toEqual(postings);
    expect(
      await app.prisma.chipAccount.findMany({
        where: { scopeKey: tableId },
        orderBy: { id: "asc" },
      })
    ).toEqual(accounts);
    expect(await app.prisma.handHistory.findUnique({ where: { id: handId } })).not.toBeNull();
    expect(unexpectedFailures).toEqual([]);
  } finally {
    await stop();
    await app.prisma.$executeRawUnsafe(
      `DROP TRIGGER IF EXISTS acceptance_ack_failure ON "GameOutbox"`
    );
    await app.prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS acceptance_ack_failure()`);
    await cleanupFixtures(app, {
      tableIds: [tableId],
      userIds: [...players.map((player) => player.id), house.id],
    });
    await ctx.close();
  }
}, 90_000);
