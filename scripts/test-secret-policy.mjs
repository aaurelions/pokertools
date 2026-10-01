import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

// Exercise the release policy itself: exemptions must not hide new secrets in
// first-party tests, fixtures, contracts, documentation, examples or reports.
const directory = mkdtempSync(
  join(process.env.POKERTOOLS_TEST_TMPDIR ?? tmpdir(), "secret-policy-")
);
try {
  const paths = [
    "packages/api/tests/fixtures/anvil-public-key.ts",
    "packages/api/tests/integration/new-test.ts",
    "packages/custody/contracts/src/NewContract.sol",
    "packages/e2e/tests/docker-e2e.test.ts",
    "docs/new.md",
    "packages/api/examples/new.ts",
    "build-report.log",
    ".env.example",
  ];
  for (const path of paths) {
    mkdirSync(dirname(join(directory, path)), { recursive: true });
    const canary = `ghp_${randomBytes(64).toString("base64url").replace(/[-_]/g, "").slice(0, 36)}`;
    writeFileSync(
      join(directory, path),
      `const github_token = "${canary}";\nconst privateKey = "0x${randomBytes(32).toString("hex")}";\n`
    );
  }
  const report = join(directory, "scan.json");
  const result = spawnSync(
    process.env.GITLEAKS_BIN ?? "gitleaks",
    [
      "dir",
      directory,
      "--config",
      resolve(".gitleaks.toml"),
      "--redact",
      "--report-format",
      "json",
      "--report-path",
      report,
    ],
    { encoding: "utf8" }
  );
  assert.equal(result.status, 1, "Scanner must detect the canaries (and be installed)");
  const findings = /** @type {unknown} */ (JSON.parse(readFileSync(report, "utf8")));
  assert(Array.isArray(findings), "Scanner report must be an array");
  /** @param {unknown} finding @param {string} path @param {string | undefined} rule */
  const matches = (finding, path, rule = undefined) =>
    typeof finding === "object" &&
    finding !== null &&
    "File" in finding &&
    typeof finding.File === "string" &&
    finding.File.endsWith(path) &&
    (rule === undefined || ("RuleID" in finding && finding.RuleID === rule));
  for (const path of paths) {
    assert(
      findings.some((finding) => matches(finding, path)),
      `Policy suppressed ${path}`
    );
    assert(
      findings.some((finding) => matches(finding, path, "evm-signing-key")),
      `Policy suppressed an arbitrary signing key in ${path}`
    );
  }
  console.log(`SECRET_POLICY_CANARIES=PASS (${paths.length} first-party paths)`);
} finally {
  rmSync(directory, { recursive: true, force: true });
}
