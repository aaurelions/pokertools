/**
 * Redis client compatibility bridge.
 *
 * The API runs a single ioredis 6 client and shares that exact instance with
 * BullMQ 6 (queues/workers) and Redlock 4. BullMQ 6's `ConnectionOptions`
 * already accepts ioredis 6's `Redis` structurally, so no conversion is needed
 * there and workers pass the client directly. Redlock's typings, however, do
 * not overlap with ioredis, so this module owns that one conversion.
 *
 * Installed versions observed when this module was authored:
 *   - ioredis ^6.0.0
 *   - bullmq ^6.3.11
 *   - redlock ^4.2.0 (@types/redlock ^4.0.8)
 *
 * Mismatch detail:
 *   - Redlock's `CompatibleRedisClient` declares callback-style, array-form
 *     `eval(args, callback?)`, while ioredis 6 exposes varargs `eval(script,
 *     numkeys, ...)`. The runtime call Redlock makes is accepted by ioredis, but
 *     the declared signatures do not overlap, so this assertion is unavoidable
 *     and is confined to this module.
 *
 * The conversion is identity-preserving: callers receive the same client
 * instance, so connection, retry and lock settings are unchanged.
 */

import type { Redis } from "ioredis";
import type Redlock from "redlock";

/**
 * Present an ioredis client as a Redlock-compatible client.
 *
 * ioredis declares varargs `eval(script, numkeys, ...)` whereas Redlock's
 * typings expect `eval(args: EvalArg[], callback?)`. The shapes do not overlap
 * in the type system even though ioredis accepts Redlock's runtime call, so the
 * `unknown` bridge is unavoidable and centralized here. Returns the same
 * instance.
 */
export function asRedlockClient(client: Redis): Redlock.CompatibleRedisClient {
  return client as unknown as Redlock.CompatibleRedisClient;
}
