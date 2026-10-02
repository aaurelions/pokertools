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
      if (expected && typeof expected === "object" && "in" in expected) {
        if (!(expected as { in: unknown[] }).in.includes(row[key])) return false;
        continue;
      }
      if (expected && typeof expected === "object" && "not" in expected) {
        if (row[key] === (expected as { not: unknown }).not) return false;
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
        const row = withdrawals.get(where.id as string);
        if (!row || !matches(row, where)) return { count: 0 };
        for (const [key, value] of Object.entries(data)) {
          if (value && typeof value === "object" && "increment" in value) {
            row[key] = Number(row[key]) + Number((value as { increment: number }).increment);
          } else {
            row[key] = value;
          }
        }
        return { count: 1 };
      },
      findFirst: async ({ where }: { where: Row }) => {
        const found = [...withdrawals.values()].filter((row) => matches(row, where));
        return found[0] ?? null;
      },
      findMany: async ({ where }: { where: Row }) =>
        [...withdrawals.values()].filter((row) => matches(row, where)),
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
      update: async ({ where, data }: { where: Row; data: Row }) => {
        const row = incidents.get(where.id as string)!;
        for (const [key, value] of Object.entries(data)) {
          if (value && typeof value === "object" && "increment" in value) {
            row[key] = Number(row[key]) + Number((value as { increment: number }).increment);
          } else {
            row[key] = value;
          }
        }
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
