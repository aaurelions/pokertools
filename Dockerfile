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

# ---- Build workspace packages in topological order ----
# Build dependency packages first, then the API itself.
# We skip SDK, admin, and bench — the API runtime does not need them.
RUN npm run build -w @pokertools/types && \
    npm run build -w @pokertools/evaluator && \
    npm run build -w @pokertools/engine && \
    npm run build -w @pokertools/api

# =============================================================================
# Stage 2: Production runtime — minimal, non-root, production-ready
# =============================================================================
FROM node:24-slim

# System packages: openssl (Prisma engines), curl (healthcheck), ca-certificates
RUN apt-get update -y && \
    apt-get install -y --no-install-recommends \
      openssl curl ca-certificates && \
    rm -rf /var/lib/apt/lists/*

# Non-root user
RUN groupadd -r pokertools && useradd -r -g pokertools -d /app pokertools

WORKDIR /app

# ---- Copy built artefacts from build stage ----
COPY --from=build --chown=pokertools:pokertools /app/package.json /app/package-lock.json /app/.npmrc ./
COPY --from=build --chown=pokertools:pokertools /app/node_modules ./node_modules
COPY --from=build --chown=pokertools:pokertools /app/packages ./packages

# ---- Entrypoint ----
COPY --chown=pokertools:pokertools packages/api/scripts/docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod +x /app/docker-entrypoint.sh

# Ensure runtime directory for SQLite
RUN mkdir -p /app/packages/api/.runtime && chown -R pokertools:pokertools /app

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

# Docker healthcheck (uses built-in /health endpoint)
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -fsS http://localhost:3000/health || exit 1

USER pokertools

ENTRYPOINT ["/app/docker-entrypoint.sh"]
