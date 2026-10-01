import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

// Run against the actual built image, not a lockfile or an assumed prune graph.
const image = process.argv[2];
assert(image, "Usage: node scripts/test-runtime-dependencies.mjs <built-runtime-image>");
const source = `
const fs = require('node:fs');
const path = require('node:path');
const banned = new Set(['prisma', '@prisma/config', 'deepmerge-ts', 'mysql2']);
function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const child = path.join(directory, entry.name);
    const manifest = path.join(child, 'package.json');
    if (fs.existsSync(manifest)) {
      const name = JSON.parse(fs.readFileSync(manifest, 'utf8')).name;
      if (banned.has(name)) throw new Error('ADVISORY_PACKAGE_SHIPPED:' + name);
    }
    walk(child);
  }
}
walk('/app');
for (const name of banned) {
  for (const base of ['/app', '/app/packages/api', '/app/packages/custody']) {
    try {
      require.resolve(name, { paths: [base] });
      throw new Error('ADVISORY_PACKAGE_RESOLVABLE:' + name);
    } catch (error) {
      if (error.code !== 'MODULE_NOT_FOUND') throw error;
    }
  }
}
console.log('RUNTIME_ADVISORY_PACKAGES_ABSENT=PASS (all installed package manifests and API/custody resolution)');
`;
const result = spawnSync(
  "docker",
  ["run", "--rm", "--network", "none", "--entrypoint", "node", image, "-e", source],
  {
    encoding: "utf8",
    timeout: 60000,
  }
);
assert.equal(result.status, 0, result.stderr || "Runtime dependency verification failed");
const identity = spawnSync("docker", ["image", "inspect", "--format", "{{.Id}}", image], {
  encoding: "utf8",
});
assert.equal(identity.status, 0, "Cannot record image identity");
console.log(identity.stdout.trim());
console.log(result.stdout.trim());
