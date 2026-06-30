/**
 * validate-migrations.mjs — CI guard for schema.sql freshness
 *
 * Generates a fresh schema.sql from the current Prisma schema, compares it
 * against the checked-in prisma/schema.sql, and fails if they differ.
 *
 * This ensures that every PR that changes the Prisma schema also regenerates
 * schema.sql — keeping the runtime bootstrap artifact in sync with the
 * source of truth.
 *
 * Usage:  node scripts/validate-migrations.mjs
 * Exit 0: schema.sql is up-to-date.
 * Exit 1: drift detected — run `node scripts/export-schema.mjs` and commit.
 */

import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageDir = resolve(__dirname, "..");

// ---------------------------------------------------------------------------
// 1. Materialise the current schema into a throw-away SQLite database
// ---------------------------------------------------------------------------
const tmpDir = mkdtempSync(join(tmpdir(), "pokertools-validate-"));
const dbPath = join(tmpDir, "validate.db");
const dbUrl = `file:${dbPath}`;

try {
  execSync("npx prisma db push --accept-data-loss", {
    cwd: packageDir,
    env: { ...process.env, DATABASE_URL: dbUrl },
    stdio: "pipe",
  });
} catch (err) {
  console.error("prisma db push failed:", err.message);
  rmSync(tmpDir, { recursive: true, force: true });
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 2. Extract DDL as idempotent SQL (same logic as export-schema.mjs)
// ---------------------------------------------------------------------------
let db;
try {
  db = new Database(dbPath);
} catch (err) {
  console.error("Failed to open throw-away database:", err.message);
  rmSync(tmpDir, { recursive: true, force: true });
  process.exit(1);
}

const rows = db
  .prepare(
    `SELECT type, name, sql FROM sqlite_master
     WHERE sql IS NOT NULL
       AND type IN ('table', 'index', 'trigger')
       AND name NOT LIKE 'sqlite_%'
     ORDER BY CASE type WHEN 'table' THEN 1 WHEN 'index' THEN 2 WHEN 'trigger' THEN 3 END, name`,
  )
  .all();

const freshLines = ["-- HEADER", "", "PRAGMA foreign_keys=ON;", ""];

for (const { type, sql } of rows) {
  let statement = sql.trim();

  if (type === "table") {
    statement = statement.replace(/^CREATE TABLE "/, 'CREATE TABLE IF NOT EXISTS "');
  } else if (type === "index" && !/IF NOT EXISTS/i.test(statement)) {
    statement = statement.replace(
      /^CREATE (UNIQUE )?INDEX /,
      (_match, unique) => `CREATE ${unique ?? ""}INDEX IF NOT EXISTS `,
    );
  }

  freshLines.push(statement + ";");
  freshLines.push("");
}

db.close();
rmSync(tmpDir, { recursive: true, force: true });

const freshSql = freshLines.join("\n");

// ---------------------------------------------------------------------------
// 3. Load the checked-in schema.sql
// ---------------------------------------------------------------------------
const schemaPath = resolve(packageDir, "prisma", "schema.sql");
let committedSql;
try {
  committedSql = readFileSync(schemaPath, "utf-8");
} catch {
  console.error(`schema.sql not found at ${schemaPath}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 4. Compare (normalise to strip header comments that legitimately differ)
// ---------------------------------------------------------------------------
function normalise(sql) {
  return sql
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      return (
        !trimmed.startsWith("--") && // skip comment lines
        !trimmed.startsWith("PRAGMA journal_mode=") && // WAL pragma is optional
        trimmed.length > 0
      );
    })
    .join("\n");
}

const freshNorm = normalise(freshSql);
const committedNorm = normalise(committedSql);

if (freshNorm !== committedNorm) {
  console.error(
    "╔══════════════════════════════════════════════════════════════════╗",
  );
  console.error(
    "║  SCHEMA DRIFT DETECTED                                         ║",
  );
  console.error(
    "╠══════════════════════════════════════════════════════════════════╣",
  );
  console.error(
    "║  prisma/schema.sql is out of date with the Prisma schema.       ║",
  );
  console.error(
    "║                                                                ║",
  );
  console.error(
    "║  Run the following and commit the result:                      ║",
  );
  console.error(
    "║    cd packages/api && node scripts/export-schema.mjs           ║",
  );
  console.error(
    "╚══════════════════════════════════════════════════════════════════╝",
  );

  // Provide a meaningful diff for the CI log
  if (freshNorm.length !== committedNorm.length) {
    console.error(
      `\nLength mismatch: fresh=${freshNorm.length} committed=${committedNorm.length}`,
    );
  }

  // Find first differing line
  const fLines = freshNorm.split("\n");
  const cLines = committedNorm.split("\n");
  const maxLen = Math.max(fLines.length, cLines.length);
  for (let i = 0; i < maxLen; i++) {
    if (fLines[i] !== cLines[i]) {
      console.error(
        `\nFirst difference at DDL line ${i + 1}:`,
      );
      console.error(`  Fresh (expected):     ${fLines[i] ?? "(missing)"}`);
      console.error(`  Committed (actual):    ${cLines[i] ?? "(missing)"}`);
      break;
    }
  }

  process.exit(1);
}

console.log("✅ schema.sql is up-to-date with the Prisma schema.");
