/**
 * Node-side helpers for the browser acceptance harness.
 *
 * These helpers (a) resolve a locally installed Playwright without adding a
 * project dependency, (b) bundle the in-browser harness from the BUILT SDK
 * package root, and (c) serve the harness assets over loopback.
 */

import { createRequire } from "node:module";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

const require = createRequire(import.meta.url);

export interface PlaywrightResolution {
  // Playwright's public browser API; typed as unknown-compatible any because
  // the browser dependency is intentionally not part of the project manifests.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  chromium: any;
  resolvedFrom: string;
  version: string;
}

function versionTuple(version: string): number[] {
  return version
    .split(".")
    .map((part) => Number.parseInt(part, 10))
    .map((part) => (Number.isFinite(part) ? part : 0));
}

function compareVersions(a: number[], b: number[]): number {
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Locate a Node Playwright installation. Order:
 * 1. explicit POKERTOOLS_PLAYWRIGHT_MODULE override,
 * 2. the project's own node_modules,
 * 3. any `npx` cache (e.g. from `npx playwright`), preferring the newest.
 *
 * Returns null (rather than throwing) so the caller can surface a precise
 * dependency blocker instead of a crash.
 */
export function loadPlaywright(): PlaywrightResolution | null {
  const overrides: string[] = [];
  if (process.env.POKERTOOLS_PLAYWRIGHT_MODULE) {
    overrides.push(process.env.POKERTOOLS_PLAYWRIGHT_MODULE);
  }

  const candidates: Array<{ dir: string; version: string }> = [];
  for (const override of overrides) {
    candidates.push({ dir: override, version: "999.0.0" });
  }

  try {
    const resolved = require.resolve("playwright");
    candidates.push({ dir: dirname(dirname(resolved)), version: "0.0.0-project" });
  } catch {
    // Not declared in the project; fall through to the npx cache.
  }

  const npxRoot = join(homedir(), ".npm", "_npx");
  if (existsSync(npxRoot)) {
    for (const entry of readdirSync(npxRoot)) {
      const packageDir = join(npxRoot, entry, "node_modules", "playwright");
      const manifest = join(packageDir, "package.json");
      if (!existsSync(manifest)) continue;
      try {
        const parsed = JSON.parse(readFileSync(manifest, "utf8")) as { version?: string };
        if (!parsed.version) continue;
        candidates.push({ dir: packageDir, version: parsed.version });
      } catch {
        // Ignore malformed cache entries.
      }
    }
  }

  // Prefer project installs, then newest cached version.
  candidates.sort((a, b) => {
    const aProject = a.version.endsWith("-project") ? 1 : 0;
    const bProject = b.version.endsWith("-project") ? 1 : 0;
    if (aProject !== bProject) return bProject - aProject;
    return compareVersions(versionTuple(b.version), versionTuple(a.version));
  });

  for (const candidate of candidates) {
    try {
      const loaded = require(candidate.dir) as {
        chromium?: unknown;
        version?: string;
      };
      if (loaded?.chromium) {
        return {
          chromium: loaded.chromium,
          resolvedFrom: candidate.dir,
          version: loaded.version ?? candidate.version,
        };
      }
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

/** Bundle the in-browser harness. The SDK import resolves to the built dist. */
export async function bundleHarness(entryPath: string): Promise<{
  code: string;
  inputs: string[];
}> {
  const esbuild = require("esbuild") as {
    build(options: Record<string, unknown>): Promise<{
      outputFiles?: Array<{ text: string }>;
      metafile?: { inputs: Record<string, unknown> };
    }>;
  };
  const result = await esbuild.build({
    entryPoints: [entryPath],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2022",
    logLevel: "silent",
    metafile: true,
    define: { "process.env.NODE_ENV": '"production"' },
  });
  const code = result.outputFiles?.[0]?.text;
  if (!code) throw new Error("esbuild produced no harness bundle");
  const inputs = Object.keys(result.metafile?.inputs ?? {}).map((input) =>
    isAbsolute(input) ? input : resolve(process.cwd(), input)
  );
  return { code, inputs };
}

export interface AssetServer {
  url: string;
  close(): Promise<void>;
}

/** Serve harness assets over loopback on an ephemeral port. */
export async function startAssetServer(
  assets: Record<string, { body: string; contentType: string }>
): Promise<AssetServer> {
  const server = createServer((request, response) => {
    const rawPath = (request.url ?? "/").split("?")[0] ?? "/";
    const path = rawPath === "/" ? "/index.html" : rawPath;
    const asset = assets[path];
    if (!asset) {
      response.statusCode = 404;
      response.end("not found");
      return;
    }
    response.setHeader("content-type", asset.contentType);
    response.setHeader("cache-control", "no-store");
    response.end(asset.body);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Failed to bind harness asset server");
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

/** Read a file only if it exists; used to keep optional diagnostics cheap. */
export function readIfExists(path: string): string | null {
  try {
    if (!existsSync(path) || !statSync(path).isFile()) return null;
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}
