/// <reference path="../../types/fastify.d.ts" />
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { HealthResponseSchema } from "@pokertools/types";
import { buildApp } from "../../src/app.js";
import { bundleHarness, loadPlaywright, startAssetServer } from "./browser/harness-helpers.js";

/**
 * Real-browser acceptance for the built SDK package root.
 *
 * This intentionally targets the published/built `@pokertools/sdk` (the bundle
 * resolved by esbuild includes `packages/sdk/dist/index.js`, asserted below),
 * drives it from a real headless Chromium page, and exercises the loopback API
 * through public SDK/HTTP contracts only. It never touches SDK internals.
 *
 * The canonical `GET /tables/:id/observation` + strict `POST action`
 * (`{requestId,turnId,expectedVersion,actionId,amount?}`) contract is
 * exercised end to end. Missing dependencies, blocked gameplay or unavailable
 * observation/action contracts fail acceptance rather than silently skipping.
 */

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));

const playwright = loadPlaywright();
const hasEsbuild = (() => {
  try {
    require.resolve("esbuild");
    return true;
  } catch {
    return false;
  }
})();

const browserUnavailableReason = !playwright
  ? "Playwright (Node) is not resolvable from the project or npx cache."
  : !hasEsbuild
    ? "esbuild is not resolvable (needed to bundle the built SDK for the browser)."
    : null;

if (browserUnavailableReason) {
  throw new Error(
    `[browser-sdk-acceptance] BLOCKED: ${browserUnavailableReason} ` +
      "Install the declared dependencies and Chromium before acceptance. " +
      "Set POKERTOOLS_PLAYWRIGHT_MODULE=<path-to-playwright-package> to override."
  );
}

describe("built SDK in a real browser (loopback API)", () => {
  it("runs wallet auth, REST/WS gameplay, masking, live updates, reconnect resync and probes canonical observation/action", async () => {
    const app = await buildApp();
    const baseUrl = await app.listen({ host: "127.0.0.1", port: 0 });
    const result = await (async () => {
      const html = await import("node:fs/promises").then((fs) =>
        fs.readFile(join(here, "browser", "harness.html"), "utf8")
      );
      const bundle = await bundleHarness(join(here, "browser", "harness-entry.ts"));
      // The bundle must be built from the built SDK package root (dist), not source.
      const sdkInputs = bundle.inputs.filter((input) => /sdk\/dist\/index\.js$/.test(input));
      if (sdkInputs.length === 0) {
        console.warn(
          `[browser-sdk-acceptance] SDK dist not found in bundle inputs:\n${bundle.inputs
            .filter((input) => input.includes("pokertools"))
            .join("\n")}`
        );
      }
      expect(sdkInputs.length).toBeGreaterThan(0);

      const server = await startAssetServer({
        "/index.html": { body: html, contentType: "text/html; charset=utf-8" },
        "/harness.js": { body: bundle.code, contentType: "text/javascript; charset=utf-8" },
      });

      const browser = await playwright!.chromium.launch({ headless: true });
      const consoleLogs: string[] = [];
      const pageErrors: string[] = [];
      try {
        const page = await browser.newPage();
        page.on("console", (message: { type(): string; text(): string }) => {
          consoleLogs.push(`[${message.type()}] ${message.text()}`);
        });
        page.on("pageerror", (error: Error) => pageErrors.push(String(error)));

        await page.goto(server.url, { waitUntil: "domcontentloaded" });
        await page.waitForFunction(
          () =>
            Boolean(
              (window as { __POKER_BROWSER_ACCEPTANCE__?: unknown }).__POKER_BROWSER_ACCEPTANCE__
            ),
          undefined,
          { timeout: 30_000 }
        );

        type BrowserResult = {
          error?: string;
          steps: Record<string, any>;
          cleanup: { userIds: string[]; tableId: string | null };
        };

        // Phase 1: wallet auth + table creation in the browser.
        const prepared = (await page.evaluate(
          (url: string) =>
            (
              window as unknown as {
                __POKER_BROWSER_ACCEPTANCE__: {
                  prepare(options: { baseUrl: string }): Promise<Record<string, unknown>>;
                };
              }
            ).__POKER_BROWSER_ACCEPTANCE__.prepare({ baseUrl: url }),
          baseUrl
        )) as BrowserResult;

        // Fixture grant: fund the ephemeral principals through the canonical
        // chip ledger so gameplay is possible without a test-only faucet.
        const operator = await app.prisma.user.findUnique({
          where: { username: "HOUSE" },
          select: { id: true },
        });
        if (!operator) throw new Error("HOUSE operator account is required for chip grants");
        for (const userId of prepared.cleanup.userIds) {
          await app.financialManager.grantChips(userId, 10_000, {
            reason: "browser-sdk-acceptance fixture",
            operatorId: operator.id,
            idempotencyKey: `browser-grant-${userId}-${Date.now()}`,
          });
        }

        // Phase 2: funded gameplay, WS live updates, resync, canonical probe.
        const played = (await page.evaluate(() =>
          (
            window as unknown as {
              __POKER_BROWSER_ACCEPTANCE__: {
                play(): Promise<Record<string, unknown>>;
              };
            }
          ).__POKER_BROWSER_ACCEPTANCE__.play()
        )) as BrowserResult;

        const outcome: BrowserResult = {
          steps: { ...prepared.steps, ...played.steps },
          cleanup: prepared.cleanup,
        };
        if (played.steps.error) {
          throw new Error(`browser harness error: ${played.steps.error}`);
        }
        expect(pageErrors).toEqual([]);

        const steps = outcome.steps;
        // Wallet auth SIWE boundary.
        expect(steps.siwe.wrongSignerStatus).toBe(401);
        expect(steps.siwe.replayStatus).toBe(401);
        expect(steps.siwe.unauthenticatedRestStatus).toBe(401);
        expect(typeof steps.siwe.loginUserId).toBe("string");
        expect(steps.auth.players).toBe(2);

        // Authenticated REST against the built SDK.
        expect(HealthResponseSchema.safeParse(steps.healthBody).success).toBe(true);
        expect(steps.rest.tableCreated).toBe(true);
        expect(steps.rest.listed).toBe(true);

        // WS join + masked snapshot is always available.
        expect(steps.wsJoin.connected).toBe(true);
        expect(steps.wsJoin.deckEmpty).toBe(true);
        expect(steps.wsJoin.previousStatesEmpty).toBe(true);

        if (steps.blocked) {
          throw new Error(
            `[browser-sdk-acceptance] gameplay action path BLOCKED at ${steps.blocked.at}: ` +
              `${steps.blocked.detail}`
          );
        } else {
          // Post-deal masked observation (engine view + canonical wire state).
          expect(steps.masking.engine.deckEmpty).toBe(true);
          expect(steps.masking.engine.previousStatesEmpty).toBe(true);
          expect(steps.masking.engine.nonViewerHandsMasked).toBe(true);
          expect(steps.masking.observation.deckEmpty).toBe(true);
          expect(steps.masking.observation.previousStatesEmpty).toBe(true);
          expect(steps.masking.observation.nonViewerHandsMasked).toBe(true);

          // Action live update over the authenticated socket.
          expect(Number.isInteger(steps.liveUpdate.actorIndex)).toBe(true);
          expect(steps.liveUpdate.actorIndex).toBeGreaterThanOrEqual(0);
          expect(steps.liveUpdate.pushedVersion).toBeGreaterThanOrEqual(
            steps.liveUpdate.actionVersion
          );

          // Disconnect / reconnect / resync.
          expect(steps.reconnectResync.disconnectedWhileAway).toBe(true);
          expect(steps.reconnectResync.versionsMatch).toBe(true);
          expect(steps.reconnectResync.deckEmpty).toBe(true);
          expect(steps.reconnectResync.previousStatesEmpty).toBe(true);
        }

        // Canonical turn/observation/action contract (feature-probed).
        const canonical = steps.canonical;
        if (canonical.status === "BLOCKED") {
          throw new Error(
            `[browser-sdk-acceptance] canonical observation/action BLOCKED: ` +
              `${canonical.reason} (httpStatus=${canonical.httpStatus ?? "n/a"})`
          );
        } else if (canonical.status === "READY") {
          expect(canonical.observationStatus).toBe(200);
          expect(canonical.submitStatus).toBeGreaterThanOrEqual(200);
          expect(canonical.submitStatus).toBeLessThan(300);
          expect(canonical.receiptValid).toBe(true);
          expect(canonical.turnObserved).toBe(true);
          expect(canonical.legalActionFamilies.length).toBeGreaterThan(0);
          expect(canonical.spoofStatus).toBe(400);
          expect([400, 409]).toContain(canonical.staleStatus);
          expect(canonical.replayIdempotent).toBe(true);
        } else {
          throw new Error(`canonical contract failed: ${JSON.stringify(canonical)}`);
        }

        process.stdout.write(
          `\nBROWSER_SDK_ACCEPTANCE=PASS chromium=${playwright!.version} from=${playwright!.resolvedFrom}\n` +
            `  canonical=${canonical.status} wireShape=${canonical.wireShape ?? "n/a"}` +
            ` legalActions=[${canonical.legalActionFamilies?.join(",") ?? ""}]` +
            ` spoof=${canonical.spoofStatus ?? "n/a"} stale=${canonical.staleStatus ?? "n/a"}` +
            ` replayIdempotent=${canonical.replayIdempotent ?? "n/a"}\n` +
            `  gameplay=${steps.blocked ? `blocked(${steps.blocked.detail})` : "verified"}\n` +
            `  dealSdkFallback=${steps.deal?.sdkError ? "yes" : "no"} foldSdkFallback=${
              steps.liveUpdate?.sdkError ? "yes" : "no"
            }\n`
        );
        return outcome;
      } finally {
        await browser.close();
        await server.close();
      }
    })();

    // Fresh-infra cleanup: remove this run's disposable rows and cached state.
    const tableId = result.cleanup.tableId;
    if (tableId) {
      await app.prisma.handHistory.deleteMany({ where: { tableId } });
      await app.prisma.table.deleteMany({ where: { id: tableId } });
      await app.redis.del(`table:${tableId}`);
    }
    for (const userId of result.cleanup.userIds) {
      await app.prisma.session.deleteMany({ where: { userId } });
      // Canonical chip journal/accounts are keyed by principal, no User FK.
      await app.prisma.chipLedgerEntry.deleteMany({
        where: { account: { principalId: userId } },
      });
      await app.prisma.chipGrant.deleteMany({ where: { principalId: userId } });
      await app.prisma.chipAccount.deleteMany({ where: { principalId: userId } });
      await app.prisma.user.deleteMany({ where: { id: userId } });
    }
    await app.close();
  }, 180_000);
});
