import { z } from "zod";
import { IdSchema, PrincipalIdSchema } from "./primitives";
import { PrincipalKindSchema } from "./principal";

/**
 * Service-principal provisioning and credential lifecycle contracts.
 *
 * A durable SERVICE **principal** is a `User` row of kind `SERVICE` with no
 * wallet address. It is the stable identity referenced by rosters, seats and
 * audit records. Credentials are separate, revocable secrets attached to that
 * principal:
 *
 * - a principal may hold multiple concurrently valid credentials (one per
 *   room/table), so an agent can participate in simultaneous competitions;
 * - minting a credential for an existing `principalId` never creates a new
 *   principal;
 * - rotation re-keys one credential in place and never changes `principalId`;
 * - callers can persist only the opaque `credentialId` (for metadata/revoke)
 *   and keep the plaintext `token` in memory.
 *
 * Delegation prevents hijack: an operator may delegate a SERVICE principal to
 * an orchestration principal, and an orchestrator may only provision rosters
 * from, and issue agent credentials for, principals delegated to it. The
 * orchestrator can never mint a credential for an arbitrary SERVICE principal.
 *
 * An operator may revoke that delegation at any time. Revocation is durable and
 * blocks all future roster/credential issuance for the principal, but it
 * deliberately does not revoke the principal or its already-issued table
 * credentials. Re-delegation/reassignment is not supported: a different
 * orchestration owner requires a newly provisioned principal.
 */

/** `POST /auth/service-principals` (operator-only). */
export const ProvisionServicePrincipalRequestSchema = z.strictObject({
  /** Durable display name for the principal. */
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9 _.:-]+$/, "Invalid service principal name"),
  /**
   * Optional orchestration delegation. When present, that principal may
   * provision this SERVICE principal into its competitions and issue
   * table-scoped credentials for it.
   */
  delegatedToPrincipalId: PrincipalIdSchema.optional(),
});
export type ProvisionServicePrincipalRequest = z.infer<
  typeof ProvisionServicePrincipalRequestSchema
>;

export const ProvisionedServicePrincipalSchema = z.strictObject({
  principalId: PrincipalIdSchema,
  name: z.string().min(1).max(64),
  kind: z.literal(PrincipalKindSchema.enum.SERVICE),
  delegatedToPrincipalId: PrincipalIdSchema.nullable(),
  createdAt: z.string().datetime(),
});
export type ProvisionedServicePrincipal = z.infer<typeof ProvisionedServicePrincipalSchema>;

/**
 * `POST /auth/service-credentials/:id/rotate` (operator-only).
 *
 * Rotation re-keys the credential in place: the durable principal and its
 * scopes/table/seat restrictions are preserved (this route cannot change them).
 * `expiresAt` must be in the future when supplied; omitting it preserves the
 * current expiry. An already-expired credential requires a new future
 * `expiresAt` to be rotated. Concurrent rotations race on the stored secret
 * digest: exactly one wins, the losers get 409.
 */
export const RotateServiceCredentialRequestSchema = z.strictObject({
  expiresAt: z.string().datetime().optional(),
});
export type RotateServiceCredentialRequest = z.infer<typeof RotateServiceCredentialRequestSchema>;

/** Authorization outcome for an orchestration principal over a SERVICE principal. */
export const ServicePrincipalDelegationSchema = z.strictObject({
  servicePrincipalId: PrincipalIdSchema,
  delegatePrincipalId: PrincipalIdSchema,
  revokedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
});
export type ServicePrincipalDelegation = z.infer<typeof ServicePrincipalDelegationSchema>;

/**
 * `POST /auth/service-principals/:id/delegation/revoke` request (operator-only,
 * ADMIN wallet). The delegation is identified by the path principal id; the
 * body is an empty strict object so unknown fields are rejected.
 *
 * Revocation is durable and idempotent. It blocks the delegate from rostering
 * the principal into new competitions or issuing further agent credentials for
 * it. Policy: it never revokes the principal or any already-issued table
 * credential — those keep working until they expire or are explicitly revoked.
 * Re-delegation/reassignment is not supported; provision a new principal and
 * delegation if a different orchestration principal must own it.
 *
 * Operator-only endpoints are intentionally asymmetric with the regular SDK
 * client surface: embedding them is a deliberate operator integration choice,
 * never a gameplay capability.
 */
export const RevokeServicePrincipalDelegationRequestSchema = z.strictObject({});
export type RevokeServicePrincipalDelegationRequest = z.infer<
  typeof RevokeServicePrincipalDelegationRequestSchema
>;

/** `POST /auth/service-principals/:id/delegation/revoke` response. */
export const RevokeServicePrincipalDelegationResponseSchema = z.strictObject({
  success: z.literal(true),
  servicePrincipalId: PrincipalIdSchema,
  delegatePrincipalId: PrincipalIdSchema,
  /** First revocation time; stable across idempotent repeats. */
  revokedAt: z.string().datetime(),
});
export type RevokeServicePrincipalDelegationResponse = z.infer<
  typeof RevokeServicePrincipalDelegationResponseSchema
>;

/** Opaque credential reference returned to callers (never the plaintext). */
export const ServiceCredentialRefSchema = z.strictObject({
  credentialId: IdSchema,
  principalId: PrincipalIdSchema,
  tableId: IdSchema.nullable(),
  seat: z.number().int().min(0).max(9).nullable(),
  revoked: z.boolean(),
  expiresAt: z.string().datetime().nullable(),
});
export type ServiceCredentialRef = z.infer<typeof ServiceCredentialRefSchema>;
