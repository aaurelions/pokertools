import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaClient } from "../../generated/prisma/index.js";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import {
  ManifestMigrationIntegrityProbe,
  PlatformReadinessService,
  type CustodyReadinessProbe,
  type PlatformReadinessOptions,
} from "../../src/services/platform-readiness.js";

/**
 * Readiness is fail-closed. These tests exercise the real Prisma/migration
 * implementation against an isolated copy of the SQLite test database, and use
 * small in-memory probes only for the external operations (RPC quorum,
 * custody signer/gas, convergence acceptance) that live outside the API.
 */

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

let prisma: PrismaClient;
let tempRoot: string;
let manifestDir: string;
let manifestPath: string;
let sourceDatabaseUrl: string;

const BASE_FILE = "001_base";
const BASE_SQL = "SELECT 1;\n";
const BASE_HASH = sha256(BASE_SQL);

function writeManifest(directory: string, files: Record<string, string>): string {
  for (const [name, sql] of Object.entries(files)) {
    writeFileSync(join(directory, `${name}.sql`), sql);
  }
  writeFileSync(
    join(directory, "migrations.json"),
    JSON.stringify({
      migrations: Object.entries(files).map(([name, sql]) => ({
        name,
        file: `${name}.sql`,
        sha256: sha256(sql),
        description: name,
      })),
    })
  );
  return join(directory, "migrations.json");
}

const healthyRedis = { check: async () => ({ ok: true, code: "REDIS_OK" }) };
const healthyQueue = { check: async () => ({ ok: true, code: "QUEUE_OK" }) };
const healthyChain = { verifyQuorum: async () => ({ ok: true, code: "RPC_QUORUM_OK" }) };
const healthyCustody: CustodyReadinessProbe = {
  checkReadiness: async () => ({ ready: true, gasReady: true, code: "CUSTODY_READY" }),
};
const openConvergence = { check: async () => ({ complete: true, code: "CONVERGENCE_ACCEPTED" }) };

function makeService(overrides: Partial<PlatformReadinessOptions> = {}): PlatformReadinessService {
  return new PlatformReadinessService({
    prisma,
    redis: healthyRedis,
    queue: healthyQueue,
    chainQuorum: healthyChain,
    custody: healthyCustody,
    convergence: openConvergence,
    nodeEnv: "test",
    databaseUrl: "file:readiness-test.db",
    migrations: new ManifestMigrationIntegrityProbe(prisma, {
      manifestPath,
      provider: "postgres",
      nodeEnv: "test",
    }),
    ...overrides,
  });
}

async function applyMigration(name: string, hash: string): Promise<void> {
  await prisma.$executeRawUnsafe(
    'INSERT INTO "_migrations" ("name", "sha256") VALUES (?, ?)',
    name,
    hash
  );
}

async function createActiveAsset(
  id = "eip155:31337/erc20:0x0000000000000000000000000000000000000001",
  tokenAddress = "0x0000000000000000000000000000000000000001"
) {
  return prisma.asset.create({
    data: {
      id,
      chainId: 31337,
      tokenAddress,
      symbol: "TST",
      decimals: 18,
      status: "ACTIVE",
      confirmations: 1,
      deepFinality: 2,
      treasuryAddress: "0x00000000000000000000000000000000000000aa",
      rpcUrls: ["https://rpc.example.invalid"],
      minGasAtomic: "1000000000000000000",
    },
  });
}

function check(
  report: { checks: Array<{ name: string; state: string; detail: string }> },
  name: string
) {
  const found = report.checks.find((entry) => entry.name === name);
  if (!found) throw new Error(`missing check ${name}`);
  return found;
}

beforeAll(() => {
  sourceDatabaseUrl = process.env.DATABASE_URL ?? "";
  const sourcePath = sourceDatabaseUrl.replace(/^file:/, "");
  tempRoot = mkdtempSync(join(tmpdir(), "pokertools-readiness-"));
  const isolatedPath = join(tempRoot, "readiness.db");
  copyFileSync(sourcePath, isolatedPath);
  prisma = new PrismaClient({
    adapter: new PrismaBetterSqlite3({ url: `file:${isolatedPath}` }),
  });

  manifestDir = mkdtempSync(join(tempRoot, "migrations-"));
  manifestPath = writeManifest(manifestDir, { [BASE_FILE]: BASE_SQL });
});

afterAll(async () => {
  await prisma?.$disconnect();
  if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  await prisma.$executeRawUnsafe('DROP TABLE IF EXISTS "_migrations"');
  await prisma.$executeRawUnsafe(
    'CREATE TABLE "_migrations" ("name" TEXT NOT NULL PRIMARY KEY, "sha256" TEXT NOT NULL, "appliedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)'
  );
  for (const model of [
    prisma.gameEvent,
    prisma.gameOutbox,
    prisma.treasuryReconciliation,
    prisma.depositClaimRecord,
    prisma.withdrawalIntentRecord,
    prisma.journalPosting,
    prisma.journalTransaction,
    prisma.atomicAccount,
    prisma.asset,
    prisma.financialIncident,
    prisma.table,
  ]) {
    await model.deleteMany();
  }
});

describe("PlatformReadinessService", () => {
  it("is READY only when every mandatory check passes", async () => {
    await applyMigration(BASE_FILE, BASE_HASH);

    const report = await makeService().evaluate();

    expect(report.ready).toBe(true);
    expect(report.state).toBe("READY");
    expect(report.checks).toHaveLength(15);
    expect(check(report, "database").state).toBe("READY");
    expect(check(report, "migrations").state).toBe("READY");
    expect(check(report, "ledger").state).toBe("READY");
    expect(check(report, "convergence").state).toBe("READY");
    // Canonical financial sub-payload is READY with no blocking reasons.
    expect(report.financial.state).toBe("READY");
    expect(report.financial.reasons).toEqual([]);
  });

  it("keeps the convergence gate closed by default even when everything else is healthy", async () => {
    await applyMigration(BASE_FILE, BASE_HASH);

    const report = await makeService({ convergence: undefined }).evaluate();

    expect(report.ready).toBe(false);
    expect(report.state).toBe("BLOCKED");
    expect(check(report, "convergence").detail).toBe("CONVERGENCE_INCOMPLETE");
  });

  it("fails closed on an unknown migration row", async () => {
    await applyMigration(BASE_FILE, BASE_HASH);
    await applyMigration("999_unknown", "a".repeat(64));

    const report = await makeService().evaluate();

    expect(report.ready).toBe(false);
    expect(check(report, "migrations").detail).toBe("MIGRATION_UNKNOWN");
  });

  it("fails closed when an applied migration hash drifted", async () => {
    await applyMigration(BASE_FILE, "b".repeat(64));

    const report = await makeService().evaluate();

    expect(check(report, "migrations").detail).toBe("MIGRATION_APPLIED_DRIFT");
  });

  it("fails closed when a manifest migration was never applied", async () => {
    const directory = mkdtempSync(join(tempRoot, "incomplete-"));
    const path = writeManifest(directory, {
      "001_one": "SELECT 1;\n",
      "002_two": "SELECT 2;\n",
    });
    await applyMigration("001_one", sha256("SELECT 1;\n"));

    const report = await makeService({
      migrations: new ManifestMigrationIntegrityProbe(prisma, {
        manifestPath: path,
        provider: "postgres",
        nodeEnv: "test",
      }),
    }).evaluate();

    expect(check(report, "migrations").detail).toBe("MIGRATION_MISSING");
  });

  it("fails closed when the migration ledger has no hashes", async () => {
    await prisma.$executeRawUnsafe('DROP TABLE "_migrations"');
    await prisma.$executeRawUnsafe(
      'CREATE TABLE "_migrations" ("name" TEXT NOT NULL PRIMARY KEY, "appliedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)'
    );

    const report = await makeService().evaluate();

    expect(check(report, "migrations").detail).toBe("MIGRATION_LEDGER_UNREADABLE");
  });

  it("fails closed when the manifest is incomplete", async () => {
    const directory = mkdtempSync(join(tempRoot, "unlisted-"));
    const path = writeManifest(directory, { "001_one": "SELECT 1;\n" });
    writeFileSync(join(directory, "002_unlisted.sql"), "SELECT 2;\n");

    const report = await makeService({
      migrations: new ManifestMigrationIntegrityProbe(prisma, {
        manifestPath: path,
        provider: "postgres",
        nodeEnv: "test",
      }),
    }).evaluate();

    expect(check(report, "migrations").detail).toBe("MIGRATION_MANIFEST_INCOMPLETE");
  });

  it("requires PostgreSQL in production", async () => {
    await applyMigration(BASE_FILE, BASE_HASH);

    const report = await makeService({ nodeEnv: "production" }).evaluate();

    expect(check(report, "database").state).toBe("BLOCKED");
    expect(check(report, "database").detail).toBe("POSTGRES_REQUIRED");
  });

  it("fails closed on a stale treasury reconciliation", async () => {
    await applyMigration(BASE_FILE, BASE_HASH);
    const asset = await createActiveAsset();
    await prisma.treasuryReconciliation.create({
      data: {
        assetId: asset.id,
        chainId: asset.chainId,
        observedAtomic: "0",
        ledgerAtomic: "0",
        differenceAtomic: "0",
        blockNumber: "1",
        status: "MATCHED",
        evidence: { source: "test" },
        createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
      },
    });

    const report = await makeService({
      payoutsEnabled: true,
      reconciliationMaxAgeMs: 60_000,
    }).evaluate();

    expect(report.ready).toBe(false);
    expect(check(report, "reconciliation").state).toBe("NOT_READY");
    expect(check(report, "reconciliation").detail).toBe("RECONCILIATION_STALE");
    expect(report.financial.reasons).toContain("RECONCILIATION_UNVERIFIED");
  });

  it("fails closed when an active asset has no reconciliation", async () => {
    await applyMigration(BASE_FILE, BASE_HASH);
    await createActiveAsset();

    const report = await makeService({ payoutsEnabled: true }).evaluate();

    expect(check(report, "reconciliation").state).toBe("BLOCKED");
    expect(check(report, "reconciliation").detail).toBe("RECONCILIATION_MISSING");
  });

  it("fails closed on a stale pending outbox row", async () => {
    await applyMigration(BASE_FILE, BASE_HASH);
    const table = await prisma.table.create({
      data: { name: "readiness-outbox", mode: "CASH", config: {} },
    });
    await prisma.gameOutbox.create({
      data: {
        tableId: table.id,
        kind: "PUBLISH_EVENT",
        dedupeKey: `readiness-${table.id}`,
        payload: {},
        status: "PENDING",
        availableAt: new Date(Date.now() - 60 * 60 * 1000),
      },
    });

    const report = await makeService({ outboxMaxPendingAgeMs: 60_000 }).evaluate();

    expect(check(report, "gameAuthority").state).toBe("NOT_READY");
    expect(check(report, "gameAuthority").detail).toBe("OUTBOX_STALE_PENDING");
  });

  it("fails closed on a failed outbox row", async () => {
    await applyMigration(BASE_FILE, BASE_HASH);
    const table = await prisma.table.create({
      data: { name: "readiness-failed", mode: "CASH", config: {} },
    });
    await prisma.gameOutbox.create({
      data: {
        tableId: table.id,
        kind: "PUBLISH_EVENT",
        dedupeKey: `readiness-failed-${table.id}`,
        payload: {},
        status: "FAILED",
      },
    });

    const report = await makeService().evaluate();

    expect(check(report, "gameAuthority").detail).toBe("OUTBOX_FAILED");
  });

  it("blocks on an open critical financial incident", async () => {
    await applyMigration(BASE_FILE, BASE_HASH);
    await prisma.financialIncident.create({
      data: { kind: "LEDGER_IMBALANCE", severity: "CRITICAL", status: "OPEN", evidence: {} },
    });

    const report = await makeService().evaluate();

    expect(report.state).toBe("BLOCKED");
    expect(check(report, "incidents").detail).toBe("OPEN_CRITICAL_INCIDENT");
    expect(report.financial.reasons).toContain("OPEN_CRITICAL_INCIDENT");
  });

  it("fails closed on RPC quorum disagreement", async () => {
    await applyMigration(BASE_FILE, BASE_HASH);
    await createActiveAsset();

    const report = await makeService({
      payoutsEnabled: true,
      chainQuorum: { verifyQuorum: async () => ({ ok: false, code: "QUORUM_DISAGREEMENT" }) },
    }).evaluate();

    expect(check(report, "rpcQuorum").state).toBe("BLOCKED");
    expect(check(report, "rpcQuorum").detail).toBe("QUORUM_DISAGREEMENT");
    expect(report.financial.reasons).toContain("RPC_QUORUM_UNVERIFIED");
  });

  it("fails closed on low native gas when payouts are enabled", async () => {
    await applyMigration(BASE_FILE, BASE_HASH);
    await createActiveAsset();

    const report = await makeService({
      payoutsEnabled: true,
      custody: {
        checkReadiness: async () => ({
          ready: true,
          gasReady: false,
          code: "CUSTODY_READY",
          gasCode: "NATIVE_GAS_LOW",
        }),
      },
    }).evaluate();

    expect(check(report, "nativeGas").state).toBe("NOT_READY");
    expect(check(report, "nativeGas").detail).toBe("NATIVE_GAS_LOW");
    expect(report.financial.reasons).toContain("NATIVE_GAS_UNVERIFIED");
  });

  it("fails closed when a required custody probe is missing", async () => {
    await applyMigration(BASE_FILE, BASE_HASH);
    await createActiveAsset();

    const report = await makeService({ payoutsEnabled: true, custody: undefined }).evaluate();

    expect(check(report, "custody").detail).toBe("PROBE_UNCONFIGURED");
    expect(check(report, "nativeGas").detail).toBe("PROBE_UNCONFIGURED");
  });

  it("keeps readiness false while frozen and still runs every monitor check", async () => {
    await applyMigration(BASE_FILE, BASE_HASH);

    const report = await makeService({
      freeze: { getState: async () => ({ frozen: true, code: "FROZEN" }) },
    }).evaluate();

    expect(report.ready).toBe(false);
    expect(check(report, "freeze").state).toBe("NOT_READY");
    expect(report.checks).toHaveLength(15);
  });

  it("bounds probe time and fails closed", async () => {
    await applyMigration(BASE_FILE, BASE_HASH);

    const report = await makeService({
      rpcQuorumRequired: true,
      probeTimeoutMs: 20,
      chainQuorum: { verifyQuorum: () => new Promise(() => undefined) },
    }).evaluate();

    expect(check(report, "rpcQuorum").detail).toBe("PROBE_TIMEOUT");
  });

  it("never leaks connection strings or raw probe errors in the report", async () => {
    await applyMigration(BASE_FILE, BASE_HASH);

    const secret = "https://rpc.internal.example/SECRET_API_KEY";
    const report = await makeService({
      migrations: { check: async () => Promise.reject(new Error(`boom ${secret}`)) },
      chainQuorum: {
        verifyQuorum: async () => Promise.reject(new Error(`postgresql://user:pass@host/db`)),
      },
    }).evaluate();

    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("SECRET_API_KEY");
    expect(serialized).not.toContain("postgresql://");
    expect(serialized).not.toContain("rpc.internal.example");
    expect(check(report, "migrations").detail).toBe("PROBE_FAILURE");
  });
});
