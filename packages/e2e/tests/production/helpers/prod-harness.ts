/**
 * Shared production-container acceptance harness helpers.
 *
 * The suite runs the real `docker-compose.prod.yml` topology (postgres,
 * redis, api, worker, custody) under a disposable, uniquely named compose
 * project. The runner script generates every test-only override OUTSIDE the
 * repository (temporary directory, mode 0600) and exports only path/project
 * handles plus the disposable PostgreSQL password here; no signing material is
 * ever passed to the test process.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ProductionHandoff {
  project: string;
  workDir: string;
  image: string;
  apiBase: string;
  wsUrl: string;
  pg: {
    host: string;
    port: number;
    user: string;
    password: string;
    database: string;
  };
  chain: {
    chainId: number;
    anvilRpc: string;
    usdcAddress: `0x${string}`;
    treasuryAddress: `0x${string}`;
    treasuryPrivateKey: `0x${string}`;
    /** URLs reachable from inside the compose containers (host gateway). */
    containerRpcUrls: string[];
    /** Loopback URLs reachable from this host test process. */
    hostRpcUrls: string[];
  };
  compose: {
    base: string;
    overlay: string;
    envFile: string;
  };
}

export function workDir(): string {
  const dir = process.env.PT_PROD_ACCEPT_WORK;
  if (!dir) {
    throw new Error(
      "PT_PROD_ACCEPT_WORK is not set. Run scripts/run-production-acceptance.sh instead of vitest directly."
    );
  }
  return dir;
}

export function readHandoff(): ProductionHandoff {
  const file = path.join(workDir(), "handoff.json");
  if (!fs.existsSync(file)) {
    throw new Error(`Production acceptance handoff is missing at ${file}`);
  }
  return JSON.parse(fs.readFileSync(file, "utf8")) as ProductionHandoff;
}

export function composeInvocation(): {
  base: string;
  overlay: string;
  envFile: string;
  project: string;
} {
  const base = process.env.PT_PROD_ACCEPT_COMPOSE_BASE;
  const overlay = process.env.PT_PROD_ACCEPT_OVERLAY;
  const envFile = process.env.PT_PROD_ACCEPT_COMPOSE_ENV;
  const project = process.env.PT_PROD_ACCEPT_PROJECT;
  if (!base || !overlay || !envFile || !project) {
    throw new Error(
      "Production acceptance compose handles are missing. Run scripts/run-production-acceptance.sh."
    );
  }
  return { base, overlay, envFile, project };
}

/**
 * Run `docker compose` against the disposable project. Never enable shell
 * interpolation: arguments are passed verbatim.
 */
export async function runCompose(
  args: string[],
  options: { timeoutMs?: number; allowFailure?: boolean } = {}
): Promise<string> {
  const { base, overlay, envFile, project } = composeInvocation();
  try {
    const result = await execFileAsync(
      "docker",
      ["compose", "--env-file", envFile, "-p", project, "-f", base, "-f", overlay, ...args],
      { timeout: options.timeoutMs ?? 120_000, maxBuffer: 32 * 1024 * 1024 }
    );
    return result.stdout;
  } catch (error) {
    if (options.allowFailure) return "";
    throw error;
  }
}

/**
 * Redact disposable credentials and URL userinfo before any diagnostic text
 * reaches the test output.
 */
export function redact(text: string): string {
  const secrets = [
    process.env.PT_PROD_ACCEPT_PG_PASSWORD,
    process.env.PT_PROD_ACCEPT_REDIS_PASSWORD,
  ].filter((value): value is string => typeof value === "string" && value.length > 0);
  let redacted = text.replace(/(\w+:\/\/)[^\s/@]+:[^\s/@]+@/g, "$1[redacted]@");
  for (const secret of secrets) redacted = redacted.split(secret).join("[redacted]");
  return redacted;
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Poll an observed condition; never a guessed startup delay. Returns the first
 * truthy value or throws with `description` after the deadline.
 */
export async function waitFor<T>(
  probe: () => Promise<T | null | undefined | false>,
  timeoutMs: number,
  intervalMs: number,
  description: string
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(intervalMs);
  }
  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for ${description}${
      lastError instanceof Error ? `: ${lastError.message}` : ""
    }`
  );
}
