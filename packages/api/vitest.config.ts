import { defineConfig } from "vitest/config";
import { config } from "dotenv";
import { resolve } from "path";

// Load test environment variables
if (process.env.NODE_ENV === "test") {
  config({ path: resolve(__dirname, ".env.test") });
}

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    testTimeout: 30000, // Increased for long-running tests
    hookTimeout: 30000,
    setupFiles: ["./tests/setup.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      exclude: ["node_modules/", "dist/", "generated/", "tests/", "**/*.test.ts", "**/*.config.ts"],
    },
    // Run tests sequentially to avoid Redis/DB/Redlock conflicts
    pool: "forks",
    poolOptions: {
      forks: {
        singleFork: true, // Run all tests in a single process sequentially
      },
    },
    // Ensure tests run one file at a time
    fileParallelism: false,
    // Isolate each test file
    isolate: true,
  },
});
