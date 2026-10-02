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
  const manifest = JSON.parse(await readFile(new URL("../../prisma/postgres/migrations.json", import.meta.url), "utf8"));
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
