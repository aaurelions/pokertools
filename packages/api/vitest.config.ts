import { defineConfig } from "vitest/config";
import { config } from "dotenv";
import { resolve } from "path";

// Load test environment variables
if (process.env.NODE_ENV === "test") {
  config({ path: resolve(import.meta.dirname, ".env.test"), quiet: true });
  process.env.ENABLE_TEST_ROUTES = "true";
}

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include:
      process.env.POKERTOOLS_LOOPBACK_TEST === "true"
        ? ["tests/loopback/**/*.test.ts"]
        : ["tests/{integration,unit}/**/*.test.ts"],
    testTimeout: 30000, // Increased for long-running tests
    hookTimeout: 30000,
    setupFiles: ["./tests/setup.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "html"],
      reportOnFailure: true,
      include: ["src/**/*.ts"],
      exclude: [
        "node_modules/",
        "dist/",
        "generated/",
        "coverage/",
        "tests/",
        "**/*.test.ts",
        "**/*.config.ts",
      ],
      thresholds: {
        statements: 75,
        branches: 65,
        functions: 77,
        lines: 77,
        "src/services/atomic-ledger.ts": {
          statements: 84,
          branches: 77,
          functions: 86,
          lines: 85,
        },
      },
    },
    // Run tests sequentially to avoid Redis/DB/Redlock conflicts
    pool: "forks",
    maxWorkers: 1,
    // Ensure tests run one file at a time
    fileParallelism: false,
    // Isolate each test file
    isolate: true,
  },
});
