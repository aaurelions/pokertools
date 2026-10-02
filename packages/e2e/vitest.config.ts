import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    // The Docker suite is the single-chain, SQLite smoke path. The canonical
    // two-chain finance/custody acceptance is a separate suite run with
    // `vitest.finance.config.ts`; it must not be picked up here.
    include: ["tests/*.test.ts"],
    testTimeout: 300000, // 5 minutes for Docker E2E
    hookTimeout: 120000, // 2 minutes for setup/teardown
    pool: "forks",
    maxConcurrency: 1,
    sequence: {
      concurrent: false,
    },
  },
});
