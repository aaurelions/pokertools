/**
 * sync-db.mjs — Runtime database initialisation
 *
 * For SQLite file: datasources, this script:
 *   1. Creates the parent directory if it doesn't exist.
 *   2. Opens the database with better-sqlite3.
 *   3. Applies prisma/schema.sql (generated at build-time) if the DB is
 *      missing critical tables.
 *
 * For non-file datasources (e.g. PostgreSQL), it logs a message and exits
 * cleanly — external migration tooling is expected in that case.
 *
 * Exits non-zero on any error.
 *
 * Usage (from /app/packages/api):
 *   node scripts/sync-db.mjs
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageDir = resolve(__dirname, "..");

function main() {
  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    console.error("DATABASE_URL is not set — cannot sync database schema.");
    process.exit(1);
  }

  // -----------------------------------------------------------------------
  // Only handle SQLite file: URLs in this script.
  // -----------------------------------------------------------------------
  if (!databaseUrl.startsWith("file:")) {
    console.log(
      `DATABASE_URL is not a file: URL (${databaseUrl}) — skipping runtime schema sync. ` +
        "External migration tooling (e.g. prisma migrate deploy) should be used for this datasource.",
    );
    process.exit(0);
  }

  // -----------------------------------------------------------------------
  // Resolve the file path from the file: URL.
  // file:./relative/path   -> packageDir/relative/path
  // file:../relative/path  -> resolved relative to CWD
  // file:/absolute/path    -> /absolute/path
  // -----------------------------------------------------------------------
  let dbPath = databaseUrl.slice("file:".length);

  // Strip query parameters if any (e.g. file:foo.db?mode=memory)
  const queryIdx = dbPath.indexOf("?");
  if (queryIdx !== -1) {
    dbPath = dbPath.slice(0, queryIdx);
  }

  // Resolve relative paths against packageDir (where prisma/ schema lives)
  if (!dbPath.startsWith("/")) {
    dbPath = resolve(packageDir, dbPath);
  }

  // -----------------------------------------------------------------------
  // Ensure parent directories exist
  // -----------------------------------------------------------------------
  const dbDir = dirname(dbPath);
  if (!existsSync(dbDir)) {
    mkdirSync(dbDir, { recursive: true });
    console.log(`Created database directory: ${dbDir}`);
  }

  // -----------------------------------------------------------------------
  // Connect to the database (creates file if missing)
  // -----------------------------------------------------------------------
  console.log(`Opening SQLite database at ${dbPath}`);
  const db = new Database(dbPath);

  // Keep the default rollback journal mode. Docker E2E tests read the same
  // bind-mounted SQLite file from the host while the API container writes to it;
  // WAL can leave host-side long-lived readers on stale snapshots in that setup.
  db.pragma("foreign_keys = ON");

  // -----------------------------------------------------------------------
  // Check if schema already applied (look for a known table)
  // -----------------------------------------------------------------------
  const tableExists = db
    .prepare(
      "SELECT count(*) AS cnt FROM sqlite_master WHERE type = 'table' AND name = 'AdminWallet'",
    )
    .get();

  if (tableExists.cnt > 0) {
    console.log(
      "Database already contains schema tables — skipping schema.sql application.",
    );
    db.close();
    process.exit(0);
  }

  // -----------------------------------------------------------------------
  // Apply schema.sql
  // -----------------------------------------------------------------------
  const schemaPath = resolve(packageDir, "prisma", "schema.sql");
  if (!existsSync(schemaPath)) {
    console.error(`schema.sql not found at ${schemaPath}`);
    db.close();
    process.exit(1);
  }

  console.log(`Applying schema from ${schemaPath}`);
  const schemaSql = readFileSync(schemaPath, "utf-8");

  // Execute as a single transaction so the schema is atomic
  try {
    db.exec(schemaSql);
    console.log("Schema applied successfully.");
  } catch (err) {
    console.error("Failed to apply schema.sql:", err.message);
    db.close();
    process.exit(1);
  }

  // -----------------------------------------------------------------------
  // Verify
  // -----------------------------------------------------------------------
  const verify = db
    .prepare(
      "SELECT count(*) AS cnt FROM sqlite_master WHERE type = 'table' AND name = 'AdminWallet'",
    )
    .get();

  if (verify.cnt === 0) {
    console.error("Verification failed: AdminWallet table not found after schema application.");
    db.close();
    process.exit(1);
  }

  console.log("Schema verification passed.");
  db.close();
}

main();
