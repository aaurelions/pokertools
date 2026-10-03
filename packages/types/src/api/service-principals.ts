/**
 * Service-principal provisioning DTOs.
 *
 * Aliases of the canonical runtime schemas in `canonical/service-principal.ts`;
 * the durable-identity, delegation and rotation model is documented there.
 */

export type {
  ProvisionServicePrincipalRequest,
  ProvisionedServicePrincipal,
  RevokeServicePrincipalDelegationRequest,
  RevokeServicePrincipalDelegationResponse,
  RotateServiceCredentialRequest,
  ServiceCredentialRef,
  ServicePrincipalDelegation,
} from "../canonical/service-principal";

export {
  ProvisionServicePrincipalRequestSchema,
  ProvisionedServicePrincipalSchema,
  RevokeServicePrincipalDelegationRequestSchema,
  RevokeServicePrincipalDelegationResponseSchema,
  RotateServiceCredentialRequestSchema,
  ServiceCredentialRefSchema,
  ServicePrincipalDelegationSchema,
} from "../canonical/service-principal";
