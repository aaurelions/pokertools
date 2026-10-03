import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspaces = ["types", "evaluator", "engine", "sdk"];
const output = execFileSync(
  "npm",
  ["pack", "--dry-run", "--json", ...workspaces.flatMap((name) => ["-w", `@pokertools/${name}`])],
  { cwd: root, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 }
);
// npm 12 keys workspace results by package name.
const results = z
  .record(
    z.string(),
    z.object({
      name: z.string(),
      version: z.string(),
      files: z.array(z.object({ path: z.string() })),
    })
  )
  .parse(/** @type {unknown} */ (JSON.parse(output)));
const packages = Object.values(results);
assert.equal(packages.length, workspaces.length);

/** @param {unknown} value @returns {string[]} */
function exportTargets(value) {
  if (typeof value === "string") return [value];
  if (value && typeof value === "object") return Object.values(value).flatMap(exportTargets);
  return [];
}

for (const name of workspaces) {
  const manifest = z
    .object({
      name: z.string(),
      version: z.string(),
      main: z.string().optional(),
      types: z.string().optional(),
      exports: z.unknown().optional(),
    })
    .parse(
      /** @type {unknown} */ (
        JSON.parse(readFileSync(resolve(root, "packages", name, "package.json"), "utf8"))
      )
    );
  const packed = packages.find((entry) => entry.name === manifest.name);
  assert(packed, `Missing package ${manifest.name}`);
  assert.equal(packed.version, manifest.version);
  const files = new Set(packed.files.map((entry) => entry.path));
  for (const path of files) {
    assert(
      !path.split("/").some((part) => part.startsWith(".")) &&
        !/(^|\/)(tests?|coverage|generated|node_modules|prisma|src)(\/|$)/.test(path) &&
        !/\.(?:db|sqlite|pem|key|log|tsbuildinfo)$/.test(path),
      `${manifest.name} ships private source, build metadata or runtime artifact: ${path}`
    );
    assert(
      path === "package.json" ||
        path === "README.md" ||
        path === "LICENSE" ||
        path.startsWith("dist/"),
      `${manifest.name} ships an unexpected file: ${path}`
    );
  }
  for (const target of [manifest.main, manifest.types, ...exportTargets(manifest.exports)].filter(
    (value) => typeof value === "string"
  )) {
    assert(files.has(target.replace(/^\.\//, "")), `${manifest.name} export is missing: ${target}`);
  }
  console.log(`${manifest.name}@${manifest.version}: ${files.size} publish files verified`);
}
