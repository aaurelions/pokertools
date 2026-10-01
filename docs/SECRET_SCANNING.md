# First-party release secret scan

Use Gitleaks 8.30.1 or newer with the reviewed `.gitleaks.toml` policy:

```sh
gitleaks dir . --config .gitleaks.toml --redact --report-format json --report-path /outside/repo/source-scan.json
node scripts/test-secret-policy.mjs
gitleaks dir /outside/repo/captured-release-logs --config "$PWD/.gitleaks.toml" --redact
```

`GITLEAKS_BIN` selects the executable for the policy test. `POKERTOOLS_TEST_TMPDIR`
may select an approved temporary directory. Scan captured build/test/audit reports
as well as source; do not commit scan output containing credential material.

The policy extends the built-in rules and adds literal EVM signing-key detection.
Only the two pinned third-party Foundry
submodules are excluded by directory. No first-party tests, fixtures, Solidity,
configuration, documentation or examples are excluded. The default scanner's
dependency/binary skips still apply; generated release output is not exempted by
our policy.

Other exceptions require **both** an exact path and reviewed match: one empty
example setting, a truncated example JWT, a shell environment-variable
placeholder, two source expressions referencing disposable test settings, and
the public Anvil account-zero key in named isolated fixtures. The Anvil key is
public and must never hold valuable assets. An unrelated key in the same fixture
is not allowed. Canary tests verify new secrets remain detectable in all these
first-party categories, including logs.

Match exceptions are rule-scoped using `targetRules`. In Gitleaks 8.30.1 a
global path+regex allowlist can skip the whole file at enumeration time despite
`condition = "AND"` (upstream PR #2227). The canary test caught this; rule-scoped
exceptions avoid the defect. Do not move these exceptions into global path
allowlists. Each canary also includes an arbitrary EVM signing key to prove that
the known public key exception is value-specific.

Zero findings is scanner evidence, not proof against every secret class or
historical leaks. Do not add broad suppressions to make a release pass.
