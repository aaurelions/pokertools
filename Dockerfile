# =============================================================================
# Stage 1: Build — monorepo install, Prisma generate, TypeScript compile
# =============================================================================
FROM node:24-slim AS build

# openssl required by Prisma engines (especially for PostgreSQL TLS connections)
RUN apt-get update -y && \
    apt-get install -y --no-install-recommends openssl && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# ---- Root package files (layer cache for npm ci) ----
COPY package.json package-lock.json .npmrc tsconfig.json tsconfig.base.json ./
COPY eslint.config.js .prettierrc ./

# ---- Workspace package manifests (npm ci needs these to resolve workspaces) ----
COPY packages/types/package.json packages/types/tsconfig.json packages/types/
COPY packages/evaluator/package.json packages/evaluator/tsconfig.json packages/evaluator/
COPY packages/engine/package.json packages/engine/tsconfig.json packages/engine/
COPY packages/sdk/package.json packages/sdk/tsconfig.json packages/sdk/tsconfig.build.json packages/sdk/tsup.config.ts packages/sdk/
COPY packages/bench/package.json packages/bench/tsconfig.json packages/bench/
COPY packages/admin/package.json packages/admin/tsconfig.json packages/admin/
COPY packages/api/package.json packages/api/tsconfig.json packages/api/prisma.config.ts packages/api/

# Prisma schema + migrations (required by prisma generate)
COPY packages/api/prisma/ packages/api/prisma/

# ---- Install all dependencies (workspaces linked via npm workspaces) ----
# --ignore-scripts keeps the layer deterministic (no prepare/install scripts).
RUN npm ci --ignore-scripts

# Rebuild native addons (better-sqlite3) that were skipped by --ignore-scripts.
RUN npm rebuild better-sqlite3

# ---- Copy source files for packages we build ----
COPY packages/types/src packages/types/src
COPY packages/evaluator/src packages/evaluator/src
COPY packages/engine/src packages/engine/src
COPY packages/api/src packages/api/src
COPY packages/api/types packages/api/types
COPY packages/api/scripts packages/api/scripts

# ---- Generate Prisma client (output -> packages/api/generated/prisma) ----
# prisma.config.ts requires DATABASE_URL at generation time.  A throw-away
# SQLite URL is perfectly safe — the generated client is identical regardless
# of the datasource.
RUN cd packages/api && \
    DATABASE_URL="file:../.runtime/prisma-generate.db" npx prisma generate

# ---- Export SQLite DDL as idempotent SQL (runtime bootstrap artifact) ----
# Uses prisma db push against a throw-away SQLite db, then better-sqlite3
# to dump the schema.  Output: packages/api/prisma/schema.sql
RUN node packages/api/scripts/export-schema.mjs

# ---- Build workspace packages in topological order ----
# Build dependency packages first, then the API itself.
# We skip SDK, admin, and bench — the API runtime does not need them.
RUN npm run build -w @pokertools/types && \
    npm run build -w @pokertools/evaluator && \
    npm run build -w @pokertools/engine && \
    npm run build -w @pokertools/api

# ---- Remove dev-only workspaces (not part of the API runtime) ----
# This removes their package.json manifests so the following prune step drops
# their entire dependency sub-trees (poker-evaluator ~178 MB, viem, grammy, etc.).
RUN rm -rf packages/bench packages/admin packages/sdk

# ---- Prune dev dependencies ----
# Also removes packages that were only referenced by the workspaces deleted above.
RUN npm prune --omit=dev

# ---- Manually remove the Prisma CLI, TypeScript, and their transitive deps ----
# Even though prisma is no longer a direct dependency of @pokertools/api, npm
# auto-installs it because @prisma/client declares it as a peerDep.  The same
# applies to typescript.  Together they pull ~240 MB of unused transitive
# dependencies (studio-core, dev, engines, effect, chart.js, react, hono, etc.).
#
# Removal list verified: no package in this list is a production dependency of
# any remaining runtime package (checked via exhaustive node_modules scan).
# Denque and safer-buffer are NOT removed — they are needed by ioredis and asn1.js.
# The @prisma/client, @prisma/client-runtime-utils, and @prisma/adapter-better-sqlite3
# packages are NOT removed — they are the core runtime Prisma client.
RUN rm -rf \
    node_modules/prisma \
    node_modules/typescript \
    node_modules/.prisma \
    node_modules/@prisma/config \
    node_modules/@prisma/dev \
    node_modules/@prisma/engines \
    node_modules/@prisma/engines-version \
    node_modules/@prisma/fetch-engine \
    node_modules/@prisma/get-platform \
    node_modules/@prisma/query-plan-executor \
    node_modules/@prisma/streams-local \
    node_modules/@prisma/studio-core \
    node_modules/@electric-sql \
    node_modules/@hono \
    node_modules/@kurkle \
    node_modules/@radix-ui \
    node_modules/@standard-schema \
    node_modules/@babel \
    node_modules/aws-ssl-profiles \
    node_modules/better-result \
    node_modules/c12 \
    node_modules/chart.js \
    node_modules/chokidar \
    node_modules/confbox \
    node_modules/cross-spawn \
    node_modules/csstype \
    node_modules/deepmerge-ts \
    node_modules/defu \
    node_modules/destr \
    node_modules/effect \
    node_modules/empathic \
    node_modules/env-paths \
    node_modules/exsolve \
    node_modules/foreground-child \
    node_modules/generate-function \
    node_modules/get-port-please \
    node_modules/giget \
    node_modules/graceful-fs \
    node_modules/grammex \
    node_modules/graphmatch \
    node_modules/hono \
    node_modules/http-status-codes \
    node_modules/iconv-lite \
    node_modules/is-property \
    node_modules/isexe \
    node_modules/jiti \
    node_modules/long \
    node_modules/lru.min \
    node_modules/magicast \
    node_modules/minipass \
    node_modules/mysql2 \
    node_modules/named-placeholders \
    node_modules/ohash \
    node_modules/path-key \
    node_modules/pathe \
    node_modules/perfect-debounce \
    node_modules/pkg-types \
    node_modules/postgres \
    node_modules/proper-lockfile \
    node_modules/rc9 \
    node_modules/react \
    node_modules/react-dom \
    node_modules/readdirp \
    node_modules/remeda \
    node_modules/retry \
    node_modules/scheduler \
    node_modules/seq-queue \
    node_modules/shebang-command \
    node_modules/shebang-regex \
    node_modules/signal-exit \
    node_modules/source-map-js \
    node_modules/sqlstring \
    node_modules/valibot \
    node_modules/which \
    node_modules/zeptomatch

# =============================================================================
# Stage 2: Production runtime — minimal, non-root, read-only rootfs
# =============================================================================
FROM node:24-slim

# System packages: openssl (Prisma engines), curl (healthcheck), ca-certificates
# Clean apt cache in same layer to keep image small.
RUN apt-get update -y && \
    apt-get install -y --no-install-recommends \
      openssl curl ca-certificates && \
    rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*

# Non-root user
RUN groupadd -r pokertools && useradd -r -g pokertools -d /app pokertools

WORKDIR /app

# ---- Copy built artefacts from build stage ----
COPY --from=build --chown=pokertools:pokertools /app/package.json /app/package-lock.json /app/.npmrc ./
COPY --from=build --chown=pokertools:pokertools /app/node_modules ./node_modules
COPY --from=build --chown=pokertools:pokertools /app/packages/types ./packages/types
COPY --from=build --chown=pokertools:pokertools /app/packages/evaluator ./packages/evaluator
COPY --from=build --chown=pokertools:pokertools /app/packages/engine ./packages/engine
COPY --from=build --chown=pokertools:pokertools /app/packages/api ./packages/api

# ---- Entrypoint ----
COPY --chown=pokertools:pokertools packages/api/scripts/docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod +x /app/docker-entrypoint.sh

# Ensure runtime directory for SQLite (writable by the pokertools user)
RUN mkdir -p /app/packages/api/.runtime /tmp && chown -R pokertools:pokertools /app /tmp

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

# Docker healthcheck (uses built-in /health endpoint)
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -fsS http://localhost:3000/health || exit 1

USER pokertools

ENTRYPOINT ["/app/docker-entrypoint.sh"]
