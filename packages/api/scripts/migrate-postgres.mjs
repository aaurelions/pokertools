/**
 * migrate-postgres.mjs — Idempotent PostgreSQL migration runner
 *
 * Reads prisma/postgres/migrations.json and applies any migration whose name
 * is not yet recorded in the "_migrations" tracking table.  Each migration is
 * executed inside its own transaction, and the tracking row is inserted within
 * that same transaction so partial failures are never recorded.
 *
 * Required environment variable:
 *   DATABASE_URL  – PostgreSQL connection string (postgresql://…)
 *
 * Usage:
 *   node scripts/migrate-postgres.mjs
 *
 * Exit codes:
 *   0 – all migrations applied (or already up-to-date)
 *   1 – configuration error, connection error, or migration failure
 */

import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageDir = resolve(__dirname, "..");

async function main() {
  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    console.error("DATABASE_URL is not set — cannot run PostgreSQL migrations.");
    process.exit(1);
  }

  const normalized = databaseUrl.trim();
  if (!normalized.startsWith("postgresql://") && !normalized.startsWith("postgres://")) {
    console.error(
      `DATABASE_URL does not look like a PostgreSQL connection string (got: ${normalized.slice(0, 40)}...)`,
    );
    process.exit(1);
  }

  // -----------------------------------------------------------------------
  // Load the migration manifest
  // -----------------------------------------------------------------------
  const manifestPath = resolve(packageDir, "prisma", "postgres", "migrations.json");
  if (!existsSync(manifestPath)) {
    console.error(`Migration manifest not found at ${manifestPath}`);
    process.exit(1);
  }

  /** @type {{ migrations: Array<{ name: string, file: string, description: string }> }} */
  const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));

  if (!Array.isArray(manifest.migrations) || manifest.migrations.length === 0) {
    console.log("No migrations defined in manifest — nothing to do.");
    process.exit(0);
  }

  // -----------------------------------------------------------------------
  // Connect to PostgreSQL
  // -----------------------------------------------------------------------
  const { Pool } = pg;
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });

  let client;
  try {
    client = await pool.connect();
  } catch (err) {
    console.error("Failed to connect to PostgreSQL:", err.message);
    await pool.end();
    process.exit(1);
  }

  try {
    // -------------------------------------------------------------------
    // Ensure the tracking table exists (idempotent)
    // -------------------------------------------------------------------
    await client.query(`
      CREATE TABLE IF NOT EXISTS "_migrations" (
        "name"       TEXT        NOT NULL PRIMARY KEY,
        "appliedAt"  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    console.log('Ensured "_migrations" tracking table exists.');

    // -------------------------------------------------------------------
    // Determine which migrations have already been applied
    // -------------------------------------------------------------------
    const { rows: appliedRows } = await client.query(
      'SELECT "name" FROM "_migrations"',
    );
    const appliedNames = new Set(appliedRows.map((r) => r.name));

    // -------------------------------------------------------------------
    // Apply pending migrations in order
    // -------------------------------------------------------------------
    let applied = 0;
    let skipped = 0;

    for (const migration of manifest.migrations) {
      if (appliedNames.has(migration.name)) {
        console.log(`  [SKIP] ${migration.name} — already applied`);
        skipped++;
        continue;
      }

      const sqlPath = resolve(packageDir, "prisma", "postgres", migration.file);
      if (!existsSync(sqlPath)) {
        throw new Error(
          `Migration file not found for "${migration.name}": ${sqlPath}`,
        );
      }

      const sql = readFileSync(sqlPath, "utf-8");

      console.log(`  [RUN]  ${migration.name} — ${migration.description}`);

      // Execute migration + tracking insert in a single transaction
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query(
          'INSERT INTO "_migrations" ("name") VALUES ($1)',
          [migration.name],
        );
        await client.query("COMMIT");
        console.log(`  [OK]   ${migration.name}`);
        applied++;
      } catch (err) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw new Error(
          `Migration "${migration.name}" failed: ${err.message}`,
          { cause: err },
        );
      }
    }

    if (applied === 0 && skipped === 0) {
      console.log("No migrations to apply.");
    } else {
      console.log(
        `Migration complete: ${applied} applied, ${skipped} skipped.`,
      );
    }
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error("Migration failed:", err.message);
  process.exit(1);
});
