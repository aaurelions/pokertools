import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createPrismaClient } from "../../src/utils/prisma-client.js";
import { FinancialManager } from "../../src/services/financial-manager.js";
import { computeTournamentPayouts } from "../../src/utils/tournaments.js";
import { InsufficientFundsError } from "../../src/utils/errors.js";
import type { Prisma } from "../../generated/prisma/index.js";

/**
 * PLAY_CHIPS core + exact ASSET policy integration.
 *
 * These tests exercise the chip economy directly against the database, without
 * the legacy cents `Account`/`LedgerEntry` rows. Funding is always an explicit
 * operator/fixture grant.
 */

const prisma = createPrismaClient();
const financialManager = new FinancialManager(prisma);

/**
 * Bare tables created by this suite intentionally carry no engine snapshot
 * (`config: {}`) because the chip economy is exercised directly against the
 * database. They must never remain listable after the suite: `GET /tables`
 * schema-validates every listed row, and a config without `smallBlind` /
 * `bigBlind` fails that contract. Track the ids created by this run and mark
 * them CLOSED in teardown. Closing (rather than deleting) preserves the chip
 * and atomic journals that reference the table id.
 */
const createdTableIds = new Set<string>();

/** Name prefixes owned exclusively by this suite, used to retire stale rows. */
const SUITE_TABLE_NAME_PREFIXES = [
  "econ_table_",
  "econ_tournament_table_",
  "asset_table_",
  "asset_concurrent_table_",
  "asset_settle_table_",
  "asset_tournament_table_",
  "inexact_table_",
] as const;

async function createTrackedTable(data: Prisma.TableCreateArgs["data"]) {
  const table = await prisma.table.create({ data });
  createdTableIds.add(table.id);
  return table;
}

async function createPrincipal(): Promise<string> {
  const suffix = randomUUID();
  const user = await prisma.user.create({
    data: {
      username: `econ_${suffix}`,
      address: `0x${suffix.replace(/-/g, "").padEnd(40, "0").slice(0, 40)}`,
    },
  });
  return user.id;
}

async function createCashTable() {
  return createTrackedTable({ name: `econ_table_${randomUUID()}`, mode: "CASH", config: {} });
}

async function createTournament(
  creatorId: string,
  buyIn = 100,
  fee = 0,
  payoutPercentages: number[] = [100]
) {
  const suffix = randomUUID();
  const table = await createTrackedTable({
    name: `econ_tournament_table_${suffix}`,
    mode: "TOURNAMENT",
    config: {},
  });
  return prisma.tournament.create({
    data: {
      name: `econ_tournament_${suffix}`,
      creatorId,
      tableId: table.id,
      buyIn,
      fee,
      startingStack: 1000,
      maxPlayers: 10,
      blindStructure: [],
      payoutPercentages,
    },
  });
}

beforeAll(async () => {
  await prisma.$connect();
});

afterAll(async () => {
  // Retire this run's tables plus any stale WAITING rows left by earlier runs
  // of this suite. Strictly scoped to this suite's own table ids and name
  // prefixes so unrelated tables are never touched.
  const staleRows: Prisma.TableWhereInput[] = SUITE_TABLE_NAME_PREFIXES.map((prefix) => ({
    status: "WAITING",
    name: { startsWith: prefix },
  }));
  await prisma.table.updateMany({
    where: {
      OR: [{ id: { in: [...createdTableIds] } }, ...staleRows],
    },
    data: { status: "CLOSED" },
  });

  await prisma.$disconnect();
});

describe("PLAY_CHIPS economy", () => {
  it("grants, buys in, settles (idempotently) and cashes out", async () => {
    const winner = await createPrincipal();
    const loser = await createPrincipal();
    const table = await createCashTable();

    for (const principal of [winner, loser]) {
      await financialManager.grantChips(principal, 1000, {
        reason: "test_fixture",
        operatorId: principal,
        idempotencyKey: `grant:${principal}`,
      });
      expect((await financialManager.getChipBalances(principal)).available).toBe(1000n);
      await financialManager.buyIn(principal, table.id, 400, {
        idempotencyKey: `buy:${principal}`,
      });
      expect((await financialManager.getChipBalances(principal)).available).toBe(600n);
      expect(await financialManager.getTableReserve(principal, table.id)).toBe(400n);
    }

    const handId = `hand_${randomUUID()}`;
    const first = await financialManager.settleHand({
      tableId: table.id,
      handId,
      playerNetChanges: { [winner]: "50", [loser]: "-50" },
      rakeTotal: 0,
      houseUserId: winner,
    });
    expect(first.replayed).toBe(false);
    expect(await financialManager.getTableReserve(winner, table.id)).toBe(450n);
    expect(await financialManager.getTableReserve(loser, table.id)).toBe(350n);

    const replay = await financialManager.settleHand({
      tableId: table.id,
      handId,
      playerNetChanges: { [winner]: "50", [loser]: "-50" },
      rakeTotal: 0,
      houseUserId: winner,
    });
    expect(replay.replayed).toBe(true);
    expect(await financialManager.getTableReserve(winner, table.id)).toBe(450n);
    expect(await financialManager.getTableReserve(loser, table.id)).toBe(350n);

    await financialManager.cashOut(winner, table.id, 450, { idempotencyKey: `cash:${winner}` });
    await financialManager.cashOut(loser, table.id, 350, { idempotencyKey: `cash:${loser}` });
    expect((await financialManager.getChipBalances(winner)).available).toBe(1050n);
    expect((await financialManager.getChipBalances(loser)).available).toBe(950n);
    expect(await financialManager.getTableReserve(winner, table.id)).toBe(0n);
    expect(await financialManager.getTableReserve(loser, table.id)).toBe(0n);
  });

  it("routes rake to the house operator account", async () => {
    const winner = await createPrincipal();
    const loser = await createPrincipal();
    const house = await createPrincipal();
    const table = await createCashTable();

    for (const principal of [winner, loser]) {
      await financialManager.grantChips(principal, 500, {
        reason: "test_fixture",
        operatorId: principal,
        idempotencyKey: `grant:${principal}`,
      });
      await financialManager.buyIn(principal, table.id, 500, {
        idempotencyKey: `buy:${principal}`,
      });
    }

    const handId = `hand_${randomUUID()}`;
    await financialManager.settleHand({
      tableId: table.id,
      handId,
      playerNetChanges: { [winner]: "100", [loser]: "-105" },
      rakeTotal: 5,
      houseUserId: house,
    });

    // Net changes + rake must be zero-sum across reserves + operator.
    expect(await financialManager.getTableReserve(winner, table.id)).toBe(600n);
    expect(await financialManager.getTableReserve(loser, table.id)).toBe(395n);
    const operator = await prisma.chipAccount.findUnique({
      where: {
        principalId_kind_scopeKey: { principalId: house, kind: "OPERATOR", scopeKey: "@system" },
      },
    });
    expect(operator?.balance).toBe(5n);
  });

  it("is idempotent on repeated grants", async () => {
    const principal = await createPrincipal();
    const key = `grant-idem:${principal}`;
    const first = await financialManager.grantChips(principal, 100, {
      reason: "test_fixture",
      operatorId: principal,
      idempotencyKey: key,
    });
    const second = await financialManager.grantChips(principal, 100, {
      reason: "test_fixture",
      operatorId: principal,
      idempotencyKey: key,
    });
    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect((await financialManager.getChipBalances(principal)).available).toBe(100n);
  });

  it("fails closed when chips are insufficient and never touches legacy accounts", async () => {
    const principal = await createPrincipal();
    const table = await createCashTable();
    await expect(
      financialManager.buyIn(principal, table.id, 10, { idempotencyKey: `buy:${principal}` })
    ).rejects.toBeInstanceOf(InsufficientFundsError);

    // A failed buy-in must not materialize any canonical chip account.
    const accountCount = await prisma.chipAccount.count({ where: { principalId: principal } });
    expect(accountCount).toBe(0);
  });
});

describe("tournament chip escrow", () => {
  it("escrows buy-ins, pays prizes from the pool, and is idempotent", async () => {
    const creator = await createPrincipal();
    const winner = await createPrincipal();
    const runnerUp = await createPrincipal();
    const tournament = await createTournament(creator, 100, 0);

    for (const principal of [winner, runnerUp]) {
      await financialManager.grantChips(principal, 500, {
        reason: "test_fixture",
        operatorId: principal,
        idempotencyKey: `grant:${principal}`,
      });
      await prisma.$transaction((tx) =>
        financialManager.applyTournamentRegistration(tx, principal, tournament.id, 100n, 0n, {
          idempotencyKey: `register:${tournament.id}:${principal}`,
          operatorId: creator,
        })
      );
      expect((await financialManager.getChipBalances(principal)).available).toBe(400n);
    }
    expect(await financialManager.getTournamentPool(tournament.id)).toBe(200n);

    await prisma.$transaction((tx) =>
      financialManager.payoutTournament(tx, winner, tournament.id, 200n, {
        idempotencyKey: `payout:${tournament.id}:${winner}`,
      })
    );
    expect(await financialManager.getTournamentPool(tournament.id)).toBe(0n);
    expect((await financialManager.getChipBalances(winner)).available).toBe(600n);

    // A repeated payout under the same operation key is a no-op.
    await prisma.$transaction((tx) =>
      financialManager.payoutTournament(tx, winner, tournament.id, 200n, {
        idempotencyKey: `payout:${tournament.id}:${winner}`,
      })
    );
    expect((await financialManager.getChipBalances(winner)).available).toBe(600n);
  });

  it("distributes integer rounding remainders so no prize chips are stranded", async () => {
    const creator = await createPrincipal();
    const first = await createPrincipal();
    const second = await createPrincipal();
    // 101 chips, 60/40 => 60 + 40 = 100 with a 1-chip remainder to first place.
    const tournament = await createTournament(creator, 101, 0, [60, 40]);

    for (const principal of [first, second]) {
      await financialManager.grantChips(principal, 500, {
        reason: "test_fixture",
        operatorId: principal,
        idempotencyKey: `grant:${principal}`,
      });
      await prisma.$transaction((tx) =>
        financialManager.applyTournamentRegistration(tx, principal, tournament.id, 101n, 0n, {
          idempotencyKey: `register:${tournament.id}:${principal}`,
          operatorId: creator,
        })
      );
    }
    expect(await financialManager.getTournamentPool(tournament.id)).toBe(202n);

    const payouts = computeTournamentPayouts(202, [60, 40]);
    expect(payouts.reduce((sum, amount) => sum + amount, 0n)).toBe(202n);
    await prisma.$transaction(async (tx) => {
      await financialManager.payoutTournament(tx, first, tournament.id, payouts[0]!, {
        idempotencyKey: `payout:${tournament.id}:${first}`,
      });
      await financialManager.payoutTournament(tx, second, tournament.id, payouts[1]!, {
        idempotencyKey: `payout:${tournament.id}:${second}`,
      });
    });
    // 60% of 202 = 121, 40% = 80, remainder 1 to first => 122 + 80 = 202.
    expect(payouts).toEqual([122n, 80n]);
    expect(await financialManager.getTournamentPool(tournament.id)).toBe(0n);
    expect((await financialManager.getChipBalances(first)).available).toBe(521n);
    expect((await financialManager.getChipBalances(second)).available).toBe(479n);
  });
});

describe("ASSET-backed exact policy", () => {
  const tokenAddress = `0x${"a".repeat(40)}`;
  const assetId = `eip155:31337/erc20:${tokenAddress}`;
  const ONE_CHIP = 1_000_000n;

  async function createActivePolicy(chipsNumerator: bigint, atomicDenominator: bigint) {
    return prisma.economicPolicy.create({
      data: {
        name: `policy_${randomUUID()}`,
        assetId,
        chipsNumerator,
        atomicDenominator,
        status: "ACTIVE",
      },
    });
  }

  async function fundAtomic(principalId: string, amountAtomic: string) {
    await prisma.atomicAccount.upsert({
      where: {
        assetId_ownerKey_class: { assetId, ownerKey: principalId, class: "USER_AVAILABLE" },
      },
      create: {
        assetId,
        ownerId: principalId,
        ownerKey: principalId,
        class: "USER_AVAILABLE",
        balanceAtomic: amountAtomic,
      },
      update: { balanceAtomic: amountAtomic },
    });
  }

  async function atomicBalance(ownerKey: string, accountClass: string): Promise<string> {
    const account = await prisma.atomicAccount.findUnique({
      where: {
        assetId_ownerKey_class: {
          assetId,
          ownerKey,
          class: accountClass as "USER_AVAILABLE",
        },
      },
    });
    return account?.balanceAtomic ?? "0";
  }

  beforeAll(async () => {
    await prisma.asset.upsert({
      where: { id: assetId },
      create: {
        id: assetId,
        chainId: 31337,
        tokenAddress,
        symbol: "TST",
        decimals: 6,
        status: "ACTIVE",
        confirmations: 1,
        deepFinality: 2,
        treasuryAddress: `0x${"b".repeat(40)}`,
        rpcUrls: [],
        minGasAtomic: "1",
      },
      update: {},
    });
  });

  it("converts exactly into a per-principal reserve and persists the reference", async () => {
    const principal = await createPrincipal();
    const policy = await createActivePolicy(1n, ONE_CHIP);
    const table = await createTrackedTable({
      name: `asset_table_${randomUUID()}`,
      mode: "CASH",
      config: {},
      economicPolicyId: policy.id,
    });
    await fundAtomic(principal, (3n * ONE_CHIP).toString());

    await financialManager.buyIn(principal, table.id, 3, {
      idempotencyKey: `asset-buy:${principal}`,
    });

    const conversion = await prisma.chipAssetConversion.findFirst({
      where: { principalId: principal, scopeId: table.id },
    });
    expect(conversion?.direction).toBe("CHIPS_TO_ATOMIC");
    expect(conversion?.atomicAmount).toBe("3000000");
    expect(conversion?.journalRequestId).toContain("chip-asset:chips_to_atomic:table:");
    expect(await financialManager.getTableReserve(principal, table.id)).toBe(3n);
    expect(await atomicBalance(principal, "USER_AVAILABLE")).toBe("0");
    expect(await atomicBalance(principal, "IN_PLAY_RESERVE")).toBe("3000000");

    // Repeating the same operation must not create a second conversion.
    await financialManager.buyIn(principal, table.id, 3, {
      idempotencyKey: `asset-buy:${principal}`,
    });
    expect(
      await prisma.chipAssetConversion.count({
        where: { principalId: principal, scopeId: table.id },
      })
    ).toBe(1);

    await financialManager.cashOut(principal, table.id, 3, {
      idempotencyKey: `asset-cash:${principal}`,
    });
    expect(await financialManager.getTableReserve(principal, table.id)).toBe(0n);
    expect(await atomicBalance(principal, "USER_AVAILABLE")).toBe("3000000");
    expect(await atomicBalance(principal, "IN_PLAY_RESERVE")).toBe("0");
  });

  it("rejects a policy that cannot represent one chip as an integer atomic amount", async () => {
    const principal = await createPrincipal();
    const policy = await createActivePolicy(3n, 1000n);
    const table = await createTrackedTable({
      name: `inexact_table_${randomUUID()}`,
      mode: "CASH",
      config: {},
      economicPolicyId: policy.id,
    });
    await fundAtomic(principal, "10000000");

    await expect(
      financialManager.buyIn(principal, table.id, 1, { idempotencyKey: `bad:${principal}` })
    ).rejects.toMatchObject({ code: "ECONOMIC_POLICY_NOT_REPRESENTABLE" });
    expect(
      await prisma.chipAssetConversion.count({
        where: { principalId: principal, scopeId: table.id },
      })
    ).toBe(0);
  });

  it("does not duplicate conversions under concurrent replay", async () => {
    const principal = await createPrincipal();
    const policy = await createActivePolicy(1n, ONE_CHIP);
    const table = await createTrackedTable({
      name: `asset_concurrent_table_${randomUUID()}`,
      mode: "CASH",
      config: {},
      economicPolicyId: policy.id,
    });
    await fundAtomic(principal, (10n * ONE_CHIP).toString());
    const key = `concurrent-buy:${principal}`;

    const results = await Promise.allSettled([
      financialManager.buyIn(principal, table.id, 3, { idempotencyKey: key }),
      financialManager.buyIn(principal, table.id, 3, { idempotencyKey: key }),
    ]);
    expect(results.some((result) => result.status === "fulfilled")).toBe(true);

    // Exactly one conversion and one atomic journal, and the reserve is 3 (not 6).
    expect(
      await prisma.chipAssetConversion.count({
        where: { principalId: principal, scopeId: table.id },
      })
    ).toBe(1);
    expect(
      await prisma.journalPosting.count({
        where: { account: { ownerId: principal }, assetId },
      })
    ).toBe(2);
    expect(await financialManager.getTableReserve(principal, table.id)).toBe(3n);
    expect(await atomicBalance(principal, "USER_AVAILABLE")).toBe("7000000");
  });

  it("moves per-principal atomic liability on a hand win/loss and credits rake", async () => {
    const winner = await createPrincipal();
    const loser = await createPrincipal();
    const house = await createPrincipal();
    const policy = await createActivePolicy(1n, ONE_CHIP);
    const table = await createTrackedTable({
      name: `asset_settle_table_${randomUUID()}`,
      mode: "CASH",
      config: {},
      economicPolicyId: policy.id,
    });
    await fundAtomic(winner, (1000n * ONE_CHIP).toString());
    await fundAtomic(loser, (1000n * ONE_CHIP).toString());

    for (const principal of [winner, loser]) {
      await financialManager.buyIn(principal, table.id, 400, {
        idempotencyKey: `asset-buy:${principal}`,
      });
    }

    const handId = `hand_${randomUUID()}`;
    const result = await financialManager.settleHand({
      tableId: table.id,
      handId,
      playerNetChanges: { [winner]: "50", [loser]: "-55" },
      rakeTotal: 5,
      houseUserId: house,
    });
    expect(result.replayed).toBe(false);

    // Chip reserves.
    expect(await financialManager.getTableReserve(winner, table.id)).toBe(450n);
    expect(await financialManager.getTableReserve(loser, table.id)).toBe(345n);
    // Atomic liability moved between the principals, rake to the operator.
    expect(await atomicBalance(winner, "IN_PLAY_RESERVE")).toBe("450000000");
    expect(await atomicBalance(loser, "IN_PLAY_RESERVE")).toBe("345000000");
    expect(await atomicBalance(house, "OPERATOR")).toBe("5000000");

    const settlement = await prisma.chipAssetSettlement.findUnique({
      where: {
        scopeType_scopeId_referenceId: {
          scopeType: "TABLE",
          scopeId: table.id,
          referenceId: handId,
        },
      },
    });
    expect(settlement?.rakeAtomic).toBe("5000000");
    const journalRequestId = settlement?.journalRequestId;

    // Repeating the settlement is a no-op and does not double-move atomic value.
    const replay = await financialManager.settleHand({
      tableId: table.id,
      handId,
      playerNetChanges: { [winner]: "50", [loser]: "-55" },
      rakeTotal: 5,
      houseUserId: house,
    });
    expect(replay.replayed).toBe(true);
    expect(await atomicBalance(winner, "IN_PLAY_RESERVE")).toBe("450000000");
    expect(await atomicBalance(house, "OPERATOR")).toBe("5000000");
    expect(await prisma.chipAssetSettlement.count({ where: { journalRequestId } })).toBe(1);

    // Winners and losers can now cash out from their own reserve.
    await financialManager.cashOut(winner, table.id, 450, { idempotencyKey: `cash:${winner}` });
    await financialManager.cashOut(loser, table.id, 345, { idempotencyKey: `cash:${loser}` });
    expect(await atomicBalance(winner, "USER_AVAILABLE")).toBe("1050000000");
    expect(await atomicBalance(loser, "USER_AVAILABLE")).toBe("945000000");
    expect(await atomicBalance(winner, "IN_PLAY_RESERVE")).toBe("0");
    expect(await atomicBalance(loser, "IN_PLAY_RESERVE")).toBe("0");
  });

  it("registers, takes the fee atomically, and pays out without any chip grant", async () => {
    const creator = await createPrincipal();
    const winner = await createPrincipal();
    const loser = await createPrincipal();
    const policy = await createActivePolicy(1n, ONE_CHIP);
    const table = await createTrackedTable({
      name: `asset_tournament_table_${randomUUID()}`,
      mode: "TOURNAMENT",
      config: {},
      economicPolicyId: policy.id,
    });
    const tournament = await prisma.tournament.create({
      data: {
        name: `asset_tournament_${randomUUID()}`,
        creatorId: creator,
        tableId: table.id,
        buyIn: 100,
        fee: 10,
        startingStack: 1000,
        maxPlayers: 10,
        blindStructure: [],
        payoutPercentages: [100],
        economicPolicyId: policy.id,
      },
    });
    for (const principal of [winner, loser]) {
      await fundAtomic(principal, (1000n * ONE_CHIP).toString());
    }

    for (const principal of [winner, loser]) {
      await prisma.$transaction((tx) =>
        financialManager.applyTournamentRegistration(tx, principal, tournament.id, 100n, 10n, {
          idempotencyKey: `register:${tournament.id}:${principal}`,
          operatorId: creator,
        })
      );
      // No chip grant exists for either principal.
      expect((await financialManager.getChipBalances(principal)).available).toBe(0n);
      expect(await atomicBalance(principal, "USER_AVAILABLE")).toBe("890000000");
    }
    expect(await financialManager.getTournamentPool(tournament.id)).toBe(200n);
    expect(await atomicBalance(creator, "OPERATOR")).toBe("20000000");

    await prisma.$transaction((tx) =>
      financialManager.payoutTournament(tx, winner, tournament.id, 200n, {
        idempotencyKey: `payout:${tournament.id}:${winner}`,
      })
    );
    expect(await financialManager.getTournamentPool(tournament.id)).toBe(0n);
    expect(await atomicBalance(winner, "USER_AVAILABLE")).toBe("1090000000");
    expect(await atomicBalance(loser, "USER_AVAILABLE")).toBe("890000000");
    // The pooled tournament atomic reserve is fully drained; nothing stranded.
    expect(await atomicBalance("@system", "TOURNAMENT_RESERVE")).toBe("0");

    const directions = (
      await prisma.chipAssetConversion.findMany({ where: { scopeId: tournament.id } })
    ).map((conversion) => conversion.direction);
    expect(directions.sort()).toEqual(
      [
        "CHIPS_TO_ATOMIC",
        "CHIPS_TO_ATOMIC",
        "TOURNAMENT_FEE",
        "TOURNAMENT_FEE",
        "TOURNAMENT_PAYOUT",
      ].sort()
    );

    // Repeated registration and payout are stable no-ops.
    await prisma.$transaction((tx) =>
      financialManager.applyTournamentRegistration(tx, winner, tournament.id, 100n, 10n, {
        idempotencyKey: `register:${tournament.id}:${winner}`,
        operatorId: creator,
      })
    );
    await prisma.$transaction((tx) =>
      financialManager.payoutTournament(tx, winner, tournament.id, 200n, {
        idempotencyKey: `payout:${tournament.id}:${winner}`,
      })
    );
    expect(await atomicBalance(winner, "USER_AVAILABLE")).toBe("1090000000");
    expect((await financialManager.getChipBalances(winner)).available).toBe(200n);
  });
});
