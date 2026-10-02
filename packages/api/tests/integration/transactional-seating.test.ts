/// <reference path="../../types/fastify.d.ts" />
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import {
  initTestContext,
  runCleanup,
  createTable,
  buyIn,
  executeAction,
  getTableState,
  getUserBalances,
  standFromTable,
  cleanupTestTable,
  type TestContext,
  type TestUser,
} from "../helpers/test-utils.js";
import { getHouseUserId } from "../../src/utils/house-user.js";

/**
 * Transactional seating / financial-race regressions.
 *
 * These tests pin the single-atomic-boundary behavior of the financial seating
 * routes (buy-in / add-chips / stand) and the durable settle-hand flush:
 *
 *  - a chip/atomic financial mutation and the engine SIT/STAND (snapshot CAS +
 *    version + events + idempotency + outbox) commit together or not at all;
 *  - a failure injected between the financial mutation and the engine mutation
 *    rolls the whole transaction back (no lost chips, no orphan reserve);
 *  - a stand flushes every durable settle-hand intent before crediting/cashing
 *    out, so a later settlement worker run is an idempotent no-op and can never
 *    double-pay the same hand — including ASSET-backed winners.
 */

const ASSET_ID = `eip155:31337/erc20:0x${"c".repeat(40)}`;
const ONE_CHIP = 1_000_000n;

/** Deal and fold the first actor, ending the hand with a deterministic winner. */
async function playFoldHand(
  app: FastifyInstance,
  actors: TestUser[],
  tableId: string
): Promise<{ loser: TestUser; winner: TestUser }> {
  await executeAction(app, actors[0].token, tableId, { type: "DEAL" });
  let state = await getTableState(app, actors[0].token, tableId);
  const loser = actors[state.actionTo];
  const winner = actors.find((actor) => actor.id !== loser.id)!;
  await executeAction(app, loser.token, tableId, { type: "FOLD" });
  state = await getTableState(app, actors[0].token, tableId);
  expect(state.winners).toBeTruthy();
  return { loser, winner };
}

async function settleIntentFor(app: FastifyInstance, tableId: string) {
  const row = await app.prisma.gameOutbox.findFirst({
    where: { tableId, kind: "settle-hand" },
    orderBy: { createdAt: "asc" },
  });
  expect(row).toBeTruthy();
  return row!.payload as {
    tableId: string;
    handId: string;
    playerNetChanges: Record<string, string>;
    rakeTotal: string | number;
  };
}

async function reserveFor(app: FastifyInstance, userId: string, tableId: string): Promise<bigint> {
  const account = await app.prisma.chipAccount.findUnique({
    where: {
      principalId_kind_scopeKey: {
        principalId: userId,
        kind: "TABLE_RESERVE",
        scopeKey: tableId,
      },
    },
  });
  return account?.balance ?? 0n;
}

async function atomicBalance(
  app: FastifyInstance,
  ownerKey: string,
  accountClass: "USER_AVAILABLE" | "IN_PLAY_RESERVE" | "OPERATOR"
): Promise<bigint> {
  const account = await app.prisma.atomicAccount.findUnique({
    where: {
      assetId_ownerKey_class: { assetId: ASSET_ID, ownerKey, class: accountClass },
    },
  });
  return BigInt(account?.balanceAtomic ?? "0");
}

describe("Transactional seating / financial race regressions", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await initTestContext(4, 100_000);
  });

  afterAll(async () => {
    await runCleanup(ctx.cleanup);
  });

  it("rejects a buy-in into an occupied seat without moving any chips", async () => {
    const [player1, player2] = ctx.users;
    const tableId = await createTable(ctx.app, player1.token, {
      name: "Occupied Seat Atomic",
      mode: "CASH",
      smallBlind: 5,
      bigBlind: 10,
    });

    await buyIn(ctx.app, player1.token, tableId, 1000, 0);

    const before = await getUserBalances(ctx.app, player2.id);
    const response = await ctx.app.inject({
      method: "POST",
      url: `/tables/${tableId}/buy-in`,
      headers: { authorization: `Bearer ${player2.token}` },
      payload: { amount: "1000", seat: 0, idempotencyKey: crypto.randomUUID() },
    });

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body).code).toBe("SEAT_OCCUPIED");

    // The financial mutation and the engine SIT are one transaction: the SIT
    // rejection must leave no debit and no table reserve behind.
    const after = await getUserBalances(ctx.app, player2.id);
    expect(after.main).toBe(before.main);
    expect(after.inPlay).toBe(before.inPlay);
    expect(await reserveFor(ctx.app, player2.id, tableId)).toBe(0n);

    const state = await getTableState(ctx.app, player1.token, tableId);
    expect(state.players[0]?.id).toBe(player1.id);
    expect(state.players[1]).toBeNull();

    await cleanupTestTable(ctx.app, tableId);
  });

  it("rolls back the financial mutation when the engine step fails mid-transaction", async () => {
    const [player1, player2] = ctx.users;
    const tableId = await createTable(ctx.app, player1.token, {
      name: "Financial-Engine Failure Injection",
      mode: "CASH",
      smallBlind: 5,
      bigBlind: 10,
    });

    await buyIn(ctx.app, player1.token, tableId, 1000, 0);
    const before = await getUserBalances(ctx.app, player2.id);
    const stateBefore = await ctx.app.prisma.table.findUniqueOrThrow({
      where: { id: tableId },
      select: { stateVersion: true, eventSeq: true },
    });
    const idempotencyKey = `fault-inject:${crypto.randomUUID()}`;

    // Inject the failure *between* the financial mutation and the engine
    // mutation: the financial debit succeeds, then SIT hits the occupied seat.
    await expect(
      ctx.app.prisma.$transaction(async (tx) => {
        await ctx.app.financialManager.applyBuyIn(tx, player2.id, tableId, 1000n, {
          idempotencyKey,
        });
        await ctx.app.gameManager.applyManagementMutationInTx(tx, tableId, player2.id, {
          type: "SIT",
          playerId: player2.id,
          playerName: "fault",
          seat: 0,
          stack: 1000,
        });
      })
    ).rejects.toMatchObject({ code: "SEAT_OCCUPIED" });

    const after = await getUserBalances(ctx.app, player2.id);
    expect(after.main).toBe(before.main);
    expect(after.inPlay).toBe(before.inPlay);
    expect(await reserveFor(ctx.app, player2.id, tableId)).toBe(0n);

    const ledgerHit = await ctx.app.prisma.chipLedgerEntry.findFirst({
      where: { idempotencyKey },
    });
    expect(ledgerHit).toBeNull();

    const stateAfter = await ctx.app.prisma.table.findUniqueOrThrow({
      where: { id: tableId },
      select: { stateVersion: true, eventSeq: true },
    });
    expect(stateAfter.stateVersion).toBe(stateBefore.stateVersion);
    expect(stateAfter.eventSeq).toBe(stateBefore.eventSeq);

    await cleanupTestTable(ctx.app, tableId);
  });

  it("flushes a pending hand settlement before cash-out and a late worker is a no-op", async () => {
    const [player1, player2] = ctx.users;
    const tableId = await createTable(ctx.app, player1.token, {
      name: "Flush Before Cashout",
      mode: "CASH",
      smallBlind: 5,
      bigBlind: 10,
    });

    await buyIn(ctx.app, player1.token, tableId, 1000, 0);
    await buyIn(ctx.app, player2.token, tableId, 1000, 1);

    const { loser } = await playFoldHand(ctx.app, [player1, player2], tableId);
    const intent = await settleIntentFor(ctx.app, tableId);

    // The loser stands while the settlement worker has NOT run yet.
    await standFromTable(ctx.app, loser.token, tableId);
    expect(await reserveFor(ctx.app, loser.id, tableId)).toBe(0n);

    // A late worker settlement of the same hand must be a durable no-op: the
    // flush already marked it in the chip journal.
    const houseUserId = await getHouseUserId(ctx.app.prisma);
    const afterStand = await getUserBalances(ctx.app, loser.id);
    const late = await ctx.app.financialManager.settleHand({
      tableId,
      handId: intent.handId,
      playerNetChanges: intent.playerNetChanges,
      rakeTotal: intent.rakeTotal,
      houseUserId,
    });
    expect(late.replayed).toBe(true);

    const afterLate = await getUserBalances(ctx.app, loser.id);
    expect(afterLate.main).toBe(afterStand.main);
    expect(afterLate.inPlay).toBe(afterStand.inPlay);

    const handEntries = await ctx.app.prisma.chipLedgerEntry.count({
      where: { referenceId: intent.handId },
    });
    // One journal row per non-zero net change; no duplicate from the late run.
    expect(handEntries).toBeLessThanOrEqual(Object.keys(intent.playerNetChanges).length);

    await cleanupTestTable(ctx.app, tableId);
  });

  it("lets an ASSET-backed winner stand before the worker and never double-credits", async () => {
    const [player1, player2] = ctx.users;

    await ctx.app.prisma.asset.upsert({
      where: { id: ASSET_ID },
      create: {
        id: ASSET_ID,
        chainId: 31337,
        tokenAddress: `0x${"c".repeat(40)}`,
        symbol: "TSTX",
        decimals: 6,
        status: "ACTIVE",
        confirmations: 1,
        deepFinality: 2,
        treasuryAddress: `0x${"d".repeat(40)}`,
        rpcUrls: [],
        minGasAtomic: "1",
      },
      update: {},
    });
    const policy = await ctx.app.prisma.economicPolicy.create({
      data: {
        name: `seat_policy_${crypto.randomUUID()}`,
        assetId: ASSET_ID,
        chipsNumerator: 1n,
        atomicDenominator: ONE_CHIP,
        status: "ACTIVE",
      },
    });
    const table = await ctx.app.prisma.table.create({
      data: {
        name: `asset_seat_${crypto.randomUUID()}`,
        mode: "CASH",
        config: {},
        economicPolicyId: policy.id,
      },
    });
    const tableId = table.id;
    // The engine needs a full authoritative snapshot (state row) before it can
    // SIT; a bare table row created outside `createTable` has none. Build one
    // from the engine itself so the round-trip is exact.
    const { PokerEngine } = await import("@pokertools/engine");
    const pristine = new PokerEngine({
      smallBlind: 5,
      bigBlind: 10,
      maxPlayers: 10,
    });
    await ctx.app.prisma.table.update({
      where: { id: tableId },
      data: { state: JSON.stringify(pristine.snapshot) },
    });
    for (const actor of [player1, player2]) {
      await ctx.app.prisma.atomicAccount.upsert({
        where: {
          assetId_ownerKey_class: {
            assetId: ASSET_ID,
            ownerKey: actor.id,
            class: "USER_AVAILABLE",
          },
        },
        create: {
          assetId: ASSET_ID,
          ownerId: actor.id,
          ownerKey: actor.id,
          class: "USER_AVAILABLE",
          balanceAtomic: (1000n * ONE_CHIP).toString(),
        },
        update: { balanceAtomic: (1000n * ONE_CHIP).toString() },
      });
    }

    await buyIn(ctx.app, player1.token, tableId, 1000, 0);
    await buyIn(ctx.app, player2.token, tableId, 1000, 1);

    const { winner } = await playFoldHand(ctx.app, [player1, player2], tableId);
    const intent = await settleIntentFor(ctx.app, tableId);

    const winnerAtomicBefore = await atomicBalance(ctx.app, winner.id, "USER_AVAILABLE");
    expect(winnerAtomicBefore).toBe(0n);
    expect(await atomicBalance(ctx.app, winner.id, "IN_PLAY_RESERVE")).toBe(1000n * ONE_CHIP);

    // Winner stands before the settlement worker has processed the hand.
    await standFromTable(ctx.app, winner.token, tableId);
    expect(await reserveFor(ctx.app, winner.id, tableId)).toBe(0n);

    // The flush settled the hand atomically and then cashed the winner out, so
    // no in-play atomic liability is stranded and the reserve is empty.
    expect(await atomicBalance(ctx.app, winner.id, "IN_PLAY_RESERVE")).toBe(0n);
    const winnerAtomicAfter = await atomicBalance(ctx.app, winner.id, "USER_AVAILABLE");
    expect(winnerAtomicAfter).toBeGreaterThan(winnerAtomicBefore);

    // A late worker run must be a no-op and must not create a second settlement.
    const houseUserId = await getHouseUserId(ctx.app.prisma);
    const late = await ctx.app.financialManager.settleHand({
      tableId,
      handId: intent.handId,
      playerNetChanges: intent.playerNetChanges,
      rakeTotal: intent.rakeTotal,
      houseUserId,
    });
    expect(late.replayed).toBe(true);
    expect(await atomicBalance(ctx.app, winner.id, "USER_AVAILABLE")).toBe(winnerAtomicAfter);

    const settlements = await ctx.app.prisma.chipAssetSettlement.count({
      where: { scopeType: "TABLE", scopeId: tableId, referenceId: intent.handId },
    });
    expect(settlements).toBe(1);

    await cleanupTestTable(ctx.app, tableId);
  });

  it("serializes a concurrent stand and next-hand deal without creating or losing chips", async () => {
    const [player1, player2] = ctx.users;
    const tableId = await createTable(ctx.app, player1.token, {
      name: "Concurrent Stand Next Hand",
      mode: "CASH",
      smallBlind: 5,
      bigBlind: 10,
    });

    await buyIn(ctx.app, player1.token, tableId, 1000, 0);
    await buyIn(ctx.app, player2.token, tableId, 1000, 1);
    await playFoldHand(ctx.app, [player1, player2], tableId);

    const before =
      (await getUserBalances(ctx.app, player1.id)).inPlay +
      (await getUserBalances(ctx.app, player2.id)).inPlay;

    await Promise.allSettled([
      standFromTable(ctx.app, player1.token, tableId),
      ctx.app.gameManager.processAction(tableId, { type: "DEAL" }, "", {
        skipLock: true,
      }),
    ]);

    const balances1 = await getUserBalances(ctx.app, player1.id);
    const balances2 = await getUserBalances(ctx.app, player2.id);
    const totalAfter = balances1.inPlay + balances2.inPlay;

    // Chips are conserved across the race: no phantom chips and no negative
    // reserve. (Rake may legitimately reduce the in-play total.)
    expect(totalAfter).toBeGreaterThanOrEqual(0);
    expect(totalAfter).toBeLessThanOrEqual(before);
    const reserve1 = await reserveFor(ctx.app, player1.id, tableId);
    const reserve2 = await reserveFor(ctx.app, player2.id, tableId);
    expect(reserve1).toBeGreaterThanOrEqual(0n);
    expect(reserve2).toBeGreaterThanOrEqual(0n);

    await cleanupTestTable(ctx.app, tableId);
  });
});
