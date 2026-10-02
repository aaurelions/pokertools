#!/usr/bin/env bash
# Finance/custody acceptance runner.
#
# Requires: Foundry (anvil, forge), Docker (fresh Postgres 18 + Redis 8 images),
# Node >= 24. Starts two isolated Anvil chains (31337/31338), a disposable
# Postgres + Redis, applies migrations and runs the finance acceptance suite.
#
# Usage:
#   scripts/run-finance-acceptance.sh [vitest args...]
#   scripts/run-finance-acceptance.sh tests/finance/harness-smoke.test.ts
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

command -v anvil >/dev/null 2>&1 || { echo "anvil (Foundry) is required" >&2; exit 1; }
command -v forge >/dev/null 2>&1 || { echo "forge (Foundry) is required" >&2; exit 1; }
command -v docker >/dev/null 2>&1 || { echo "docker is required for fresh Postgres/Redis" >&2; exit 1; }
command -v node >/dev/null 2>&1 || { echo "node >= 24 is required" >&2; exit 1; }

echo "==> Building Foundry test fixtures (MockUSDC + MockAssetToken)"
npm run contracts:build --workspace @pokertools/custody

echo "==> Running finance acceptance"
cd packages/e2e
exec npx vitest run --config vitest.finance.config.ts "$@"
