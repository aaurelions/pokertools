import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

/**
 * Standalone config for the canonical PostgreSQL + Redis acceptance suite.
 *
 * Run from `packages/api`:
 *   npx vitest run --config tests/acceptance/canonical/vitest.acceptance.config.ts
 *
 * The global setup generates a PRIVATE PostgreSQL-provider Prisma client under
 * `.runtime/generated/prisma`. This `resolveId` plugin redirects the API's
 * workspace-relative `generated/prisma` import to that client, so the shared
 * SQLite build output is never regenerated or clobbered by concurrent runs.
 */
const privatePrisma = resolve(import.meta.dirname, "../../../.runtime/generated/prisma/index.js");

function canonicalPrismaRedirect() {
  return {
    name: "canonical-prisma-redirect",
    enforce: "pre" as const,
    resolveId(id: string) {
      if (/generated\/prisma\/index\.js$/.test(id)) return privatePrisma;
      return null;
    },
  };
}

export default defineConfig({
  plugins: [canonicalPrismaRedirect()],
  test: {
    globals: true,
    environment: "node",
    include: ["tests/acceptance/canonical/**/*.acceptance.test.ts"],
    globalSetup: ["tests/acceptance/canonical/global-setup.ts"],
    setupFiles: ["tests/acceptance/canonical/setup-env.ts"],
    testTimeout: 120_000,
    hookTimeout: 180_000,
    pool: "forks",
    maxWorkers: 1,
    fileParallelism: false,
    isolate: true,
    reporters: ["default"],
  },
});
