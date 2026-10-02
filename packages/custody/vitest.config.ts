import { defineConfig } from "vitest/config";
import { config } from "dotenv";
import { resolve } from "path";

config({ path: resolve(import.meta.dirname, ".env.test"), quiet: true });

const dbPath = resolve(import.meta.dirname, "../api/.runtime/test.db");
process.env.DATABASE_URL = `file:${dbPath}`;

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    testTimeout: 120000,
    hookTimeout: 60000,
    // ✅ Simple sequential execution
    pool: "forks",
    maxConcurrency: 1,
    sequence: {
      concurrent: false,
    },
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "html"],
      reportOnFailure: true,
      include: ["src/**/*.ts"],
      exclude: ["node_modules/", "dist/", "tests/", "**/*.test.ts", "**/*.config.ts"],
      thresholds: {
        statements: 66,
        branches: 60,
        functions: 66,
        lines: 70,
        "src/core/withdrawal-workflow.ts": {
          statements: 75,
          branches: 73,
          functions: 95,
          lines: 77,
        },
      },
    },
  },
});
