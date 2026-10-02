import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

/**
 * Finance/custody acceptance config.
 *
 * Requires Docker (fresh Postgres 18 + Redis 8 images), Foundry (`anvil`) and a
 * built `packages/custody/contracts/out`. Start with:
 *   npm run contracts:build -w @pokertools/custody
 *   vitest run --config vitest.finance.config.ts
 *
 * The global setup generates a PRIVATE PostgreSQL-provider Prisma client under
 * `packages/e2e/.runtime/finance-generated/prisma`. The `resolveId` plugin
 * redirects the workspace-relative `generated/prisma` import used by both the
 * API and custody sources to that client, so the shared SQLite build output is
 * never regenerated or clobbered by concurrent SQLite test runs.
 */
const privatePrismaEntry = resolve(
  import.meta.dirname,
  ".runtime/finance-generated/prisma/index.js"
);

function financePrismaRedirect() {
  return {
    name: "finance-prisma-redirect",
    enforce: "pre" as const,
    resolveId(id: string) {
      if (/generated[\\/]prisma[\\/]index\.js$/.test(id)) return privatePrismaEntry;
      return null;
    },
  };
}

export default defineConfig({
  plugins: [financePrismaRedirect()],
  test: {
    globals: true,
    environment: "node",
    include: ["tests/finance/**/*.test.ts"],
    globalSetup: ["tests/finance/global-setup.ts"],
    setupFiles: ["tests/finance/helpers/setup-env.ts"],
    testTimeout: 180_000,
    hookTimeout: 180_000,
    pool: "forks",
    maxWorkers: 1,
    fileParallelism: false,
    isolate: true,
    sequence: { concurrent: false },
  },
});
