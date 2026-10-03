-- =============================================================================
-- 003_audit_invariants.sql — append-only game/tournament audit streams
--
-- Applied on top of 001_initial_schema.sql (which already creates the
-- GameEvent, GameActionRequest, GameOutbox and TournamentEvent tables and
-- their unique indexes). This migration adds ONLY the invariants Prisma cannot
-- express:
--
--   * GameEvent rows are immutable: an accepted public event may never be
--     UPDATEd, and a direct DELETE is refused while its owning table still
--     exists.
--   * TournamentEvent rows are immutable in the same way (owning tournament).
--   * GameActionRequest may transition from PROCESSING to a terminal status
--     exactly once, but its identity columns and its stored response are
--     frozen afterwards.
--   * Re-assertion of the ordering / state-fingerprint unique indexes present in
--     the generated baseline.
--
-- FK cascades (GameEvent -> Table, TournamentEvent -> Tournament,
-- GameActionRequest -> Table all use ON DELETE CASCADE) still delete their
-- children when the owning row is removed: the delete guards allow a DELETE
-- only when the owning row no longer exists, so a legitimate table/tournament
-- teardown succeeds while a direct child-row tamper is refused.
--
-- All statements are idempotent/guarded (DROP TRIGGER IF EXISTS then CREATE,
-- CREATE OR REPLACE FUNCTION, CREATE UNIQUE INDEX IF NOT EXISTS).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- GameEvent — immutable, strictly ordered public event stream
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION "guard_game_event_mutation"() RETURNS trigger AS $$
BEGIN
    IF TG_OP = 'UPDATE' THEN
        RAISE EXCEPTION 'GAME_EVENT_IMMUTABLE: GameEvent is append-only';
    END IF;
    -- DELETE is only permitted as part of the owning table's cascade.
    IF EXISTS (SELECT 1 FROM "Table" WHERE "id" = OLD."tableId") THEN
        RAISE EXCEPTION 'GAME_EVENT_IMMUTABLE: GameEvent is append-only';
    END IF;
    RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "GameEvent_immutable" ON "GameEvent";
CREATE TRIGGER "GameEvent_immutable"
    BEFORE UPDATE OR DELETE ON "GameEvent"
    FOR EACH ROW EXECUTE FUNCTION "guard_game_event_mutation"();

-- Re-assert the ordered-stream unique index (present in the baseline).
CREATE UNIQUE INDEX IF NOT EXISTS "GameEvent_tableId_eventSeq_key"
    ON "GameEvent" ("tableId", "eventSeq");

-- ---------------------------------------------------------------------------
-- GameActionRequest — durable idempotency: identity + stored response frozen
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION "guard_game_action_request_mutation"() RETURNS trigger AS $$
BEGIN
    IF NEW."tableId" <> OLD."tableId"
       OR NEW."requestId" <> OLD."requestId"
       OR NEW."principalId" <> OLD."principalId"
       OR NEW."turnId" <> OLD."turnId"
       OR NEW."actionId" <> OLD."actionId"
       OR NEW."expectedVersion" <> OLD."expectedVersion"
       OR NEW."requestHash" <> OLD."requestHash"
       OR NEW."createdAt" <> OLD."createdAt" THEN
        RAISE EXCEPTION 'GAME_ACTION_REQUEST_IMMUTABLE: identity columns may not change';
    END IF;
    -- Exactly one transition out of PROCESSING. A terminal record is frozen.
    IF OLD."status" <> 'PROCESSING' THEN
        RAISE EXCEPTION 'GAME_ACTION_REQUEST_IMMUTABLE: record % is already terminal', OLD."id";
    END IF;
    IF NEW."status" NOT IN ('PROCESSING', 'COMPLETED', 'REJECTED') THEN
        RAISE EXCEPTION 'GAME_ACTION_REQUEST_IMMUTABLE: invalid status %', NEW."status";
    END IF;
    -- Once a response has been recorded it can never be rewritten.
    IF OLD."response" IS NOT NULL AND NEW."response" IS DISTINCT FROM OLD."response" THEN
        RAISE EXCEPTION 'GAME_ACTION_REQUEST_IMMUTABLE: stored response is frozen';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "GameActionRequest_guard" ON "GameActionRequest";
CREATE TRIGGER "GameActionRequest_guard"
    BEFORE UPDATE ON "GameActionRequest"
    FOR EACH ROW EXECUTE FUNCTION "guard_game_action_request_mutation"();

-- ---------------------------------------------------------------------------
-- TournamentEvent — append-only, per-tournament ordered audit stream
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION "guard_tournament_event_mutation"() RETURNS trigger AS $$
BEGIN
    IF TG_OP = 'UPDATE' THEN
        RAISE EXCEPTION 'TOURNAMENT_EVENT_IMMUTABLE: TournamentEvent is append-only';
    END IF;
    -- DELETE is only permitted as part of the owning tournament's cascade.
    IF EXISTS (SELECT 1 FROM "Tournament" WHERE "id" = OLD."tournamentId") THEN
        RAISE EXCEPTION 'TOURNAMENT_EVENT_IMMUTABLE: TournamentEvent is append-only';
    END IF;
    RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "TournamentEvent_immutable" ON "TournamentEvent";
CREATE TRIGGER "TournamentEvent_immutable"
    BEFORE UPDATE OR DELETE ON "TournamentEvent"
    FOR EACH ROW EXECUTE FUNCTION "guard_tournament_event_mutation"();

-- Re-assert the per-tournament ordering + state-fingerprint unique indexes
-- (present in the generated baseline).
CREATE UNIQUE INDEX IF NOT EXISTS "TournamentEvent_tournamentId_eventSeq_key"
    ON "TournamentEvent" ("tournamentId", "eventSeq");
CREATE UNIQUE INDEX IF NOT EXISTS "TournamentEvent_tournamentId_stateFingerprint_key"
    ON "TournamentEvent" ("tournamentId", "stateFingerprint");
