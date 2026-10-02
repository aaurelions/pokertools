/**
 * Canonical EIP-712 withdrawal signing/recovery.
 *
 * The typed-data shape, field order and domain validation all come from
 * `@pokertools/types` canonical finance contracts; this module only adapts them
 * to viem. Domain is bound to:
 *   name = "PokerTools Withdrawal", version = "1", chainId, verifyingContract
 * (verifyingContract = the treasury custody contract/address for that chain).
 */
import {
  Eip712DomainSchema,
  WithdrawalIntentSchema,
  withdrawalIntentTypedData,
  type Eip712Domain,
  type WithdrawalIntent,
} from "@pokertools/types";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { recoverTypedDataAddress, type Address, type Hex } from "viem";

/** Any object that can EIP-712-sign (viem local/HDAccount or similar). */
export interface TypedDataSigner {
  readonly address: Address;
  signTypedData(args: never): Promise<Hex>;
}

export const WITHDRAWAL_DOMAIN_NAME = "PokerTools Withdrawal";
export const WITHDRAWAL_DOMAIN_VERSION = "1";

export function buildWithdrawalDomain(chainId: number, verifyingContract: Address): Eip712Domain {
  return Eip712DomainSchema.parse({
    name: WITHDRAWAL_DOMAIN_NAME,
    version: WITHDRAWAL_DOMAIN_VERSION,
    chainId,
    // Canonical wire addresses are lowercase; viem returns checksummed ones.
    verifyingContract: verifyingContract.toLowerCase(),
  });
}

/** viem-shaped typed data built from the canonical intent. */
export function withdrawalTypedData(intent: WithdrawalIntent, domain: Eip712Domain) {
  const typed = withdrawalIntentTypedData(intent, domain);
  return {
    domain: typed.domain,
    types: typed.types,
    primaryType: typed.primaryType,
    message: typed.message,
  } as const;
}

export async function signWithdrawalIntent(
  intent: WithdrawalIntent,
  domain: Eip712Domain,
  privateKey: Hex | PrivateKeyAccount | TypedDataSigner
): Promise<Hex> {
  const parsedIntent = WithdrawalIntentSchema.parse(intent);
  const parsedDomain = Eip712DomainSchema.parse(domain);
  const account =
    typeof privateKey === "string"
      ? privateKeyToAccount(privateKey)
      : (privateKey as PrivateKeyAccount | TypedDataSigner);
  const typed = withdrawalTypedData(parsedIntent, parsedDomain);
  return account.signTypedData({
    domain: typed.domain,
    types: typed.types,
    primaryType: typed.primaryType,
    message: typed.message,
  } as never);
}

export async function recoverWithdrawalSigner(
  intent: WithdrawalIntent,
  domain: Eip712Domain,
  signature: Hex
): Promise<Address> {
  const typed = withdrawalTypedData(
    WithdrawalIntentSchema.parse(intent),
    Eip712DomainSchema.parse(domain)
  );
  return recoverTypedDataAddress({
    domain: typed.domain,
    types: typed.types,
    primaryType: typed.primaryType,
    message: typed.message,
    signature,
  } as Parameters<typeof recoverTypedDataAddress>[0]);
}

/**
 * Real local custody signer for acceptance. Implements the workflow's injected
 * signer port with the canonical typed-data shape over an Anvil test key.
 */
export function createLocalTreasurySigner(privateKey: Hex) {
  const account = privateKeyToAccount(privateKey);
  return {
    address: account.address,
    signWithdrawal: (intent: WithdrawalIntent, domain: Eip712Domain) =>
      signWithdrawalIntent(intent, domain, account),
  };
}
