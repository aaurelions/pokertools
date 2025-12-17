import { defineConfig } from "vitest/config";
import { config } from "dotenv";
import { resolve } from "path";

config({ path: resolve(__dirname, ".env.test") });

const dbPath = resolve(__dirname, "../api/.runtime/test.db");
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
  },
});
