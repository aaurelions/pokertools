import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";

const exec = promisify(execFile);
const image =
  process.env.POKERTOOLS_PRODUCTION_IMAGE ?? "ghcr.io/aaurelions/pokertools:production-acceptance";

async function docker(args) {
  try {
    return await exec("docker", args, { timeout: 120_000 });
  } catch {
    // Docker's command error includes arguments, which can contain credentials.
    throw new Error(`Docker ${args[0]} failed`);
  }
}

/** Poll observed state, not a guessed startup/cache delay. */
async function eventually(probe, timeoutMs = 30_000) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    try {
      const value = await probe();
      if (value) return value;
    } catch {
      // An unavailable dependency is expected during startup; retries are bounded.
    }
    await delay(250);
  }
  throw new Error("Expected production state was not observed before deadline");
}

test(
  "fresh production image admits only safe configuration and current readiness",
  { timeout: 180_000 },
  async () => {
    const prefix = `pt-admission-${randomUUID().slice(0, 8)}`;
    const network = `${prefix}-net`;
    const db = `${prefix}-db`;
    const redis = `${prefix}-redis`;
    const api = `${prefix}-api`;
    const password = randomBytes(24).toString("hex");
    const secret = randomBytes(32).toString("hex");
    const containers = [];
    await docker(["network", "create", network]);
    try {
      await docker([
        "run",
        "--rm",
        "-d",
        "--network",
        network,
        "--name",
        db,
        "-e",
        `POSTGRES_PASSWORD=${password}`,
        "-e",
        "POSTGRES_DB=pokertools",
        "postgres:18-alpine",
      ]);
      containers.push(db);
      await docker(["run", "--rm", "-d", "--network", network, "--name", redis, "redis:8-alpine"]);
      containers.push(redis);
      await eventually(async () => {
        await docker(["exec", db, "pg_isready", "-U", "postgres", "-d", "pokertools"]);
        return true;
      });

      // The image's compiled gate refuses public key material and test routes.
      // This check does not rely on a test-only buildApp injection.
      const checks = `
      import assert from 'node:assert/strict';
      import { assertPublicProcessSafety } from '/app/packages/api/dist/safety.js';
      const env = { NODE_ENV: 'production', DATABASE_URL: 'postgresql://unused',
        REDIS_URL: 'redis://unused', JWT_SECRET: 'j'.repeat(48),
        COOKIE_SECRET: 'c'.repeat(48), CORS_ORIGIN: 'https://example.com' };
      assert.doesNotThrow(() => assertPublicProcessSafety(env));
      assert.throws(() => assertPublicProcessSafety({...env, TREASURY_SIGNING_KEYS_JSON: '{}'}), /CUSTODY_SECRET_IN_PUBLIC_PROCESS/);
      assert.throws(() => assertPublicProcessSafety({...env, ENABLE_TEST_ROUTES: 'true'}), /TEST_ROUTES_NOT_ALLOWED_IN_PRODUCTION/);
      assert.throws(() => assertPublicProcessSafety({...env, DATABASE_URL: 'file:test.db'}), /PRODUCTION_REQUIRES_POSTGRESQL/);
    `;
      await docker([
        "run",
        "--rm",
        "--network",
        "none",
        "--entrypoint",
        "node",
        image,
        "--input-type=module",
        "-e",
        checks,
      ]);

      // Also exercise the actual entrypoint, not only an imported gate. These
      // cases must exit before migration/network access, even with no network.
      for (const [name, value, code] of [
        ["ENABLE_TEST_ROUTES", "true", "TEST_ROUTES_NOT_ALLOWED_IN_PRODUCTION"],
        ["DATABASE_URL", "file:test.db", "PRODUCTION_REQUIRES_POSTGRESQL"],
        ...[
          "WALLET_XPRIV_ENCRYPTION_SECRET",
          "WALLET_XPRIV_ENCRYPTION_SECRET_FILE",
          "MASTER_MNEMONIC",
          "MASTER_MNEMONIC_FILE",
          "TREASURY_PRIVATE_KEY",
          "TREASURY_PRIVATE_KEY_FILE",
          "TREASURY_MNEMONIC",
          "TREASURY_XPRIV",
          "TREASURY_SIGNING_KEYS_JSON",
          "TREASURY_SIGNING_KEYS_JSON_FILE",
        ].map((name) => [name, "unsafe-test-material", "CUSTODY_SECRET_IN_PUBLIC_PROCESS"]),
      ]) {
        let rejected = false;
        try {
          await exec(
            "docker",
            [
              "run",
              "--rm",
              "--network",
              "none",
              "-e",
              "NODE_ENV=production",
              "-e",
              "DATABASE_URL=postgresql://unused",
              "-e",
              "REDIS_URL=redis://unused",
              "-e",
              `JWT_SECRET=${secret}`,
              "-e",
              `COOKIE_SECRET=${secret}`,
              "-e",
              "CORS_ORIGIN=https://example.com",
              "-e",
              `${name}=${value}`,
              image,
            ],
            { timeout: 15_000 }
          );
        } catch (error) {
          rejected = typeof error.stderr === "string" && error.stderr.includes(code);
        }
        assert(rejected, `Image entrypoint did not reject ${name} with ${code}`);
      }

      await docker([
        "run",
        "--rm",
        "-d",
        "--network",
        network,
        "--name",
        api,
        "-p",
        "127.0.0.1::3000",
        "-e",
        "NODE_ENV=production",
        "-e",
        "LOG_LEVEL=error",
        "-e",
        `DATABASE_URL=postgresql://postgres:${password}@${db}:5432/pokertools`,
        "-e",
        `REDIS_URL=redis://${redis}:6379`,
        "-e",
        `JWT_SECRET=${secret}`,
        "-e",
        `COOKIE_SECRET=${randomBytes(32).toString("hex")}`,
        "-e",
        "CORS_ORIGIN=https://example.com",
        image,
      ]);
      containers.push(api);
      const { stdout } = await docker(["port", api, "3000/tcp"]);
      const port = Number(stdout.trim().split(":").at(-1));
      assert(Number.isSafeInteger(port) && port > 0);
      const base = `http://127.0.0.1:${port}`;
      await eventually(async () => {
        const response = await fetch(`${base}/ready`, { signal: AbortSignal.timeout(2_000) });
        const body = await response.json();
        return response.status === 200 && body.status === "ready";
      });
      assert.equal((await fetch(`${base}/health`)).status, 200);
      assert.equal((await fetch(`${base}/metrics`)).status, 404);

      // No financial assets are implicitly seeded. An empty installation is a
      // safe non-financial room; funded-asset admission is proved by finance E2E.
      const { stdout: assetCount } = await docker([
        "exec",
        db,
        "psql",
        "-U",
        "postgres",
        "-d",
        "pokertools",
        "-Atc",
        'SELECT COUNT(*) FROM "Asset"',
      ]);
      assert.equal(assetCount.trim(), "0");

      await docker([
        "exec",
        db,
        "psql",
        "-U",
        "postgres",
        "-d",
        "pokertools",
        "-c",
        `UPDATE "_migrations" SET "sha256" = repeat('0', 64) WHERE "name" = '001_initial_schema'`,
      ]);
      const blocked = await eventually(async () => {
        const response = await fetch(`${base}/ready`, { signal: AbortSignal.timeout(2_000) });
        const body = await response.json();
        return response.status === 503 ? body : null;
      });
      assert.equal(blocked.status, "not_ready");
      assert(blocked.checks.some((check) => check.detail === "MIGRATION_APPLIED_DRIFT"));
      assert.equal((await fetch(`${base}/health`)).status, 200);
    } finally {
      // An exited --rm container may already be absent. Still clean every peer.
      await Promise.allSettled(
        containers.reverse().map((container) => docker(["rm", "-f", container]))
      );
      await docker(["network", "rm", network]);
    }
  }
);
