import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "jsdom",
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "html"],
      reportOnFailure: true,
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["node_modules/", "dist/", "tests/"],
      thresholds: {
        statements: 81,
        branches: 77,
        functions: 83,
        lines: 81,
      },
    },
  },
});
