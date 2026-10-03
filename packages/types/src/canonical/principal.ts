import { z } from "zod";
import { PrincipalIdSchema, AnyEvmAddressSchema } from "./primitives";

/**
 * Canonical principal contracts.
 *
 * The **public** principal is exactly `{id, kind, walletAddress}`. Richer
 * authorization context (operator role, credential restrictions) is internal to
 * the API's authenticated-principal layer and is deliberately not part of this
 * package's wire surface.
 *
 * A principal is:
 * - `WALLET`: a chain-signing end user bound to a wallet address
 * - `SERVICE`: a non-wallet service account with explicit scoped credentials
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
 *   table protocol only, and every table credential must be resource-bound to a
 *   non-empty `tableId`: a SERVICE credential can never be a wildcard across
 *   rooms. A bound credential may only reach its own room via
 *   `GET /tables/:id`; the global table collection stays denied to SERVICE.
 * - `competition:orchestrate` is a narrow provisioning capability: it may create
 *   and provision competitions and issue table-scoped agent credentials for
 *   their SERVICE entrants. It is exclusive with table scopes, never carries a
 *   resource restriction, and can never carry finance, custody or operator
 *   authority.
 */
export const ServiceScopeSchema = z.enum([
  "table:observe",
  "table:act",
  "table:chat",
  "competition:orchestrate",
]);
export type ServiceScope = z.infer<typeof ServiceScopeSchema>;

/** Operator authority is only ever held by an explicitly ADMIN wallet. */
export const PrincipalRoleSchema = z.enum(["PLAYER", "ADMIN"]);
export type PrincipalRole = z.infer<typeof PrincipalRoleSchema>;
