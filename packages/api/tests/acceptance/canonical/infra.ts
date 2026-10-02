/**
 * Canonical acceptance infrastructure.
 *
 * Provisions a REAL disposable PostgreSQL and a REAL Redis for the canonical
 * acceptance suite. Nothing here touches the shared `.env.test` SQLite database
 * or the developer Redis on port 6379.
 *
 * PostgreSQL is provisioned with the pre-pulled `postgres:18-alpine` image. The
 * Prisma client is regenerated against a PostgreSQL-provider copy of the build
 * schema (see `prisma.config.ts`, which already switches provider from
 * DATABASE_URL) and emitted to `.runtime/generated/prisma`. The acceptance
 * Vitest config aliases the API's `generated/prisma` import to that client so
 * shared source is never edited.
 *
 * Redis may be a local `redis-server` binary or the `redis:8-alpine` image; the
 * suite exposes a stop/start command so recovery tests can kill and restart it.
 */

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";
import { Redis } from "ioredis";

const exec = promisify(execFile);

export const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
export const RUNTIME_DIR = resolve(PACKAGE_DIR, ".runtime");
export const ACCEPTANCE_DIR = resolve(RUNTIME_DIR, "acceptance");
export const ENV_FILE = resolve(ACCEPTANCE_DIR, "env.json");
export const TEMP_SCHEMA_DIR = resolve(RUNTIME_DIR, "acceptance-schema");
export const TEMP_SCHEMA_PATH = resolve(TEMP_SCHEMA_DIR, "schema.prisma");
/** Private PostgreSQL client; never the shared `generated/prisma` output. */
export const GENERATED_DIR = resolve(RUNTIME_DIR, "generated", "prisma");
export const GENERATED_ENTRY = resolve(GENERATED_DIR, "index.js");

export interface AcceptanceEnv {
  databaseUrl: string;
  redisUrl: string;
  redisPort: number;
  /** argv used to (re)start the dedicated Redis process. */
  redisArgs: string[];
  redisBinary: string;
  useDockerRedis: boolean;
  pgContainer: string;
  redisContainer?: string;
}

interface DockerPort {
  host: string;
  port: number;
}

async function docker(args: string[], timeout = 60_000): Promise<string> {
  const { stdout } = await exec("docker", args, { timeout, maxBuffer: 10 * 1024 * 1024 });
  return stdout.trim();
}

function parseDockerPort(output: string): DockerPort {
  const line = output.trim().split("\n")[0] ?? "";
  const portPart = line.split(":").pop() ?? "";
  const port = Number(portPart);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`Could not parse docker port from: ${output}`);
  }
  return { host: "127.0.0.1", port };
}

async function waitForPort(host: string, port: number, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const socket = await import("node:net").then(
        (net) =>
          new Promise<void>((resolveSocket, rejectSocket) => {
            const client = net.createConnection({ host, port });
            client.once("connect", () => {
              client.destroy();
              resolveSocket();
            });
            client.once("error", rejectSocket);
          })
      );
      void socket;
      return;
    } catch {
      await delay(250);
    }
  }
  throw new Error(`Port ${host}:${port} did not become ready`);
}

async function waitForPostgres(databaseUrl: string, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 1,
    connectionTimeoutMillis: 1000,
  });
  try {
    while (Date.now() < deadline) {
      try {
        await pool.query("SELECT 1");
        return;
      } catch {
        await delay(300);
      }
    }
    throw new Error("PostgreSQL did not become ready");
  } finally {
    await pool.end();
  }
}

async function commandExists(binary: string): Promise<boolean> {
  try {
    await exec(binary, ["--version"], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

async function pickFreePort(start: number, end: number): Promise<number> {
  const net = await import("node:net");
  for (let port = start; port <= end; port++) {
    const free = await new Promise<boolean>((resolveFree) => {
      const server = net.createServer();
      server.once("error", () => resolveFree(false));
      server.once("listening", () => {
        server.close(() => resolveFree(true));
      });
      server.listen(port, "127.0.0.1");
    });
    if (free) return port;
  }
  throw new Error(`No free port in ${start}-${end}`);
}

async function startDockerRedis(port: number): Promise<string> {
  const name = `pk-accept-redis-${process.pid}-${Date.now()}`;
  await docker([
    "run",
    "--rm",
    "-d",
    "--name",
    name,
    "-p",
    `127.0.0.1:${port}:6379`,
    "redis:8-alpine",
  ]);
  await waitForPort("127.0.0.1", port, 30_000);
  return name;
}

/**
 * Start a dedicated Redis for the acceptance run. Prefers the local binary so
 * recovery tests can kill/restart it cheaply; falls back to Docker.
 */
export async function startRedis(): Promise<{
  env: Pick<
    AcceptanceEnv,
    "redisUrl" | "redisPort" | "redisArgs" | "redisBinary" | "useDockerRedis" | "redisContainer"
  >;
  stop: () => Promise<void>;
}> {
  const port = await pickFreePort(21000, 24000);
  const useLocal = await commandExists("redis-server");
  if (useLocal) {
    const args = [
      "--port",
      String(port),
      "--save",
      "",
      "--appendonly",
      "no",
      "--bind",
      "127.0.0.1",
    ];
    const child = spawn("redis-server", args, { stdio: "ignore", detached: true });
    child.unref();
    await waitForPort("127.0.0.1", port, 30_000);
    return {
      env: {
        redisUrl: `redis://127.0.0.1:${port}`,
        redisPort: port,
        redisArgs: args,
        redisBinary: "redis-server",
        useDockerRedis: false,
      },
      stop: async () => {
        // Kill by port so an orphaned detached child is still cleaned up.
        await exec("sh", ["-c", `lsof -tiTCP:${port} -sTCP:LISTEN | xargs -r kill`]).catch(
          () => undefined
        );
      },
    };
  }

  const container = await startDockerRedis(port);
  return {
    env: {
      redisUrl: `redis://127.0.0.1:${port}`,
      redisPort: port,
      redisArgs: [],
      redisBinary: "docker",
      useDockerRedis: true,
      redisContainer: container,
    },
    stop: async () => {
      await docker(["rm", "-f", container]).catch(() => undefined);
    },
  };
}

/** Restart the Redis process described by an acceptance env (recovery tests). */
export async function restartRedis(env: AcceptanceEnv): Promise<void> {
  if (env.useDockerRedis && env.redisContainer) {
    await docker(["restart", env.redisContainer]).catch(() => undefined);
    await waitForPort("127.0.0.1", env.redisPort, 30_000);
    return;
  }
  const child = spawn(env.redisBinary, env.redisArgs, { stdio: "ignore", detached: true });
  child.unref();
  await waitForPort("127.0.0.1", env.redisPort, 30_000);
}

/** Hard-kill Redis without restarting it. */
export async function killRedis(env: AcceptanceEnv): Promise<void> {
  if (env.useDockerRedis && env.redisContainer) {
    await docker(["stop", env.redisContainer]).catch(() => undefined);
    return;
  }
  await exec("sh", ["-c", `lsof -tiTCP:${env.redisPort} -sTCP:LISTEN | xargs -r kill -9`]).catch(
    () => undefined
  );
}

/** Flush all keys in the dedicated Redis. */
export async function flushRedis(redisUrl: string): Promise<void> {
  const redis = new Redis(redisUrl, { lazyConnect: false, maxRetriesPerRequest: 2 });
  try {
    await redis.flushall();
  } finally {
    redis.disconnect();
  }
}

/**
 * Build a PostgreSQL-provider schema copy in a private directory, regenerate a
 * PRIVATE Prisma client there, and apply the reviewed migration manifest with
 * the production migrator (`scripts/migrate-postgres.mjs`). The shared build
 * schema and `generated/prisma` output are never touched, so concurrent SQLite
 * test runs cannot corrupt this suite. Reviewed migrations are the only schema
 * source of truth; there is no `prisma db push` fallback.
 *
 * The acceptance Vitest config redirects the API's `generated/prisma` import to
 * `GENERATED_ENTRY` via a `resolveId` plugin.
 */
export async function syncPostgresSchema(databaseUrl: string): Promise<void> {
  mkdirSync(TEMP_SCHEMA_DIR, { recursive: true });
  const base = readFileSync(resolve(PACKAGE_DIR, "prisma/schema.prisma"), "utf8");
  const temp = base.replace(/provider\s*=\s*"(?:sqlite|postgresql)"/, 'provider = "postgresql"');
  // `output = "../generated/prisma"` resolves relative to this schema location,
  // i.e. `.runtime/generated/prisma` — a private client.
  writeFileSync(TEMP_SCHEMA_PATH, temp, "utf8");

  const env = { ...process.env, DATABASE_URL: databaseUrl, NODE_ENV: "test" as const };
  await exec("npx", ["prisma", "generate", "--schema", TEMP_SCHEMA_PATH], {
    cwd: PACKAGE_DIR,
    env,
    timeout: 180_000,
    maxBuffer: 10 * 1024 * 1024,
  });
  await exec(process.execPath, [resolve(PACKAGE_DIR, "scripts/migrate-postgres.mjs")], {
    cwd: PACKAGE_DIR,
    env,
    timeout: 180_000,
    maxBuffer: 10 * 1024 * 1024,
  });
}

export async function provisionAcceptanceEnv(): Promise<AcceptanceEnv> {
  if (!(await commandExists("docker"))) {
    throw new Error("Docker is required to provision the acceptance PostgreSQL");
  }
  const container = `pk-accept-pg-${process.pid}-${Date.now()}`;
  await docker([
    "run",
    "--rm",
    "-d",
    "--name",
    container,
    "-e",
    "POSTGRES_PASSWORD=acceptance-only",
    "-p",
    "127.0.0.1::5432",
    "postgres:18-alpine",
  ]);
  const mapped = parseDockerPort(await docker(["port", container, "5432/tcp"]));
  const databaseUrl = `postgresql://postgres:acceptance-only@${mapped.host}:${mapped.port}/postgres`;
  await waitForPostgres(databaseUrl);

  const redis = await startRedis();

  const env: AcceptanceEnv = {
    databaseUrl,
    pgContainer: container,
    ...redis.env,
  };
  mkdirSync(ACCEPTANCE_DIR, { recursive: true });
  writeFileSync(ENV_FILE, JSON.stringify(env, null, 2), "utf8");

  try {
    await syncPostgresSchema(databaseUrl);
  } catch (error) {
    await teardownAcceptanceEnv(env);
    throw error;
  }
  return env;
}

export async function teardownAcceptanceEnv(env: AcceptanceEnv): Promise<void> {
  if (env.useDockerRedis && env.redisContainer) {
    await docker(["rm", "-f", env.redisContainer]).catch(() => undefined);
  } else {
    await exec("sh", ["-c", `lsof -tiTCP:${env.redisPort} -sTCP:LISTEN | xargs -r kill`]).catch(
      () => undefined
    );
  }
  await docker(["rm", "-f", env.pgContainer]).catch(() => undefined);
  rmSync(TEMP_SCHEMA_DIR, { recursive: true, force: true });
}

export function readAcceptanceEnv(): AcceptanceEnv {
  return JSON.parse(readFileSync(ENV_FILE, "utf8")) as AcceptanceEnv;
}

export type { ChildProcess };
