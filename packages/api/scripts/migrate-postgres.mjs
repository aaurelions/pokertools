/** Reviewed, checksum-verified PostgreSQL migrations; no legacy hash backfill. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const directory = resolve(dirname(fileURLToPath(import.meta.url)), "../prisma/postgres");
const digest = (sql) => createHash("sha256").update(sql).digest("hex");

function loadMigrations() {
  const manifest = JSON.parse(readFileSync(resolve(directory, "migrations.json"), "utf8"));
  if (!Array.isArray(manifest.migrations) || manifest.migrations.length === 0) {
    throw new Error("MIGRATION_MANIFEST_INVALID");
  }
  const names = new Set();
  return manifest.migrations.map((migration) => {
    if (
      typeof migration.name !== "string" ||
      !/^\d{3}_[a-z0-9_]+$/.test(migration.name) ||
      migration.file !== `${migration.name}.sql` ||
      !/^[a-f0-9]{64}$/.test(migration.sha256 ?? "") ||
      names.has(migration.name)
    ) {
      throw new Error("MIGRATION_MANIFEST_INVALID");
    }
    names.add(migration.name);
    const sql = readFileSync(resolve(directory, migration.file), "utf8");
    if (digest(sql) !== migration.sha256) throw new Error("MIGRATION_FILE_DRIFT");
    return { name: migration.name, sha256: migration.sha256, sql };
  });
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl || !/^postgres(ql)?:\/\//.test(databaseUrl)) {
    throw new Error("POSTGRES_DATABASE_URL_REQUIRED");
  }
  // Verify every file before connecting or modifying any database state.
  const migrations = loadMigrations();
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 10000 });
  let client;
  try {
    client = await pool.connect();
    await client.query("SET statement_timeout = '30s'");
    // Serialize migrators across API replicas. PostgreSQL releases this session
    // lock on disconnect, including process crashes.
    await client.query("SELECT pg_advisory_lock(724019862)");
    await client.query(`CREATE TABLE IF NOT EXISTS "_migrations" (
      "name" TEXT NOT NULL PRIMARY KEY,
      "sha256" TEXT NOT NULL CHECK ("sha256" ~ '^[a-f0-9]{64}$'),
      "appliedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);

    // A pre-convergence tracking table without hashes fails here. Never infer
    // integrity by stamping today's file hash onto historical unverified SQL.
    const { rows } = await client.query('SELECT "name", "sha256" FROM "_migrations"');
    const applied = new Map(rows.map((row) => [row.name, row.sha256]));
    if (rows.some((row) => !migrations.some((migration) => migration.name === row.name))) {
      throw new Error("MIGRATION_UNKNOWN");
    }
    let pendingSeen = false;
    for (const migration of migrations) {
      if (applied.has(migration.name)) {
        if (pendingSeen) throw new Error("MIGRATION_ORDER_DRIFT");
        if (applied.get(migration.name) !== migration.sha256) throw new Error("MIGRATION_APPLIED_DRIFT");
      } else {
        pendingSeen = true;
      }
    }

    for (const migration of migrations) {
      if (applied.has(migration.name)) continue;
      await client.query("BEGIN");
      try {
        await client.query(migration.sql);
        await client.query('INSERT INTO "_migrations" ("name", "sha256") VALUES ($1, $2)', [migration.name, migration.sha256]);
        await client.query("COMMIT");
        console.log(`Applied ${migration.name}`);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
    console.log("PostgreSQL migrations verified");
  } finally {
    client?.release();
    await pool.end();
  }
}

main().catch((error) => {
  // pg errors may contain connection credentials or arbitrary SQL values.
  const reason = error instanceof Error && /^MIGRATION_[A-Z_]+$|^POSTGRES_DATABASE_URL_REQUIRED$/.test(error.message)
    ? error.message
    : "MIGRATION_DEPENDENCY_FAILURE";
  console.error(reason);
  process.exitCode = 1;
});
