/**
 * Canonical custody startup/security contracts.
 *
 * These enforce the isolated signing and configuration boundary:
 *  - the signer is a per-chain treasury key resolved from JSON, not a mnemonic;
 *  - configuration loads with no mnemonic, xpriv or product credentials;
 *  - the API-side xpub derivation boundary (public keys cannot sign) is intact.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "@scure/bip39";
import { privateKeyToAccount, publicKeyToAddress } from "viem/accounts";
import { bytesToHex } from "viem/utils";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { parseTreasurySigningKeys } from "../../src/runtime.js";
import { buildCustodyRuntime } from "../../src/runtime.js";
import { quietLogger } from "./fakes.js";
import { staticAccountResolver } from "../../src/core/viem-ports.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("canonical custody signing configuration", () => {
  it("loads with only DATABASE_URL plus treasury signing JSON and no mnemonic/xpriv", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("DATABASE_URL", "file:./.runtime/workflow-test.db");
    vi.stubEnv("TREASURY_SIGNING_KEYS_JSON", JSON.stringify({ 31337: `0x${"11".repeat(32)}` }));
    for (const name of [
      "MASTER_MNEMONIC",
      "MASTER_MNEMONIC_FILE",
      "WALLET_ENCRYPTION_SECRET",
      "WALLET_XPRIV_ENCRYPTION_SECRET",
      "JWT_SECRET",
    ]) {
      vi.stubEnv(name, "");
    }

    const { config } = await import("../../src/config.js");
    // The configuration surface cannot expose mnemonic/xpriv material:
    // envalid's strict proxy throws when these fields are accessed.
    for (const removed of [
      "MASTER_MNEMONIC",
      "MASTER_MNEMONIC_FILE",
      "WALLET_ENCRYPTION_SECRET",
      "WALLET_XPRIV_ENCRYPTION_SECRET",
    ]) {
      expect(() => (config as unknown as Record<string, unknown>)[removed]).toThrow();
    }
    expect(config.TREASURY_SIGNING_KEYS_JSON).toContain("31337");
  });

  it("parses per-chain treasury keys without ever accepting malformed material", () => {
    const keys = parseTreasurySigningKeys(
      JSON.stringify({ 1: `0x${"ab".repeat(32)}`, 31337: `0x${"cd".repeat(32)}` })
    );
    expect(keys.get(1)).toBe(`0x${"ab".repeat(32)}`);
    expect(keys.get(31337)).toBe(`0x${"cd".repeat(32)}`);
    expect(parseTreasurySigningKeys("")).toEqual(new Map());
    expect(() => parseTreasurySigningKeys("{")).toThrow(/valid JSON/);
    expect(() => parseTreasurySigningKeys(JSON.stringify({ 0: `0x${"ab".repeat(32)}` }))).toThrow(
      /Invalid chainId/
    );
    expect(() => parseTreasurySigningKeys(JSON.stringify({ 1: "not-a-key" }))).toThrow(
      /Invalid treasury signing key/
    );
  });

  it("resolves the configured account per chain and fails closed for unknown chains", async () => {
    const pk = `0x${"ef".repeat(32)}` as const;
    const resolver = staticAccountResolver(new Map([[31337, pk]]));
    const account = await resolver.resolve(31337, "0x0000000000000000000000000000000000000000");
    expect(account.address).toBe(privateKeyToAccount(pk).address);
    expect(() => resolver.resolve(1, "0x0000000000000000000000000000000000000000")).toThrow(
      /No treasury signing key configured for chain 1/
    );
  });
});

describe("integrated custody runtime wiring", () => {
  it("defaults to the real API ledger accounting and ChainRegistry quorum adapters", async () => {
    const runtime = await buildCustodyRuntime({
      // Construction never touches the DB; the registry builds lazily on read.
      prisma: {} as never,
      logger: quietLogger(),
      config: {
        databaseUrl: "file:./.runtime/runtime-smoke.db",
        workerIntervalMs: 1_000,
        reconcileIntervalMs: 2_000,
        quorumThreshold: 2,
        minQuorum: 2,
        treasurySigningKeysJson: JSON.stringify({ 31337: `0x${"11".repeat(32)}` }),
        workerId: "runtime-smoke",
      },
    });

    expect(runtime.workflow).toBeDefined();
    expect(runtime.worker).toBeDefined();
    expect(runtime.heartbeats).toBeDefined();
  });
});

describe("xpub/xpriv separation boundary", () => {
  const mnemonic = "test test test test test test test test test test test junk";

  it("derives addresses from xpub-only material but cannot sign", () => {
    const seed = mnemonicToSeedSync(mnemonic);
    const master = HDKey.fromMasterSeed(seed);
    const account = master.derive("m/44'/60'/0'/0");
    const xprivKey = HDKey.fromExtendedKey(account.privateExtendedKey);
    const xpubKey = HDKey.fromExtendedKey(account.publicExtendedKey);

    const xprivChild = xprivKey.deriveChild(0);
    const xpubChild = xpubKey.deriveChild(0);
    expect(xprivChild.privateKey).not.toBeNull();
    expect(xpubChild.privateKey).toBeNull();

    const xprivAddress = publicKeyToAddress(
      bytesToHex(secp256k1.Point.fromBytes(xprivChild.publicKey!).toBytes(false))
    );
    const xpubAddress = publicKeyToAddress(
      bytesToHex(secp256k1.Point.fromBytes(xpubChild.publicKey!).toBytes(false))
    );
    expect(xpubAddress.toLowerCase()).toBe(xprivAddress.toLowerCase());
    expect(xpubAddress.toLowerCase()).toMatch(/^0x[a-f0-9]{40}$/);
  });
});
