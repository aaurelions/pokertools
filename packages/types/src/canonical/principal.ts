import { z } from "zod";
import {
  IdSchema,
  PrincipalIdSchema,
  TableIdSchema,
  AnyEvmAddressSchema,
  EpochSecondsSchema,
} from "./primitives";

/**
 * Canonical principal / service-credential contracts.
 *
 * The **public** principal is exactly `{id, kind, walletAddress}`. Richer
 * authorization context (role, scopes/restrictions, service credential) lives
 * only in {@link AuthContextSchema}, so internal authority never leaks into the
 * public principal wire shape.
 *
 * A principal is:
 * - `WALLET`: a chain-signing end user bound to a wallet address
 * - `SERVICE`: a non-wallet service account with explicit table-scoped grants
 *
 * The wire never lets a caller choose its own actor identity; requests carry
 * only resource identifiers and opaque action ids.
 */

export const PrincipalKindSchema = z.enum(["WALLET", "SERVICE"]);
export type PrincipalKind = z.infer<typeof PrincipalKindSchema>;

export const PrincipalSchema = z
  .strictObject({
    id: PrincipalIdSchema,
    kind: PrincipalKindSchema,
    walletAddress: AnyEvmAddressSchema.nullable(),
  })
  .superRefine((principal, ctx) => {
    if (principal.kind === "WALLET" && principal.walletAddress === null) {
      ctx.addIssue({
        code: "custom",
        path: ["walletAddress"],
        message: "WALLET principal requires a wallet address",
      });
    }
    if (principal.kind === "SERVICE" && principal.walletAddress !== null) {
      ctx.addIssue({
        code: "custom",
        path: ["walletAddress"],
        message: "SERVICE principal must not carry a wallet address",
      });
    }
  });
export type Principal = z.infer<typeof PrincipalSchema>;

/**
 * Scoped service capabilities.
 *
 * - Table scopes (`table:act` implies `table:observe`) authorize the canonical
 *   table protocol only.
 * - `competition:orchestrate` is a narrow provisioning grant: it may create and
 *   provision competitions and issue table-scoped agent credentials for their
 *   SERVICE entrants. It is exclusive with table scopes and can never carry
 *   finance, custody or operator authority.
 */
export const ServiceScopeSchema = z.enum([
  "table:observe",
  "table:act",
  "table:chat",
  "competition:orchestrate",
]);
export type ServiceScope = z.infer<typeof ServiceScopeSchema>;

/**
 * Optional resource restriction for a grant, mirroring the API's
 * `PrincipalRestrictions`. `null` (or an absent field) means unrestricted on
 * that dimension.
 */
export const ServiceResourceRestrictionSchema = z.strictObject({
  tableId: TableIdSchema.nullable(),
  seat: z.number().int().min(0).max(9).nullable(),
});
export type ServiceResourceRestriction = z.infer<typeof ServiceResourceRestrictionSchema>;

/** A single scope grant with an optional table/seat resource restriction. */
export const ServiceGrantSchema = z.strictObject({
  scope: ServiceScopeSchema,
  restriction: ServiceResourceRestrictionSchema.optional(),
});
export type ServiceGrant = z.infer<typeof ServiceGrantSchema>;

/** A SERVICE principal's credential: principal id, grants and expiry. */
export const ServiceCredentialSchema = z
  .strictObject({
    principalId: PrincipalIdSchema,
    grants: z.array(ServiceGrantSchema).min(1),
    expiresAt: EpochSecondsSchema,
  })
  .superRefine((credential, ctx) => {
    const seen = new Set<string>();
    for (let i = 0; i < credential.grants.length; i++) {
      const grant = credential.grants[i];
      const key = `${grant.scope}::${grant.restriction?.tableId ?? "*"}::${
        grant.restriction?.seat ?? "*"
      }`;
      if (seen.has(key)) {
        ctx.addIssue({ code: "custom", path: ["grants", i], message: "Duplicate service grant" });
      }
      seen.add(key);
    }
  });
export type ServiceCredential = z.infer<typeof ServiceCredentialSchema>;

/** Operator authority is only ever held by an explicitly ADMIN wallet. */
export const PrincipalRoleSchema = z.enum(["PLAYER", "ADMIN"]);
export type PrincipalRole = z.infer<typeof PrincipalRoleSchema>;

/**
 * Resolved request context after authentication (internal, richer).
 *
 * The public {@link Principal} stays three fields; role, restrictions and the
 * service credential are attached here. SERVICE principals can never hold an
 * operator role or finance authority.
 */
export const AuthContextSchema = z
  .strictObject({
    principal: PrincipalSchema,
    sessionId: IdSchema,
    issuedAt: EpochSecondsSchema,
    expiresAt: EpochSecondsSchema,
    role: PrincipalRoleSchema.nullable(),
    serviceCredential: ServiceCredentialSchema.nullable(),
    restrictions: ServiceResourceRestrictionSchema.nullable(),
  })
  .superRefine((context, ctx) => {
    if (context.principal.kind === "WALLET") {
      if (context.serviceCredential !== null) {
        ctx.addIssue({
          code: "custom",
          path: ["serviceCredential"],
          message: "WALLET principal must not carry a service credential",
        });
      }
      return;
    }
    if (context.serviceCredential === null) {
      ctx.addIssue({
        code: "custom",
        path: ["serviceCredential"],
        message: "SERVICE principal requires a service credential",
      });
      return;
    }
    if (context.role !== null) {
      ctx.addIssue({
        code: "custom",
        path: ["role"],
        message: "SERVICE principal must not hold an operator role",
      });
    }
    if (context.serviceCredential.principalId !== context.principal.id) {
      ctx.addIssue({
        code: "custom",
        path: ["serviceCredential", "principalId"],
        message: "service credential must belong to the principal",
      });
    }
  });
export type AuthContext = z.infer<typeof AuthContextSchema>;
