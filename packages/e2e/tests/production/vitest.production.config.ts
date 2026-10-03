import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

/**
 * Production-container acceptance config.
 *
 * Runs the real production Docker image inside the real
 * `docker-compose.prod.yml` topology (api/worker/custody/postgres/redis) with a
 * disposable compose project and test-only overrides generated outside the
 * repository. Start with:
 *
 *   scripts/run-production-acceptance.sh
 *
 * The suite is sequential and single-worker: it mutates one shared disposable
 * database and one isolated Anvil chain, and it must not run concurrently with
 * other SQLite/PostgreSQL suites.
 */
export default defineConfig({
  root: resolve(import.meta.dirname, "../.."),
  test: {
    globals: true,
    environment: "node",
    include: ["tests/production/**/*.test.ts"],
    globalSetup: ["tests/production/global-setup.ts"],
    testTimeout: 300_000,
    hookTimeout: 600_000,
    pool: "forks",
    maxWorkers: 1,
    fileParallelism: false,
    isolate: true,
    sequence: { concurrent: false },
  },
});
