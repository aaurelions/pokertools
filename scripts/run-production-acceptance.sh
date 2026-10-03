#!/usr/bin/env bash
# =============================================================================
# run-production-acceptance.sh — production-container acceptance runner.
#
# Builds the real production image and runs the real docker-compose.prod.yml
# topology (postgres, redis, api, worker, custody) under a disposable,
# uniquely named compose project with test-only overrides generated OUTSIDE the
# repository in a private temporary directory (mode 0700/0600):
#
#   * random loopback-only host ports for the API and PostgreSQL,
#   * an isolated ephemeral Anvil port plus two independent RPC quorum proxies
#     reachable from the containers through the host gateway,
#   * a custody-only signing env file generated from the public, valueless
#     Anvil account zero (never copied from a repository .env.custody),
#   * generated JWT/COOKIE/PostgreSQL/Redis secrets that are never printed.
#
# Caddy and backup are deliberately not started: the acceptance suite runs the
# api/worker/custody/postgres/redis services from the real production compose
# file and does not depend on a public domain, TLS or scheduled backups.
#
# Teardown always removes the compose project (including its named volumes) and
# stops Anvil, even on failure. No secret is ever echoed.
#
# Usage:
#   scripts/run-production-acceptance.sh [--keep] [vitest args...]
#
# Requirements: Docker + Compose v2.24+ (`!override`), Foundry (anvil, forge),
# Node >= 24, curl, openssl.
# =============================================================================
set -euo pipefail
umask 077

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

KEEP="0"
args=()
for arg in "$@"; do
  if [[ "$arg" == "--keep" ]]; then
    KEEP="1"
  else
    args+=("$arg")
  fi
done

# ---------------------------------------------------------------------------
# Preflight
# ---------------------------------------------------------------------------
for command in docker node npm npx curl openssl; do
  command -v "$command" >/dev/null 2>&1 || { echo "missing required command: $command" >&2; exit 1; }
done
docker info >/dev/null 2>&1 || { echo "Docker daemon is not available" >&2; exit 1; }
docker compose version >/dev/null 2>&1 || { echo "docker compose v2 is required" >&2; exit 1; }
command -v anvil >/dev/null 2>&1 || { echo "anvil (Foundry) is required" >&2; exit 1; }
command -v forge >/dev/null 2>&1 || { echo "forge (Foundry) is required" >&2; exit 1; }

run_id="$(date +%Y%m%d%H%M%S)-$$"
project="pt-prod-accept-${run_id}"
image="pt-prod-accept:${run_id}"

tmp_base="${POKERTOOLS_TEST_TMPDIR:-${TMPDIR:-/tmp}}"
tmp_base="${tmp_base%/}"
work="$(mktemp -d "${tmp_base}/pt-prod-accept.${run_id}.XXXXXX")"
chmod 700 "$work"

compose_env="${work}/acceptance.env"
overlay="${work}/overlay.yml"
custody_env_dir="${work}/custody"
custody_env="${custody_env_dir}/.env.custody"
anvil_log="${work}/anvil.log"
mkdir -p "$custody_env_dir"

# ---------------------------------------------------------------------------
# Generated disposable secrets (never printed)
# ---------------------------------------------------------------------------
pg_password="$(openssl rand -hex 24)"
redis_password="$(openssl rand -hex 24)"
jwt_secret="$(openssl rand -hex 48)"
cookie_secret="$(openssl rand -hex 48)"

# The public, valueless Anvil account zero is the only signing key ever used.
# It is read from the committed fixture so it cannot drift; it is not a secret.
treasury_key="$(node -e 'const fs=require("fs");const src=fs.readFileSync("packages/e2e/tests/fixtures/anvil-public-key.ts","utf8");const m=src.match(/"(0x[0-9a-fA-F]{64})"/);if(!m)process.exit(1);console.log(m[1])')"

# ---------------------------------------------------------------------------
# Isolated ephemeral Anvil (never port 8545: other suites may use it)
# ---------------------------------------------------------------------------
anvil_port="$(node -e 'const net=require("net");const s=net.createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')"

anvil_pid=""
cleanup() {
  local status=$?
  trap - EXIT INT TERM
  if [[ -n "$anvil_pid" ]]; then
    kill "$anvil_pid" >/dev/null 2>&1 || true
    wait "$anvil_pid" >/dev/null 2>&1 || true
  fi
  docker compose --env-file "$compose_env" -p "$project" \
    -f "${repo_root}/docker-compose.prod.yml" -f "$overlay" \
    down -v --remove-orphans >/dev/null 2>&1 || true
  if [[ "$KEEP" == "1" ]]; then
    echo "Kept acceptance environment: ${work}" >&2
  else
    rm -rf "$work"
  fi
  exit "$status"
}
trap cleanup EXIT INT TERM

echo "==> Starting isolated Anvil on ephemeral port ${anvil_port} (automine)"
# Automine only: block height changes exclusively when the suite mines
# explicitly, so independent quorum endpoints always agree on eth_blockNumber
# (interval mining can straddle a block between concurrent quorum reads and
# freeze the chain).
anvil --host 0.0.0.0 --port "$anvil_port" >"$anvil_log" 2>&1 &
anvil_pid=$!
anvil_ready="0"
for _ in $(seq 1 120); do
  if curl -fsS -X POST -H 'content-type: application/json' \
      --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' \
      "http://127.0.0.1:${anvil_port}" >/dev/null 2>&1; then
    anvil_ready="1"
    break
  fi
  sleep 0.25
done
if [[ "$anvil_ready" != "1" ]]; then
  echo "Anvil did not become ready; log: ${anvil_log}" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Test-only compose environment / overrides, all OUTSIDE the repository
# ---------------------------------------------------------------------------
cat >"$compose_env" <<EOF
POSTGRES_USER=ptaccept
POSTGRES_PASSWORD=${pg_password}
POSTGRES_DB=pokertools
REDIS_PASSWORD=${redis_password}
DATABASE_URL=postgresql://ptaccept:${pg_password}@postgres:5432/pokertools
JWT_SECRET=${jwt_secret}
COOKIE_SECRET=${cookie_secret}
CORS_ORIGIN=http://127.0.0.1
ALLOWED_SIWE_CHAIN_IDS=31337
COMPETITION_PAID_ENABLED=true
LOG_LEVEL=info
RATE_LIMIT_MAX=100000
AUTH_NONCE_RATE_LIMIT_MAX=1000
AUTH_LOGIN_RATE_LIMIT_MAX=1000
CADDY_DOMAIN=acceptance.invalid
PT_PROD_ACCEPT_IMAGE=${image}
EOF
chmod 600 "$compose_env"

cat >"$custody_env" <<EOF
TREASURY_SIGNING_KEYS_JSON={"31337":"${treasury_key}"}
CUSTODY_WORKER_INTERVAL_MS=2000
CUSTODY_RECONCILE_INTERVAL_MS=3600000
CUSTODY_QUORUM_THRESHOLD=2
CUSTODY_MIN_QUORUM=2
EOF
chmod 600 "$custody_env"

# The overlay replaces the base custody env_file (which is a repository path)
# with the generated custody-only file. `!override` is required because Compose
# appends sequence values by default.
cat >"$overlay" <<EOF
services:
  api:
    image: "${image}"
    pull_policy: missing
    ports:
      - "127.0.0.1::3000"
    extra_hosts:
      - "host.docker.internal:host-gateway"
  worker:
    image: "${image}"
    pull_policy: missing
    extra_hosts:
      - "host.docker.internal:host-gateway"
  custody:
    image: "${image}"
    pull_policy: missing
    extra_hosts:
      - "host.docker.internal:host-gateway"
    env_file: !override
      - path: "${custody_env}"
        required: true
  postgres:
    ports:
      - "127.0.0.1::5432"
EOF
chmod 600 "$overlay"

# ---------------------------------------------------------------------------
# Build fixtures + host SDK, then the production image once
# ---------------------------------------------------------------------------
echo "==> Building Foundry test fixtures (MockUSDC)"
npm run contracts:build --workspace @pokertools/custody

echo "==> Building @pokertools/types and @pokertools/sdk for the host test process"
npm run build --workspace @pokertools/types
npm run build --workspace @pokertools/sdk

echo "==> Building production image ${image}"
docker build --tag "$image" "$repo_root"

# ---------------------------------------------------------------------------
# Run the acceptance suite (compose lifecycle is owned by global setup, with
# this script's trap as the crash-safe teardown backstop)
# ---------------------------------------------------------------------------
export PT_PROD_ACCEPT_PROJECT="$project"
export PT_PROD_ACCEPT_WORK="$work"
export PT_PROD_ACCEPT_IMAGE="$image"
export PT_PROD_ACCEPT_ANVIL_RPC="http://127.0.0.1:${anvil_port}"
export PT_PROD_ACCEPT_COMPOSE_BASE="${repo_root}/docker-compose.prod.yml"
export PT_PROD_ACCEPT_COMPOSE_ENV="$compose_env"
export PT_PROD_ACCEPT_OVERLAY="$overlay"
export PT_PROD_ACCEPT_PG_USER="ptaccept"
export PT_PROD_ACCEPT_PG_PASSWORD="$pg_password"
export PT_PROD_ACCEPT_PG_DATABASE="pokertools"

echo "==> Running production-container acceptance (project ${project})"
cd "${repo_root}/packages/e2e"
npx vitest run --config tests/production/vitest.production.config.ts "${args[@]+"${args[@]}"}"
