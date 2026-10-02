/**
 * Fresh, disposable PostgreSQL + Redis harness for finance acceptance.
 *
 * No shared developer database and no DB credit shortcuts: each run gets a
 * brand-new Postgres container and a brand-new Redis container on ephemeral
 * host ports. The canonical Prisma schema is materialised against PostgreSQL in
 * a PRIVATE generated-client directory (`.runtime/finance-generated/prisma`)
 * that the acceptance Vitest config aliases into the API/custody sources. The
 * shared `packages/api/generated/prisma` SQLite build output is never touched,
 * so concurrent SQLite test runs cannot be corrupted.
 *
 * Tests may create config/auth/asset fixtures, but balances under assertion are
 * produced by real on-chain transfers and real journal postings.
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";
import Redis from "ioredis";

const exec = promisify(execFile);

const POSTGRES_IMAGE = process.env.PT_FINANCE_POSTGRES_IMAGE ?? "postgres:18-alpine";
const REDIS_IMAGE = process.env.PT_FINANCE_REDIS_IMAGE ?? "redis:8-alpine";
const POSTGRES_PASSWORD = "pokertools-finance-acceptance-only";

/** packages/e2e — two levels up from tests/finance/helpers. */
const E2E_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
/** packages/api — the workspace package that owns prisma/schema.prisma. */
const API_DIR = resolve(E2E_DIR, "../api");

export const FINANCE_RUNTIME_DIR = resolve(E2E_DIR, ".runtime");
const TEMP_SCHEMA_DIR = resolve(FINANCE_RUNTIME_DIR, "finance-schema");
const TEMP_SCHEMA_PATH = resolve(TEMP_SCHEMA_DIR, "schema.prisma");
/** Private PostgreSQL client; never the shared `generated/prisma` output. */
export const FINANCE_GENERATED_DIR = resolve(FINANCE_RUNTIME_DIR, "finance-generated", "prisma");
export const FINANCE_GENERATED_ENTRY = resolve(FINANCE_GENERATED_DIR, "index.js");

export interface FreshPostgres {
  databaseUrl: string;
  containerName: string;
  stop(): Promise<void>;
}

export interface FreshRedis {
  redisUrl: string;
  containerName: string;
  stop(): Promise<void>;
}

async function dockerPort(containerName: string, containerPort: number): Promise<number> {
  const { stdout } = await exec("docker", ["port", containerName, `${containerPort}/tcp`]);
  const port = Number(stdout.trim().split(":").at(-1));
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`Could not resolve host port for ${containerName}: ${stdout}`);
  }
  return port;
}

export async function startFreshPostgres(): Promise<FreshPostgres> {
  const containerName = `pt-finance-pg-${randomUUID()}`;
  await exec("docker", [
    "run",
    "--rm",
    "-d",
    "--name",
    containerName,
    "-e",
    `POSTGRES_PASSWORD=${POSTGRES_PASSWORD}`,
    "-p",
    "127.0.0.1::5432",
    POSTGRES_IMAGE,
  ]);
  const port = await dockerPort(containerName, 5432);
  const databaseUrl = `postgresql://postgres:${POSTGRES_PASSWORD}@127.0.0.1:${port}/postgres`;

  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 1,
    connectionTimeoutMillis: 1000,
  });
  try {
    for (let attempt = 0; attempt < 120; attempt++) {
      try {
        await pool.query("SELECT 1");
        return {
          databaseUrl,
          containerName,
          stop: async () => {
            await pool.end().catch(() => undefined);
            await exec("docker", ["rm", "-f", containerName]).catch(() => undefined);
          },
        };
      } catch {
        await delay(250);
      }
    }
    throw new Error("Fresh PostgreSQL did not become ready");
  } catch (error) {
    await pool.end().catch(() => undefined);
    await exec("docker", ["rm", "-f", containerName]).catch(() => undefined);
    throw error;
  }
}

export async function startFreshRedis(): Promise<FreshRedis> {
  const containerName = `pt-finance-redis-${randomUUID()}`;
  await exec("docker", [
    "run",
    "--rm",
    "-d",
    "--name",
    containerName,
    "-p",
    "127.0.0.1::6379",
    REDIS_IMAGE,
    "redis-server",
    "--save",
    "",
    "--appendonly",
    "no",
  ]);
  const port = await dockerPort(containerName, 6379);
  const redisUrl = `redis://127.0.0.1:${port}/0`;

  const client = new Redis(redisUrl, { maxRetriesPerRequest: 1, lazyConnect: true });
  try {
    for (let attempt = 0; attempt < 120; attempt++) {
      try {
        await client.connect();
        await client.ping();
        await client.quit();
        return {
          redisUrl,
          containerName,
          stop: async () => {
            await exec("docker", ["rm", "-f", containerName]).catch(() => undefined);
          },
        };
      } catch {
        client.disconnect();
        await delay(200);
      }
    }
    throw new Error("Fresh Redis did not become ready");
  } catch (error) {
    client.disconnect();
    await exec("docker", ["rm", "-f", containerName]).catch(() => undefined);
    throw error;
  }
}

/**
 * Materialise the canonical Prisma schema as a PostgreSQL-provider schema in a
 * private runtime directory and generate a private Prisma client there, then
 * apply the reviewed migration manifest with the production migrator
 * (`scripts/migrate-postgres.mjs`). Reviewed migrations are the only schema
 * source of truth; there is no `prisma db push` fallback. No balance is seeded.
 */
export async function syncPostgresSchema(databaseUrl: string): Promise<void> {
  mkdirSync(TEMP_SCHEMA_DIR, { recursive: true });
  const base = readFileSync(resolve(API_DIR, "prisma/schema.prisma"), "utf8");
  const absoluteGenerated = FINANCE_GENERATED_DIR.replace(/\\/g, "/");
  const temp = base
    .replace(/provider\s*=\s*"(?:sqlite|postgresql)"/, 'provider = "postgresql"')
    .replace(/output\s*=\s*"[^"]*"/, `output   = "${absoluteGenerated}"`);
  writeFileSync(TEMP_SCHEMA_PATH, temp, "utf8");

  const env = { ...process.env, DATABASE_URL: databaseUrl, NODE_ENV: "test" as const };
  await exec("npx", ["prisma", "generate", "--schema", TEMP_SCHEMA_PATH], {
    cwd: API_DIR,
    env,
    timeout: 180_000,
    maxBuffer: 10 * 1024 * 1024,
  });

  const migration = await exec(
    process.execPath,
    [resolve(API_DIR, "scripts/migrate-postgres.mjs")],
    { cwd: API_DIR, env, timeout: 180_000, maxBuffer: 10 * 1024 * 1024 }
  );
  console.log(`[finance-acceptance] reviewed migrations applied:\n${migration.stdout.trim()}`);

  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  try {
    const { rows } = await pool.query(
      "select column_name from information_schema.columns where table_name = 'User' order by ordinal_position"
    );
    const columns = rows.map((row: { column_name: string }) => row.column_name);
    console.log(`[finance-acceptance] User columns after schema setup: ${columns.join(",")}`);
    if (!columns.includes("kind")) {
      throw new Error("FINANCE_SCHEMA_MISSING_USER_KIND");
    }
  } finally {
    await pool.end();
  }
}

/**
 * Drop and recreate the public schema for cross-test isolation, then re-apply
 * the reviewed migration manifest so the canonical schema is restored.
 */
export async function resetPostgresSchema(databaseUrl: string): Promise<void> {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  try {
    await pool.query("DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public");
  } finally {
    await pool.end();
  }
  await syncPostgresSchema(databaseUrl);
}

export async function flushRedis(redisUrl: string): Promise<void> {
  const client = new Redis(redisUrl, { maxRetriesPerRequest: 1 });
  try {
    await client.flushdb();
  } finally {
    await client.quit();
  }
}

export interface FreshInfra {
  databaseUrl: string;
  redisUrl: string;
  stop(): Promise<void>;
}

/** Start fresh Postgres + Redis, then apply the reviewed migrations. */
export async function startFreshInfra(): Promise<FreshInfra> {
  const postgres = await startFreshPostgres();
  let redis: FreshRedis | null = null;
  try {
    redis = await startFreshRedis();
    await syncPostgresSchema(postgres.databaseUrl);
    return {
      databaseUrl: postgres.databaseUrl,
      redisUrl: redis.redisUrl,
      stop: async () => {
        await redis?.stop();
        await postgres.stop();
        rmSync(TEMP_SCHEMA_DIR, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await redis?.stop();
    await postgres.stop();
    throw error;
  }
}
