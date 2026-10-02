/**
 * Deposit claim acceptance: exact on-chain log verification via the REAL
 * canonical `createCanonicalDepositVerifier` (asset-backed) against live Anvil.
 *
 * Direction is the canonical direct-treasury deposit: the authenticated WALLET
 * sends the ERC-20 to the asset treasury, and the exact
 * `(txHash, logIndex)` is verified against quorum RPC reads.
 *
 * Positive: a direct-treasury ERC-20 transfer is verified from its exact
 * `(txHash, logIndex)`, including one transaction that emits multiple logs.
 * Negative: wrong chain, wrong token, wrong sender, wrong recipient, missing
 * log and insufficient confirmations are all rejected with the canonical
 * machine reasons. Amounts are always the real on-chain values.
 *
 * Confirmation depth follows the chosen convention: blocks *including* the
 * inclusion block are counted (`head - receiptBlock + 1`).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseUnits, type Address } from "viem";
import { ChainRegistry } from "../../../api/src/services/chain-registry.js";
import { createCanonicalDepositVerifier } from "../../../api/src/services/canonical-deposit-verifier.js";
import {
  attachTwoChainAnvil,
  batchTransferFrom,
  CHAIN_A_ID,
  CHAIN_B_ID,
  deployMockAssetToken,
  deployMockUsdc6,
  findTransferLogs,
  getAccount,
  mine,
  mintToken,
  transferToken,
  type DeployedToken,
  type LocalChain,
} from "./helpers/anvil-two-chain.js";
import { startQuorumProxies, type ProxySet } from "./helpers/quorum-proxy.js";

const TREASURY_INDEX = 0;
const ALICE_INDEX = 11;
const STRANGER_INDEX = 1;

interface AssetLookup {
  id: string;
  chainId: number;
  tokenAddress: string;
  treasuryAddress: string;
  confirmations: number;
  status: string;
}

/** Minimal Prisma surface the real verifier reads (asset lookup only). */
function assetLookup(resolve: (assetId: string) => AssetLookup | null) {
  return {
    asset: {
      findUnique: async ({ where }: { where: { id: string } }) => resolve(where.id),
    },
  } as never;
}

describe("deposit claim verification acceptance (real verifier + Anvil)", () => {
  let chainA: LocalChain;
  let usdc: DeployedToken;
  let otherToken: DeployedToken;
  let batchToken: DeployedToken;
  let proxies: ProxySet;
  let registry: ChainRegistry;
  const alice = getAccount(ALICE_INDEX).address.toLowerCase();
  const treasury = getAccount(TREASURY_INDEX).address.toLowerCase();

  /** viem caches block height for the 4s polling interval; let it expire. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 4_300));

  beforeAll(async () => {
    ({ chainA } = await attachTwoChainAnvil());
    usdc = await deployMockUsdc6(chainA);
    otherToken = await deployMockAssetToken(chainA, "FAKE", 6);
    batchToken = await deployMockAssetToken(chainA, "BATCH", 6);
    proxies = await startQuorumProxies(chainA.rpcUrl, 2);
    registry = new ChainRegistry({
      endpoints: proxies.proxies.map((proxy, index) => ({
        id: `a${index}`,
        chainId: CHAIN_A_ID,
        url: proxy.url,
      })),
      quorum: 2,
    });
    await registry.start();
  });

  afterAll(async () => {
    await proxies.close();
  });

  function verifier(
    token: DeployedToken,
    overrides: { confirmations?: number; status?: string } = {}
  ) {
    const record: AssetLookup = {
      id: `eip155:${CHAIN_A_ID}/erc20:${token.address.toLowerCase()}`,
      chainId: CHAIN_A_ID,
      tokenAddress: token.address.toLowerCase(),
      treasuryAddress: treasury,
      confirmations: overrides.confirmations ?? 1,
      status: overrides.status ?? "ACTIVE",
    };
    return createCanonicalDepositVerifier({
      prisma: assetLookup((assetId) => (assetId === record.id ? record : null)),
      getRegistry: async () => registry,
    });
  }

  function inputFor(
    token: DeployedToken,
    txHash: `0x${string}`,
    logIndex: number,
    walletAddress = alice,
    chainId = CHAIN_A_ID
  ) {
    return {
      assetId: `eip155:${CHAIN_A_ID}/erc20:${token.address.toLowerCase()}`,
      chainId,
      txHash,
      logIndex,
      principalId: "alice",
      walletAddress,
    };
  }

  it("verifies an exact direct-treasury deposit and returns the real on-chain amount", async () => {
    const amount = parseUnits("100", 6);
    await mintToken(chainA, usdc.address, alice as Address, amount);
    const receipt = await transferToken(
      chainA,
      usdc.address,
      ALICE_INDEX,
      treasury as Address,
      amount
    );
    const [log] = findTransferLogs(receipt, usdc.address, {
      from: alice as Address,
      to: treasury as Address,
    });
    await mine(chainA, 1);
    await settle();

    const result = await verifier(usdc)(inputFor(usdc, log.txHash, log.logIndex));
    expect(result.verified).toBe(true);
    expect(result.amountAtomic).toBe(amount.toString());
    expect(result.provenance).toBe("DIRECT_TREASURY");
    expect(result.blockHash).toBe(log.blockHash);
    expect(result.confirmations).toBeGreaterThanOrEqual(1);
  });

  it("verifies each exact log when one wallet transaction emits multiple deposit logs", async () => {
    const amount = parseUnits("2", 6);
    await mintToken(chainA, batchToken.address, alice as Address, amount * 2n);
    const receipt = await batchTransferFrom(
      chainA,
      batchToken.address,
      ALICE_INDEX,
      [treasury as Address, treasury as Address],
      [amount, amount]
    );
    const logs = findTransferLogs(receipt, batchToken.address, {
      from: alice as Address,
      to: treasury as Address,
    });
    expect(logs).toHaveLength(2);
    await mine(chainA, 1);
    await settle();

    for (const log of logs) {
      const result = await verifier(batchToken)(
        inputFor(batchToken, receipt.transactionHash, log.logIndex)
      );
      expect(result.verified).toBe(true);
      expect(result.amountAtomic).toBe(amount.toString());
    }
  });

  it("rejects a claim for a different chain", async () => {
    const amount = parseUnits("1", 6);
    await mintToken(chainA, usdc.address, alice as Address, amount);
    const receipt = await transferToken(
      chainA,
      usdc.address,
      ALICE_INDEX,
      treasury as Address,
      amount
    );
    const [log] = findTransferLogs(receipt, usdc.address, { value: amount });

    const result = await verifier(usdc)(
      inputFor(usdc, log.txHash, log.logIndex, alice, CHAIN_B_ID)
    );
    expect(result.verified).toBe(false);
    expect(result.reason).toBe("ASSET_MISMATCH");
  });

  it("rejects a log emitted by a different token", async () => {
    const amount = parseUnits("1", 6);
    await mintToken(chainA, otherToken.address, alice as Address, amount);
    const receipt = await transferToken(
      chainA,
      otherToken.address,
      ALICE_INDEX,
      treasury as Address,
      amount
    );
    const [log] = findTransferLogs(receipt, otherToken.address, { value: amount });
    await mine(chainA, 1);
    await settle();

    const result = await verifier(usdc)(inputFor(usdc, receipt.transactionHash, log.logIndex));
    expect(result.verified).toBe(false);
    expect(result.reason).toBe("WRONG_TOKEN");
  });

  it("rejects a transfer whose sender is not the authenticated wallet", async () => {
    const amount = parseUnits("1", 6);
    await mintToken(chainA, usdc.address, getAccount(STRANGER_INDEX).address, amount);
    const receipt = await transferToken(
      chainA,
      usdc.address,
      STRANGER_INDEX,
      treasury as Address,
      amount
    );
    const [log] = findTransferLogs(receipt, usdc.address, { value: amount });
    await mine(chainA, 1);
    await settle();

    const result = await verifier(usdc)(
      inputFor(usdc, receipt.transactionHash, log.logIndex, alice)
    );
    expect(result.verified).toBe(false);
    expect(result.reason).toBe("WRONG_SENDER");
  });

  it("rejects a transfer whose recipient is not the configured treasury", async () => {
    const amount = parseUnits("1", 6);
    const other = getAccount(14).address.toLowerCase();
    await mintToken(chainA, usdc.address, alice as Address, amount);
    const receipt = await transferToken(
      chainA,
      usdc.address,
      ALICE_INDEX,
      other as Address,
      amount
    );
    const [log] = findTransferLogs(receipt, usdc.address, { value: amount });
    await mine(chainA, 1);
    await settle();

    const result = await verifier(usdc)(
      inputFor(usdc, receipt.transactionHash, log.logIndex, alice)
    );
    expect(result.verified).toBe(false);
    expect(result.reason).toBe("WRONG_RECIPIENT");
  });

  it("rejects a missing log index", async () => {
    const amount = parseUnits("1", 6);
    await mintToken(chainA, usdc.address, alice as Address, amount);
    const receipt = await transferToken(
      chainA,
      usdc.address,
      ALICE_INDEX,
      treasury as Address,
      amount
    );
    const [log] = findTransferLogs(receipt, usdc.address, { value: amount });
    await mine(chainA, 1);
    await settle();

    const result = await verifier(usdc)(inputFor(usdc, receipt.transactionHash, log.logIndex + 99));
    expect(result.verified).toBe(false);
    expect(result.reason).toBe("LOG_NOT_FOUND");
  });

  it("requires the configured confirmation depth before verification", async () => {
    const amount = parseUnits("1", 6);
    await mintToken(chainA, usdc.address, alice as Address, amount);
    const receipt = await transferToken(
      chainA,
      usdc.address,
      ALICE_INDEX,
      treasury as Address,
      amount
    );
    const [log] = findTransferLogs(receipt, usdc.address, { value: amount });
    const deepVerifier = verifier(usdc, { confirmations: 5 });

    const tooEarly = await deepVerifier(inputFor(usdc, receipt.transactionHash, log.logIndex));
    expect(tooEarly.verified).toBe(false);
    expect(tooEarly.reason).toBe("INSUFFICIENT_CONFIRMATIONS");

    await mine(chainA, 5);
    await settle();
    const deep = await deepVerifier(inputFor(usdc, receipt.transactionHash, log.logIndex));
    expect(deep.verified).toBe(true);
    expect(deep.confirmations).toBeGreaterThanOrEqual(5);
  });

  it("rejects a frozen asset", async () => {
    const frozen = verifier(usdc, { status: "FROZEN" });
    const result = await frozen({
      assetId: `eip155:${CHAIN_A_ID}/erc20:${usdc.address.toLowerCase()}`,
      chainId: CHAIN_A_ID,
      txHash: `0x${"ab".repeat(32)}`,
      logIndex: 0,
      principalId: "alice",
      walletAddress: alice,
    });
    expect(result.verified).toBe(false);
    expect(result.reason).toBe("ASSET_FROZEN");
  });
});
