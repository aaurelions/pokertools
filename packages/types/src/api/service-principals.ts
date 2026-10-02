/**
 * Service-principal provisioning DTOs.
 *
 * Aliases of the canonical runtime schemas in `canonical/service-principal.ts`;
 * the durable-identity, delegation and rotation model is documented there.
 */

export type {
  ProvisionServicePrincipalRequest,
  ProvisionedServicePrincipal,
  RotateServiceCredentialRequest,
  ServiceCredentialRef,
  ServicePrincipalDelegation,
} from "../canonical/service-principal";

export {
  ProvisionServicePrincipalRequestSchema,
  ProvisionedServicePrincipalSchema,
  RotateServiceCredentialRequestSchema,
  ServiceCredentialRefSchema,
  ServicePrincipalDelegationSchema,
} from "../canonical/service-principal";
