import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import pg from "pg";

const exec = promisify(execFile);
const name = `pokertools-migration-test-${randomUUID()}`;
const script = fileURLToPath(new URL("../../scripts/migrate-postgres.mjs", import.meta.url));
const packageDir = fileURLToPath(new URL("../..", import.meta.url));
const manifestUrl = new URL("../../prisma/postgres/migrations.json", import.meta.url);
// prisma.config.ts materialises this PostgreSQL-provider copy of
// prisma/schema.prisma for the active DATABASE_URL before every Prisma command.
const runtimeSchema = ".runtime/schema.postgresql.prisma";
let pool;
let databaseUrl;

async function migrate() {
  try {
    const result = await exec(process.execPath, [script], {
      env: { ...process.env, DATABASE_URL: databaseUrl },
      timeout: 60000,
    });
    return { ok: true, ...result };
  } catch (error) {
    return { ok: false, stdout: error.stdout, stderr: error.stderr };
  }
}

async function loadManifest() {
  return JSON.parse(await readFile(manifestUrl, "utf8"));
}

/**
 * `migrate diff` compares the live migrated database (datasource from
 * prisma.config.ts) against the Prisma model. `--exit-code` returns 2 when any
 * difference exists, while `--script` keeps the exact DDL for assertions.
 */
async function migrateDiff() {
  try {
    const { stdout } = await exec(
      "npx",
      [
        "prisma",
        "migrate",
        "diff",
        "--from-config-datasource",
        `--to-schema=${runtimeSchema}`,
        "--script",
        "--exit-code",
      ],
      {
        cwd: packageDir,
        env: { ...process.env, DATABASE_URL: databaseUrl },
        timeout: 120000,
        maxBuffer: 10 * 1024 * 1024,
      },
    );
    return { exitCode: 0, stdout, stderr: "" };
  } catch (error) {
    return { exitCode: error.code ?? 1, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
}

/**
 * The migrated database legitimately contains objects the Prisma model does not
 * describe: the `_migrations` bookkeeping table and the named hand-written
 * triggers/CHECK constraints added by the invariant migrations. `migrate diff`
 * does not introspect triggers or CHECK constraints, so only the bookkeeping
 * table can appear in the script. Any other DDL is real model drift: every
 * field, index, unique, foreign key and enum must match exactly.
 */
function assertNoModelDrift(scriptOutput) {
  const ddl = scriptOutput
    .split("\n")
    .filter((line) => line.trim() !== "" && !line.trim().startsWith("--"))
    .join("\n")
    .trim();
  const unaccounted = ddl.replace(/^DROP TABLE "_migrations";$/m, "").trim();
  assert.equal(unaccounted, "", `Prisma model drift detected:\n${scriptOutput}`);
}

before(async () => {
  await exec("docker", ["run", "--rm", "-d", "--name", name,
    "-e", "POSTGRES_PASSWORD=local-migration-test-only",
    "-p", "127.0.0.1::5432", "postgres:18-alpine"], { timeout: 600000 });
  const { stdout } = await exec("docker", ["port", name, "5432/tcp"]);
  const port = Number(stdout.trim().split(":").at(-1));
  assert(Number.isInteger(port) && port > 0);
  databaseUrl = `postgresql://postgres:local-migration-test-only@127.0.0.1:${port}/postgres`;
  pool = new pg.Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 1000 });
  for (let attempt = 0; attempt < 60; attempt++) {
    try { await pool.query("SELECT 1"); return; } catch { await setTimeout(250); }
  }
  throw new Error("Test PostgreSQL did not start");
});

after(async () => {
  await pool?.end();
  await exec("docker", ["rm", "-f", name]).catch(() => undefined);
});

beforeEach(async () => {
  // This disposable container belongs exclusively to this test process.
  await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
});

test("applies reviewed migrations once, including concurrent startup", async () => {
  const results = await Promise.all([migrate(), migrate()]);
  assert(results.every((result) => result.ok), JSON.stringify(results));
  assert((await migrate()).ok);
  const { rows } = await pool.query('SELECT "name", "sha256" FROM "_migrations" ORDER BY "name"');
  const manifest = await loadManifest();
  assert.deepEqual(rows, manifest.migrations.map(({ name, sha256 }) => ({ name, sha256 })));
  assert(rows.every((row) => /^[a-f0-9]{64}$/.test(row.sha256)));
});

test("unknown migration fails closed", async () => {
  assert((await migrate()).ok);
  await pool.query('INSERT INTO "_migrations" ("name", "sha256") VALUES ($1, $2)', ["unknown", "a".repeat(64)]);
  const result = await migrate();
  assert.equal(result.ok, false);
  assert.match(result.stderr, /MIGRATION_UNKNOWN/);
});

test("changed applied checksum fails closed without rewriting history", async () => {
  assert((await migrate()).ok);
  await pool.query('UPDATE "_migrations" SET "sha256" = $1 WHERE "name" = $2', ["b".repeat(64), "001_initial_schema"]);
  const result = await migrate();
  assert.equal(result.ok, false);
  assert.match(result.stderr, /MIGRATION_APPLIED_DRIFT/);
  const { rows } = await pool.query('SELECT "sha256" FROM "_migrations" WHERE "name" = $1', ["001_initial_schema"]);
  assert.equal(rows[0].sha256, "b".repeat(64));
});

test("gaps in applied history fail closed", async () => {
  assert((await migrate()).ok);
  await pool.query('DELETE FROM "_migrations" WHERE "name" = $1', ["001_initial_schema"]);
  const result = await migrate();
  assert.equal(result.ok, false);
  assert.match(result.stderr, /MIGRATION_ORDER_DRIFT/);
});

test("unhashed historical state is not automatically blessed", async () => {
  await pool.query('CREATE TABLE "_migrations" ("name" TEXT PRIMARY KEY, "appliedAt" TIMESTAMPTZ DEFAULT NOW())');
  const result = await migrate();
  assert.equal(result.ok, false);
  assert.match(result.stderr, /MIGRATION_DEPENDENCY_FAILURE/);
  assert(!result.stderr.includes(databaseUrl));
});

test("empty database migrated from reviewed files matches the Prisma model", async () => {
  assert((await migrate()).ok);
  const { exitCode, stdout, stderr } = await migrateDiff();
  assert.equal(exitCode, 2, `migrate diff did not run:\n${stdout}\n${stderr}`);
  assertNoModelDrift(stdout);
});

test("model drift is detected for a missing column, index and foreign key", async () => {
  assert((await migrate()).ok);
  await pool.query('ALTER TABLE "CustodyHeartbeat" DROP COLUMN "signerReady"');
  await pool.query('DROP INDEX "User_kind_idx"');
  await pool.query('ALTER TABLE "ServiceCredential" DROP CONSTRAINT "ServiceCredential_userId_fkey"');
  const { exitCode, stdout } = await migrateDiff();
  assert.equal(exitCode, 2);
  assert.match(stdout, /ALTER TABLE "CustodyHeartbeat" ADD COLUMN\s+"signerReady" BOOLEAN NOT NULL;/);
  assert.match(stdout, /CREATE INDEX "User_kind_idx" ON "User"\("kind"\);/);
  assert.match(
    stdout,
    /ADD CONSTRAINT "ServiceCredential_userId_fkey" FOREIGN KEY \("userId"\) REFERENCES "User"\("id"\) ON DELETE CASCADE/,
  );
  assert.throws(() => assertNoModelDrift(stdout), /Prisma model drift detected/);
});

test("already-applied current baseline restarts without re-running or drift", async () => {
  assert((await migrate()).ok);
  const restart = await migrate();
  assert(restart.ok, JSON.stringify(restart));
  assert.doesNotMatch(restart.stdout, /^Applied /m);

  const manifest = await loadManifest();
  const { rows } = await pool.query('SELECT "name", "sha256" FROM "_migrations" ORDER BY "name"');
  assert.deepEqual(rows, manifest.migrations.map(({ name, sha256 }) => ({ name, sha256 })));

  const { exitCode, stdout, stderr } = await migrateDiff();
  assert.equal(exitCode, 2, `migrate diff did not run:\n${stdout}\n${stderr}`);
  assertNoModelDrift(stdout);
});
