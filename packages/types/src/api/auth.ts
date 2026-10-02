/**
 * Auth wire DTOs.
 *
 * These are aliases of the canonical runtime schemas in `canonical/rest.ts`, so
 * the API and SDK share one strict contract with runtime validation. They are
 * no longer hand-rolled interfaces.
 */

import type {
  LoginRequestWire,
  LoginResponseWire,
  LogoutResponseWire,
  NonceResponseWire,
  CredentialIdWire,
  CreateServiceCredentialRequestWire,
  CreatedServiceCredentialWire,
  ServiceCredentialSummaryWire,
  ListServiceCredentialsResponseWire,
  RevokeServiceCredentialResponseWire,
} from "../canonical/rest";

export type LoginRequest = LoginRequestWire;
export type LoginResponse = LoginResponseWire;
export type NonceResponse = NonceResponseWire;
export type LogoutResponse = LogoutResponseWire;

/** Opaque service credential id minted by the operator-only credential routes. */
export type CredentialId = CredentialIdWire;

/** `POST /auth/service-credentials` (operator-only, ADMIN wallet). */
export type CreateServiceCredentialRequest = CreateServiceCredentialRequestWire;

/** `POST /auth/service-credentials` response; carries the one-time plaintext token. */
export type CreatedServiceCredential = CreatedServiceCredentialWire;

/** `GET /auth/service-credentials` row; never carries the plaintext token. */
export type ServiceCredentialSummary = ServiceCredentialSummaryWire;

export type ListServiceCredentialsResponse = ListServiceCredentialsResponseWire;
export type RevokeServiceCredentialResponse = RevokeServiceCredentialResponseWire;
