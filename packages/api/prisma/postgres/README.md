# PostgreSQL migrations

`prisma/schema.prisma` is the single canonical schema source. The SQLite runtime
artifact (`prisma/schema.sql`) and the PostgreSQL baseline below are both
generated from it — never hand-written.

## Layout

| File                           | Purpose                                                                                                                                                                                                                                                                    |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `001_initial_schema.sql`       | Offline baseline generated from `prisma/schema.prisma` with the `postgresql` provider. Contains every `CREATE TYPE`, `CREATE TABLE`, index and foreign key Prisma declares (native PostgreSQL enums, composite same-asset FKs, unique `(id, assetId)` targets).            |
| `002_financial_invariants.sql` | Invariants Prisma cannot express: canonical decimal-string CHECKs, asset/custody domain checks, sealed-journal/append-only triggers, the deferred balanced-journal constraint trigger, the AtomicAccount nonnegative trigger, and economic/reconciliation/incident checks. |
| `003_audit_invariants.sql`     | Append-only audit invariants for `GameEvent`, `TournamentEvent` and `GameActionRequest`.                                                                                                                                                                                   |
| `migrations.json`              | Ordered manifest with the SHA-256 of each file.                                                                                                                                                                                                                            |

## Regenerating the baseline

```bash
cd packages/api
# 1. Portable SQLite artifact
node scripts/export-schema.mjs
# 2. Offline PostgreSQL baseline
mkdir -p /tmp/pg-baseline
sed 's/provider = "sqlite"/provider = "postgresql"/' prisma/schema.prisma \
  > /tmp/pg-baseline/schema.prisma
DATABASE_URL="postgresql://prisma:generate@localhost:5432/prisma_generate" \
  npx prisma migrate diff --from-empty --to-schema /tmp/pg-baseline/schema.prisma --script \
  > prisma/postgres/001_initial_schema.sql
# 3. Recompute migrations.json sha256 for 001 (and commit with the schema change)
```

## Immutability / append-only policy

This baseline is a single pre-production reset. From the next major release
onward **everything at and after `001_initial_schema.sql` is immutable and
append-only**:

- Never edit a released migration file. `scripts/migrate-postgres.mjs` verifies
  each file against the `sha256` in `migrations.json` and fails closed on drift
  (`MIGRATION_FILE_DRIFT`) or on a changed applied checksum
  (`MIGRATION_APPLIED_DRIFT`).
- Schema changes require a **new** higher-numbered migration file plus a new
  manifest entry. Do not rewrite history.
- `migrations.json` is ordered; gaps or unknown applied names fail closed
  (`MIGRATION_ORDER_DRIFT`, `MIGRATION_UNKNOWN`).
- The manifest is applied under a PostgreSQL advisory lock, so concurrent
  migrators are serialized.

Apply migrations with:

```bash
DATABASE_URL=postgresql://... npm run db:migrate:postgres -w @pokertools/api
```
