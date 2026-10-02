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
} from "../canonical/rest";

export type LoginRequest = LoginRequestWire;
export type LoginResponse = LoginResponseWire;
export type NonceResponse = NonceResponseWire;
export type LogoutResponse = LogoutResponseWire;
