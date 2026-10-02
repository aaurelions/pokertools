#!/usr/bin/env node
/**
 * Reproducible runner for the built-SDK browser acceptance test.
 *
 * Drives the API package's vitest harness (setup env, Redis flush, HOUSE seed) filtered to
 * the browser acceptance file. Run from anywhere:
 *
 *   node packages/api/tests/loopback/browser/run.mjs
 *
 * Playwright and esbuild are declared devDependencies. Install Chromium with
 * `npx playwright install chromium` before acceptance.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const apiDir = resolve(here, "../../..");
const vitestCli = resolve(apiDir, "../../node_modules/vitest/vitest.mjs");

if (!existsSync(vitestCli)) {
  console.error(`[browser-acceptance] vitest CLI not found at ${vitestCli}`);
  process.exit(2);
}

const env = {
  ...process.env,
  NODE_ENV: "test",
  POKERTOOLS_LOOPBACK_TEST: "true",
  ENABLE_TEST_ROUTES: "true",
};

if (!process.argv.includes("--no-ensure-db")) {
  const ensure = spawnSync("bash", ["scripts/ensure-db.sh"], {
    cwd: apiDir,
    env,
    stdio: "inherit",
  });
  if (ensure.status !== 0) {
    console.error("[browser-acceptance] database/Redis ensure step failed");
    process.exit(ensure.status ?? 1);
  }
}

// The canonical (PostgreSQL) acceptance suite regenerates the shared Prisma
// client against the postgres provider. The loopback suite uses the sqlite
// adapter, so regenerate immediately before running to avoid a stale/foreign
// generated client. This is generated code, not a source change.
if (!process.argv.includes("--no-prisma-generate")) {
  const prismaBin = resolve(apiDir, "../../node_modules/.bin/prisma");
  const generate = spawnSync(prismaBin, ["generate"], { cwd: apiDir, env, stdio: "inherit" });
  if (generate.status !== 0) {
    console.error("[browser-acceptance] prisma generate (sqlite) failed");
    process.exit(generate.status ?? 1);
  }
}

const run = spawnSync(
  process.execPath,
  [
    vitestCli,
    "run",
    "--config",
    "vitest.config.ts",
    "tests/loopback/browser-sdk-acceptance.test.ts",
  ],
  { cwd: apiDir, env, stdio: "inherit" }
);

process.exit(run.status ?? 1);
