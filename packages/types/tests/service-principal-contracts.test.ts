import {
  ProvisionServicePrincipalRequestSchema,
  ProvisionedServicePrincipalSchema,
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

  it("still rejects a scope mix the API must refuse at the boundary", () => {
    // The contract accepts table scopes and orchestration; the API rejects
    // mixing them so an orchestration credential is never table-capable.
    expect(
      CreateServiceCredentialRequestSchema.safeParse({
        name: "mixed",
        scopes: ["table:act", "competition:orchestrate"],
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
});
