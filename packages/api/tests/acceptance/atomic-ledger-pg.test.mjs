/**
 * PostgreSQL acceptance: atomic journal immutability and sealing.
 *
 * Provisions a disposable PostgreSQL container, applies the full reviewed
 * migration manifest (prisma/postgres/migrations.json -> 001 baseline +
 * 002_financial_invariants) through scripts/migrate-postgres.mjs, and proves,
 * independently of the application, that:
 *   - a committed (sealed) journal transaction cannot receive new postings,
 *     even a balanced pair
 *   - journal transactions/postings cannot be UPDATEd (except the one-way seal)
 *     or DELETEd
 *   - an unsealed or unbalanced journal cannot commit
 *
 * Skips (rather than fails) when Docker is unavailable.
 */
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import pg from "pg";

const exec = promisify(execFile);
const name = `pokertools-atomic-ledger-${randomUUID()}`;
const migrateScript = fileURLToPath(new URL("../../scripts/migrate-postgres.mjs", import.meta.url));

const ASSET_ID = "eip155:31337/erc20:0x1111111111111111111111111111111111111111";
const TOKEN = "0x1111111111111111111111111111111111111111";
const TREASURY = "0x2222222222222222222222222222222222222222";

let pool;
let databaseUrl;

async function dockerAvailable() {
  try {
    await exec("docker", ["info"], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/** Apply the reviewed, checksum-verified manifest from a clean public schema. */
async function migrate() {
  await exec(process.execPath, [migrateScript], {
    env: { ...process.env, DATABASE_URL: databaseUrl },
    timeout: 120000,
  });
}

before(async () => {
  assert(await dockerAvailable(), "Docker is required for PostgreSQL ledger acceptance");
  await exec(
    "docker",
    [
      "run",
      "--rm",
      "-d",
      "--name",
      name,
      "-e",
      "POSTGRES_PASSWORD=local-atomic-ledger-test-only",
      "-p",
      "127.0.0.1::5432",
      "postgres:18-alpine",
    ],
    { timeout: 600000 }
  );
  const { stdout } = await exec("docker", ["port", name, "5432/tcp"]);
  const port = Number(stdout.trim().split(":").at(-1));
  assert(Number.isInteger(port) && port > 0);
  databaseUrl = `postgresql://postgres:local-atomic-ledger-test-only@127.0.0.1:${port}/postgres`;
  pool = new pg.Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 1000 });
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      await pool.query("SELECT 1");
      return;
    } catch {
      await setTimeout(250);
    }
  }
  throw new Error("Test PostgreSQL did not start");
});

after(async () => {
  await pool?.end().catch(() => undefined);
  await exec("docker", ["rm", "-f", name]).catch(() => undefined);
});

beforeEach(async () => {
  if (!pool) return;
  await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
  await migrate();
});

function setupSql() {
  return `
    INSERT INTO "Asset" ("id","chainId","tokenAddress","symbol","decimals","treasuryAddress","rpcUrls","minGasAtomic","updatedAt")
    VALUES ('${ASSET_ID}', 31337, '${TOKEN}', 'USDC', 6, '${TREASURY}', '[]'::jsonb, '0', NOW());

    INSERT INTO "AtomicAccount" ("id","assetId","ownerId","ownerKey","class","balanceAtomic","updatedAt")
    VALUES ('acc-user','${ASSET_ID}','user1','user1','USER_AVAILABLE','0',NOW()),
           ('acc-treasury','${ASSET_ID}',NULL,'@system','TREASURY_RESERVE','0',NOW());
  `;
}

async function createSealedJournal(client) {
  await client.query(setupSql());
  await client.query("BEGIN");
  await client.query(
    `INSERT INTO "JournalTransaction" ("id","assetId","requestId","payloadHash")
     VALUES ('jt-1','${ASSET_ID}','req-1','hash-1')`
  );
  await client.query(
    `INSERT INTO "JournalPosting" ("id","transactionId","assetId","accountId","amountAtomic")
     VALUES ('jp-1','jt-1','${ASSET_ID}','acc-treasury','-100'),
            ('jp-2','jt-1','${ASSET_ID}','acc-user','100')`
  );
  await client.query(`UPDATE "JournalTransaction" SET "sealed" = TRUE WHERE "id" = 'jt-1'`);
  await client.query("COMMIT");
}

test("rejects new balanced postings injected into a committed sealed journal", async () => {
  const client = await pool.connect();
  try {
    await createSealedJournal(client);
    await assert.rejects(
      client.query(
        `INSERT INTO "JournalPosting" ("id","transactionId","assetId","accountId","amountAtomic")
         VALUES ('jp-3','jt-1','${ASSET_ID}','acc-user','10'),('jp-4','jt-1','${ASSET_ID}','acc-treasury','-10')`
      ),
      /JOURNAL_SEALED/
    );
  } finally {
    client.release();
  }
});

test("rejects UPDATE and DELETE of journal history", async () => {
  const client = await pool.connect();
  try {
    await createSealedJournal(client);
    await assert.rejects(
      client.query(`UPDATE "JournalPosting" SET "amountAtomic" = '1' WHERE "id" = 'jp-1'`),
      /JOURNAL_IMMUTABLE/
    );
    await assert.rejects(
      client.query(`DELETE FROM "JournalPosting" WHERE "id" = 'jp-1'`),
      /JOURNAL_IMMUTABLE/
    );
    await assert.rejects(
      client.query(`UPDATE "JournalTransaction" SET "payloadHash" = 'changed' WHERE "id" = 'jt-1'`),
      /JOURNAL_IMMUTABLE/
    );
    await assert.rejects(
      client.query(`DELETE FROM "JournalTransaction" WHERE "id" = 'jt-1'`),
      /JOURNAL_IMMUTABLE/
    );
  } finally {
    client.release();
  }
});

test("rejects committing an unsealed journal", async () => {
  const client = await pool.connect();
  try {
    await client.query(setupSql());
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO "JournalTransaction" ("id","assetId","requestId","payloadHash")
       VALUES ('jt-2','${ASSET_ID}','req-2','hash-2')`
    );
    await client.query(
      `INSERT INTO "JournalPosting" ("id","transactionId","assetId","accountId","amountAtomic")
       VALUES ('jp-20','jt-2','${ASSET_ID}','acc-treasury','-5'),
              ('jp-21','jt-2','${ASSET_ID}','acc-user','5')`
    );
    // No seal: the deferred constraint trigger must fail at COMMIT.
    await assert.rejects(client.query("COMMIT"), /JOURNAL_NOT_SEALED/);
    await client.query("ROLLBACK").catch(() => undefined);
  } finally {
    client.release();
  }
});

test("rejects committing a sealed but unbalanced journal", async () => {
  const client = await pool.connect();
  try {
    await client.query(setupSql());
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO "JournalTransaction" ("id","assetId","requestId","payloadHash")
       VALUES ('jt-3','${ASSET_ID}','req-3','hash-3')`
    );
    await client.query(
      `INSERT INTO "JournalPosting" ("id","transactionId","assetId","accountId","amountAtomic")
       VALUES ('jp-30','jt-3','${ASSET_ID}','acc-user','5'),
              ('jp-31','jt-3','${ASSET_ID}','acc-treasury','-3')`
    );
    await client.query(`UPDATE "JournalTransaction" SET "sealed" = TRUE WHERE "id" = 'jt-3'`);
    await assert.rejects(client.query("COMMIT"), /JOURNAL_NOT_BALANCED/);
    await client.query("ROLLBACK").catch(() => undefined);
  } finally {
    client.release();
  }
});
