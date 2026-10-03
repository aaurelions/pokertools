import {
  ProvisionServicePrincipalRequestSchema,
  ProvisionedServicePrincipalSchema,
  RevokeServicePrincipalDelegationRequestSchema,
  RevokeServicePrincipalDelegationResponseSchema,
  RotateServiceCredentialRequestSchema,
  ServiceCredentialRefSchema,
} from "../src/canonical/service-principal";
import { CreateServiceCredentialRequestSchema } from "../src/canonical/rest";

describe("service principal provisioning contracts", () => {
  it("accepts a named principal provisioned for an orchestration delegate", () => {
    const parsed = ProvisionServicePrincipalRequestSchema.parse({
      name: "agent-1",
      delegatedToPrincipalId: "orchestrator-1",
    });
    expect(parsed.delegatedToPrincipalId).toBe("orchestrator-1");
  });

  it("rejects invalid principal names", () => {
    expect(ProvisionServicePrincipalRequestSchema.safeParse({ name: "" }).success).toBe(false);
    expect(ProvisionServicePrincipalRequestSchema.safeParse({ name: "a$b" }).success).toBe(false);
  });

  it("projects a durable SERVICE principal without a wallet address", () => {
    const parsed = ProvisionedServicePrincipalSchema.parse({
      principalId: "principal-svc-1",
      name: "agent-1",
      kind: "SERVICE",
      delegatedToPrincipalId: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    expect(parsed.kind).toBe("SERVICE");
    expect(JSON.stringify(parsed)).not.toContain("address");
  });

  it("accepts issuing a credential for an existing principal id", () => {
    const parsed = CreateServiceCredentialRequestSchema.parse({
      principalId: "principal-svc-1",
      name: "room-1-seat-3",
      scopes: ["table:observe", "table:act", "table:chat"],
      tableId: "table-1",
      seat: 3,
    });
    expect(parsed.principalId).toBe("principal-svc-1");
  });

  it("rejects a scope mix and unbound table grants at the contract boundary", () => {
    // The contract itself now enforces the shape the API must refuse: an
    // orchestration credential is never table-capable, and every table
    // credential is resource-bound.
    expect(
      CreateServiceCredentialRequestSchema.safeParse({
        name: "mixed",
        scopes: ["table:act", "competition:orchestrate"],
      }).success
    ).toBe(false);
    expect(
      CreateServiceCredentialRequestSchema.safeParse({
        name: "unbound",
        scopes: ["table:act"],
      }).success
    ).toBe(false);
    expect(
      CreateServiceCredentialRequestSchema.safeParse({
        name: "orchestration-with-table",
        scopes: ["competition:orchestrate"],
        tableId: "table-1",
      }).success
    ).toBe(false);
    expect(
      CreateServiceCredentialRequestSchema.safeParse({
        name: "bound",
        scopes: ["table:act"],
        tableId: "table-1",
      }).success
    ).toBe(true);
    expect(
      CreateServiceCredentialRequestSchema.safeParse({
        name: "orchestrator",
        scopes: ["competition:orchestrate"],
      }).success
    ).toBe(true);
  });

  it("parses rotation and credential reference responses", () => {
    expect(RotateServiceCredentialRequestSchema.parse({}).expiresAt).toBeUndefined();
    expect(
      ServiceCredentialRefSchema.parse({
        credentialId: "cred-1",
        principalId: "principal-svc-1",
        tableId: "table-1",
        seat: 3,
        revoked: false,
        expiresAt: null,
      }).credentialId
    ).toBe("cred-1");
  });

  it("accepts an empty strict delegation-revoke body and rejects unknown fields", () => {
    expect(RevokeServicePrincipalDelegationRequestSchema.safeParse({}).success).toBe(true);
    expect(RevokeServicePrincipalDelegationRequestSchema.safeParse({ force: true }).success).toBe(
      false
    );
  });

  it("parses the durable delegation revocation response", () => {
    const parsed = RevokeServicePrincipalDelegationResponseSchema.parse({
      success: true,
      servicePrincipalId: "principal-svc-1",
      delegatePrincipalId: "orchestrator-1",
      revokedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(parsed.servicePrincipalId).toBe("principal-svc-1");
    expect(parsed.revokedAt).toBe("2026-01-01T00:00:00.000Z");
  });
});
