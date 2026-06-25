/**
 * generate-prisma-for-prepare.js
 *
 * Runs `prisma generate` for the npm prepare (install) lifecycle.
 *
 * When DATABASE_URL is already set in the environment (developer machine
 * or CI with secrets configured), it runs Prisma normally — all validation
 * in prisma.config.ts stays fully in effect.
 *
 * When DATABASE_URL is unset or empty (e.g. a CI runner without a database),
 * it supplies a harmless local SQLite URL so that the Prisma client can be
 * generated during `npm ci` / `npm install`. The database file never
 * leaves .runtime/ (which is gitignored) and the generated client is
 * identical regardless of the datasource URL.
 *
 * This script exists solely for the prepare lifecycle. Normal developer
 * and operator workflows should use `db:generate` (`prisma generate`)
 * directly, which requires DATABASE_URL.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageDir = resolve(__dirname, "..");

// Only inject a fallback when DATABASE_URL is unavailable for Prisma config.
if (!process.env.DATABASE_URL) {
  const runtimeDir = resolve(packageDir, ".runtime");
  mkdirSync(runtimeDir, { recursive: true });
  process.env.DATABASE_URL = `file:${resolve(runtimeDir, "prisma-generate.db")}`;
}

const result = spawnSync("prisma", ["generate"], {
  cwd: packageDir,
  stdio: "inherit",
  shell: process.platform === "win32",
  env: { ...process.env },
});

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 1);
