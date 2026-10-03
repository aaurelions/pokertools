import { describe, expect, it } from "vitest";
import type { PrismaClient } from "../../../api/generated/prisma/index.js";
import {
  PrismaAssetRegistry,
  PrismaIncidentStore,
  PrismaWithdrawalStore,
} from "../../src/core/prisma-store.js";
import { ASSET_ID, CHAIN_ID, DESTINATION, TOKEN, TREASURY } from "./fakes.js";

type Row = Record<string, unknown>;

/**
 * Minimal in-memory stand-in for the generated Prisma client. It exists to
 * exercise the store's column mapping / CAS / overflow logic; the production
 * store itself binds to the real generated models.
 */
function fakePrisma() {
  const withdrawals = new Map<string, Row>();
  const incidents = new Map<string, Row>();
  const assets = new Map<string, Row>();

  const matches = (row: Row, where: Row): boolean => {
    for (const [key, expected] of Object.entries(where)) {
      if (key === "OR") {
        if (!(expected as Row[]).some((clause) => matches(row, clause))) return false;
        continue;
      }
      if (expected && typeof expected === "object" && "in" in expected) {
        if (!(expected as { in: unknown[] }).in.includes(row[key])) return false;
        continue;
      }
      if (expected && typeof expected === "object" && "not" in expected) {
        if (row[key] === (expected as { not: unknown }).not) return false;
        continue;
      }
      if (expected && typeof expected === "object" && "gt" in expected) {
        const gt = (expected as { gt: unknown }).gt;
        if (gt instanceof Date) {
          if (!(row[key] instanceof Date) || (row[key] as Date).getTime() <= gt.getTime()) {
            return false;
          }
        } else if (String(row[key]) <= String(gt)) {
          return false;
        }
        continue;
      }
      if (expected && typeof expected === "object" && "equals" in expected) {
        const equals = (expected as { equals: unknown }).equals;
        // `mode: "insensitive"` is the only supported Prisma string mode here.
        const insensitive =
          (expected as { mode?: string }).mode === "insensitive" && typeof equals === "string";
        if (insensitive) {
          if (String(row[key]).toLowerCase() !== equals.toLowerCase()) return false;
        } else if (row[key] !== equals) {
          return false;
        }
        continue;
      }
      if (row[key] !== expected) return false;
    }
    return true;
  };

  const applyUpdate = (row: Row, data: Row): void => {
    for (const [key, value] of Object.entries(data)) {
      if (value === undefined) continue;
      if (value && typeof value === "object" && "increment" in value) {
        row[key] = Number(row[key]) + Number((value as { increment: number }).increment);
      } else {
        row[key] = value;
      }
    }
  };

  const sortRows = (rows: Row[], orderBy: Row | Row[] | undefined): Row[] => {
    const clauses = Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : [];
    if (clauses.length === 0) return rows;
    return rows.sort((a, b) => {
      for (const clause of clauses) {
        const [key, direction] = Object.entries(clause)[0] as [string, string];
        const left = a[key];
        const right = b[key];
        let cmp: number;
        if (left instanceof Date && right instanceof Date) cmp = left.getTime() - right.getTime();
        else if (typeof left === "bigint" && typeof right === "bigint")
          cmp = left < right ? -1 : left > right ? 1 : 0;
        else if (typeof left === "number" && typeof right === "number") cmp = left - right;
        else cmp = String(left).localeCompare(String(right));
        if (cmp !== 0) return direction === "desc" ? -cmp : cmp;
      }
      return 0;
    });
  };

  const client = {
    withdrawalIntentRecord: {
      findUnique: async ({ where }: { where: Row }) => withdrawals.get(where.id as string) ?? null,
      create: async ({ data }: { data: Row }) => {
        const row: Row = {
          payloadHash: null,
          signedRawTx: null,
          signedCallData: null,
          signedValueAtomic: null,
          txHash: null,
          broadcastNonce: null,
          receiptBlockNumber: null,
          receiptBlockHash: null,
          confirmedJournalId: null,
          reorgJournalId: null,
          replacementPolicy: "NO_AUTOMATIC_REPLACEMENT",
          ...data,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        withdrawals.set(data.id as string, row);
        return row;
      },
      updateMany: async ({ where, data }: { where: Row; data: Row }) => {
        const targets =
          where.id && typeof where.id === "object" && "in" in where.id
            ? (where.id as { in: string[] }).in
                .map((id) => withdrawals.get(id))
                .filter((row): row is Row => row !== undefined)
            : withdrawals.get(where.id as string)
              ? [withdrawals.get(where.id as string)!]
              : [];
        const matched = targets.filter((row) => matches(row, where));
        for (const row of matched) applyUpdate(row, data);
        return { count: matched.length };
      },
      findFirst: async ({ where }: { where: Row }) => {
        const found = [...withdrawals.values()].filter((row) => matches(row, where));
        return found[0] ?? null;
      },
      findMany: async ({ where, take, orderBy }: { where: Row; take?: number; orderBy?: Row }) => {
        const rows = [...withdrawals.values()].filter((row) => matches(row, where ?? {}));
        return take === undefined
          ? sortRows(rows, orderBy)
          : sortRows(rows, orderBy).slice(0, take);
      },
    },
    financialIncident: {
      findUnique: async ({ where }: { where: Row }) => incidents.get(where.id as string) ?? null,
      findMany: async ({ where }: { where: Row }) =>
        [...incidents.values()].filter((row) => matches(row, where ?? {})),
      create: async ({ data }: { data: Row }) => {
        const row: Row = {
          id: `inc_${incidents.size}`,
          version: 0,
          ...data,
          createdAt: new Date(),
        };
        incidents.set(row.id as string, row);
        return row;
      },
      upsert: async ({ where, create, update }: { where: Row; create: Row; update: Row }) => {
        const existing = incidents.get(where.id as string);
        if (existing) {
          applyUpdate(existing, update);
          return existing;
        }
        const row: Row = { version: 0, ...create, createdAt: new Date() };
        incidents.set(row.id as string, row);
        return row;
      },
      update: async ({ where, data }: { where: Row; data: Row }) => {
        const row = incidents.get(where.id as string)!;
        applyUpdate(row, data);
        return row;
      },
    },
    asset: {
      findUnique: async ({ where }: { where: Row }) => assets.get(where.id as string) ?? null,
      findMany: async () => [...assets.values()],
      update: async ({ where, data }: { where: Row; data: Row }) => {
        const row = assets.get(where.id as string)!;
        Object.assign(row, data);
        return row;
      },
    },
  };
  return { client: client as unknown as PrismaClient, withdrawals, incidents, assets };
}

function newRecord(overrides: Record<string, unknown> = {}) {
  return {
    intentId: "int_1",
    principalId: "principal_1",
    assetId: ASSET_ID,
    chainId: CHAIN_ID,
    destination: DESTINATION,
    amountAtomic: "500",
    nonce: 1,
    deadline: 1_700_003_600,
    signature: "0x" + "ab".repeat(65),
    treasuryAddress: TREASURY,
    tokenAddress: TOKEN,
    ...overrides,
  };
}

describe("PrismaWithdrawalStore", () => {
  it("pages and rotates by durable (updatedAt, id) so a blocked front batch cannot starve the tail", async () => {
    const { client, withdrawals } = fakePrisma();
    const store = new PrismaWithdrawalStore(client, "file:./test.db");
    for (const id of ["int_a", "int_b", "int_c"]) {
      await store.create(newRecord({ intentId: id }));
    }
    withdrawals.get("int_a")!.updatedAt = new Date(1_000);
    withdrawals.get("int_b")!.updatedAt = new Date(2_000);
    withdrawals.get("int_c")!.updatedAt = new Date(3_000);

    const first = await store.listByStates(["RESERVED"], 2);
    expect(first.map((record) => record.intentId)).toEqual(["int_a", "int_b"]);
    const last = first[first.length - 1];
    const second = await store.listByStates(["RESERVED"], 2, {
      updatedAt: last.updatedAt,
      intentId: last.intentId,
    });
    expect(second.map((record) => record.intentId)).toEqual(["int_c"]);

    // Rotation: scanned records move strictly behind the unscanned tail.
    await store.markScanned(["int_a", "int_b"], 4_000);
    const rotated = await store.listByStates(["RESERVED"], 3);
    expect(rotated.map((record) => record.intentId)).toEqual(["int_c", "int_a", "int_b"]);
  });

  it("does not lose a treasury's maximum behind fifty higher nonces from another treasury", async () => {
    const { client, withdrawals } = fakePrisma();
    const store = new PrismaWithdrawalStore(client, "file:./test.db");
    await store.create(newRecord());
    withdrawals.get("int_1")!.broadcastNonce = 7n;
    for (let index = 0; index < 51; index++) {
      await store.create(
        newRecord({ intentId: `other_${index}`, nonce: index + 2, treasuryAddress: DESTINATION })
      );
      withdrawals.get(`other_${index}`)!.broadcastNonce = BigInt(index + 100);
    }
    expect(await store.maxPersistedTreasuryNonce(CHAIN_ID, TREASURY.toUpperCase())).toBe(7);
    expect(await store.maxPersistedTreasuryNonce(CHAIN_ID, DESTINATION)).toBe(150);
  });
  it("maps the real column names (id/broadcastNonce) and enforces CAS transitions", async () => {
    const { client } = fakePrisma();
    const store = new PrismaWithdrawalStore(client, "file:./test.db");

    const created = await store.create(newRecord());
    expect(created.intentId).toBe("int_1");
    expect(created.state).toBe("RESERVED");
    expect(created.treasuryNonce).toBeNull();

    // Wrong source state -> no transition.
    expect(
      await store.transition({ intentId: "int_1", from: ["BROADCAST"], to: "FAILED" })
    ).toBeNull();

    const persisted = await store.transition({
      intentId: "int_1",
      from: ["RESERVED"],
      to: "PERSISTED",
      patch: {
        signedRawTx: "0xdead",
        txHash: "0x" + "11".repeat(32),
        treasuryNonce: 7,
      },
    });
    expect(persisted).not.toBeNull();
    expect(persisted!.state).toBe("PERSISTED");
    expect(persisted!.treasuryNonce).toBe(7);
    expect(persisted!.txHash).toBe("0x" + "11".repeat(32));

    // Nonce guard fails for a different expected nonce.
    expect(
      await store.transition({
        intentId: "int_1",
        from: ["PERSISTED"],
        to: "BROADCAST",
        expectedTreasuryNonce: 8,
      })
    ).toBeNull();
    expect(
      await store.transition({
        intentId: "int_1",
        from: ["PERSISTED"],
        to: "BROADCAST",
        expectedTreasuryNonce: 7,
      })
    ).not.toBeNull();

    expect(await store.maxPersistedTreasuryNonce(CHAIN_ID, TREASURY)).toBe(7);
  });

  it("rejects BigInt nonce/deadline values above the safe integer range", async () => {
    const { client, withdrawals } = fakePrisma();
    const store = new PrismaWithdrawalStore(client, "file:./test.db");
    await store.create(newRecord());
    const row = withdrawals.get("int_1")!;
    row.nonce = BigInt(Number.MAX_SAFE_INTEGER) + 1n;

    await expect(store.get("int_1")).rejects.toThrow(RangeError);
  });

  it("exposes the replacement policy and reserved journal id", async () => {
    const { client } = fakePrisma();
    const store = new PrismaWithdrawalStore(client, "file:./test.db");
    const created = await store.create(newRecord({ reservedJournalId: "jrnl_hold" }));
    expect(created.replacementPolicy).toBe("NO_AUTOMATIC_REPLACEMENT");
    expect(created.reservedJournalId).toBe("jrnl_hold");
  });
});

describe("PrismaIncidentStore", () => {
  it("collapses concurrent opens for one (kind, assetId, intentId) onto a single durable row", async () => {
    const { client, incidents } = fakePrisma();
    const store = new PrismaIncidentStore(client);
    const input = {
      kind: "GAS_STARVATION" as const,
      severity: "CRITICAL" as const,
      assetId: ASSET_ID,
      chainId: CHAIN_ID,
      intentId: "int_1",
      principalId: "principal_1",
      detail: { availableAtomic: "5" },
    };

    const [first, second, third] = await Promise.all([
      store.open(input),
      store.open({ ...input, detail: { availableAtomic: "6" } }),
      store.open(input),
    ]);

    expect(incidents.size).toBe(1);
    expect(first.incidentId).toBe(second.incidentId);
    expect(second.incidentId).toBe(third.incidentId);
    expect(first.incidentId.startsWith("inc_")).toBe(true);
  });

  it("maps evidence/affectedId to the durable incident shape and is idempotent per intent", async () => {
    const { client } = fakePrisma();
    const store = new PrismaIncidentStore(client);

    const first = await store.open({
      kind: "GAS_STARVATION",
      severity: "CRITICAL",
      assetId: ASSET_ID,
      chainId: CHAIN_ID,
      intentId: "int_1",
      principalId: "principal_1",
      detail: { availableAtomic: "5" },
    });
    expect(first.kind).toBe("GAS_STARVATION");
    expect(first.intentId).toBe("int_1");
    expect(first.principalId).toBe("principal_1");
    expect(first.detail.availableAtomic).toBe("5");

    const second = await store.open({
      kind: "GAS_STARVATION",
      severity: "CRITICAL",
      assetId: ASSET_ID,
      chainId: CHAIN_ID,
      intentId: "int_1",
      principalId: "principal_1",
      detail: { availableAtomic: "6" },
    });
    expect(second.incidentId).toBe(first.incidentId);
    expect(second.detail.availableAtomic).toBe("6");

    const resolved = await store.resolve(first.incidentId, {
      resolvedBy: "operator_1",
      note: "gas replenished",
    });
    expect(resolved.status).toBe("RESOLVED");
    expect(resolved.resolvedAt).toBeGreaterThan(0);
    expect(await store.listOpen()).toHaveLength(0);

    // A recurring condition reopens the same durable row (stable key) instead
    // of racing a second find/create.
    const reopened = await store.open({
      kind: "GAS_STARVATION",
      severity: "CRITICAL",
      assetId: ASSET_ID,
      chainId: CHAIN_ID,
      intentId: "int_1",
      detail: { availableAtomic: "7" },
    });
    expect(reopened.incidentId).toBe(first.incidentId);
    expect(reopened.status).toBe("OPEN");
    expect(reopened.resolvedAt).toBeUndefined();
    expect(reopened.detail.availableAtomic).toBe("7");
    expect(await store.listOpen()).toHaveLength(1);
  });
});

describe("PrismaAssetRegistry", () => {
  it("maps the canonical Asset row and updates status", async () => {
    const { client, assets } = fakePrisma();
    assets.set(ASSET_ID, {
      id: ASSET_ID,
      chainId: CHAIN_ID,
      tokenAddress: TOKEN,
      treasuryAddress: TREASURY,
      rpcUrls: ["http://rpc-a.example", "http://rpc-b.example"],
      minGasAtomic: "1000",
      confirmations: 3,
      deepFinality: 6,
      status: "ACTIVE",
    });
    const registry = new PrismaAssetRegistry(client);

    const asset = await registry.get(ASSET_ID);
    expect(asset).not.toBeNull();
    expect(asset!.rpcUrls).toHaveLength(2);
    expect(asset!.status).toBe("ACTIVE");

    await registry.setStatus(ASSET_ID, "FROZEN", "test");
    expect((await registry.get(ASSET_ID))!.status).toBe("FROZEN");
  });
});
