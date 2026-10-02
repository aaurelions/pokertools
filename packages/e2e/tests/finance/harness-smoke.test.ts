/**
 * Executable harness evidence for finance/custody acceptance.
 *
 * This suite proves the *real* infrastructure itself: two isolated Anvil chains
 * with distinct ids, a 6-decimal and an 18-decimal ERC20, real transfers and
 * exact ERC20 Transfer log identity, deterministic snapshot/revert, independent
 * configurable quorum proxy endpoints, and canonical EIP-712 signing/recovery.
 *
 * It intentionally imports no planned API/custody module, so it must pass
 * as-is. The scenario suites (deposits/withdrawals/reorg/quorum/reconciliation)
 * import the planned seams and fail until those implementations land.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { WITHDRAWAL_INTENT_EIP712_FIELDS, bigIntToAtomicAmount } from "@pokertools/types";
import type { Address, Hex } from "viem";
import { parseUnits } from "viem";
import {
  attachTwoChainAnvil,
  batchTransferFromTreasury,
  CHAIN_A_ID,
  CHAIN_B_ID,
  deployMockAssetToken18,
  deployMockUsdc6,
  findTransferLogs,
  getAccount,
  mintToken,
  readTokenBalance,
  readTokenDecimals,
  revertSnapshot,
  snapshot,
  transferToken,
  type DeployedToken,
  type LocalChain,
} from "../finance/helpers/anvil-two-chain.js";
import {
  randomBlockHash,
  rpcCall,
  startQuorumProxies,
  type ProxySet,
} from "../finance/helpers/quorum-proxy.js";
import {
  buildWithdrawalDomain,
  recoverWithdrawalSigner,
  signWithdrawalIntent,
  WITHDRAWAL_DOMAIN_NAME,
  WITHDRAWAL_DOMAIN_VERSION,
} from "../finance/helpers/eip712.js";
import { ANVIL_ACCOUNT_ZERO_KEY } from "../finance/helpers/anvil-two-chain.js";

describe("finance acceptance harness (real infrastructure)", () => {
  let chainA: LocalChain;
  let chainB: LocalChain;
  let usdc6: DeployedToken;
  let dai18: DeployedToken;
  const treasury = getAccount(0);

  beforeAll(async () => {
    ({ chainA, chainB } = await attachTwoChainAnvil());
    usdc6 = await deployMockUsdc6(chainA);
    dai18 = await deployMockAssetToken18(chainB);
  });

  it("runs two isolated chains with distinct chain ids", async () => {
    expect(chainA.chainId).toBe(CHAIN_A_ID);
    expect(chainB.chainId).toBe(CHAIN_B_ID);
    expect(Number(await rpcCall<string>(chainA.rpcUrl, "eth_chainId"))).toBe(CHAIN_A_ID);
    expect(Number(await rpcCall<string>(chainB.rpcUrl, "eth_chainId"))).toBe(CHAIN_B_ID);
    expect(chainA.rpcUrl).not.toBe(chainB.rpcUrl);
  });

  it("deploys 6- and 18-decimal assets", async () => {
    expect(await readTokenDecimals(chainA, usdc6.address)).toBe(6);
    expect(await readTokenDecimals(chainB, dai18.address)).toBe(18);
  });

  it("credits only via real ERC20 transfers", async () => {
    const amount = parseUnits("123.45", 6);
    await mintToken(chainA, usdc6.address, treasury.address, amount);
    const before = await readTokenBalance(chainA, usdc6.address, treasury.address);

    const recipient = getAccount(5).address;
    await transferToken(chainA, usdc6.address, 0, recipient, amount);

    expect(await readTokenBalance(chainA, usdc6.address, recipient)).toBe(amount);
    expect(await readTokenBalance(chainA, usdc6.address, treasury.address)).toBe(before - amount);
  });

  it("extracts exact ERC20 log identity (txHash, logIndex, block)", async () => {
    const amount = parseUnits("7", 18);
    const recipient = getAccount(6).address;
    await mintToken(chainB, dai18.address, treasury.address, amount);
    const receipt = await transferToken(chainB, dai18.address, 0, recipient, amount);

    const logs = findTransferLogs(receipt, dai18.address, {
      from: treasury.address,
      to: recipient,
      value: amount,
    });
    expect(logs).toHaveLength(1);
    expect(logs[0].txHash).toBe(receipt.transactionHash);
    expect(logs[0].logIndex).toBe(0);
    expect(logs[0].blockHash).toBe(receipt.blockHash);
  });

  it("emits multiple exact logs in one treasury transaction", async () => {
    const amount = parseUnits("3", 18);
    const recipients = [getAccount(7).address, getAccount(8).address];
    await mintToken(chainB, dai18.address, treasury.address, amount * 2n);

    const receipt = await batchTransferFromTreasury(chainB, dai18.address, recipients, [
      amount,
      amount,
    ]);
    const logs = findTransferLogs(receipt, dai18.address, {
      from: treasury.address,
      value: amount,
    });

    expect(logs).toHaveLength(2);
    expect(new Set(logs.map((log) => log.logIndex)).size).toBe(2);
    expect(new Set(logs.map((log) => log.to.toLowerCase()))).toEqual(
      new Set(recipients.map((r) => r.toLowerCase()))
    );
    for (const log of logs) {
      expect(log.txHash).toBe(receipt.transactionHash);
    }
  });

  it("reverts state and invalidates receipts via Anvil snapshot/revert", async () => {
    const amount = parseUnits("9", 6);
    const recipient = getAccount(9).address;
    await mintToken(chainA, usdc6.address, treasury.address, amount);

    const snap = await snapshot(chainA);
    const before = await readTokenBalance(chainA, usdc6.address, treasury.address);
    const receipt = await transferToken(chainA, usdc6.address, 0, recipient, amount);
    expect(await readTokenBalance(chainA, usdc6.address, recipient)).toBe(amount);
    expect(receipt.status).toBe("success");

    await revertSnapshot(chainA, snap);

    expect(await readTokenBalance(chainA, usdc6.address, recipient)).toBe(0n);
    expect(await readTokenBalance(chainA, usdc6.address, treasury.address)).toBe(before);
    // After revert the transaction is no longer part of any canonical chain and
    // viem rejects the lookup instead of returning a receipt.
    await expect(
      chainA.publicClient.getTransactionReceipt({ hash: receipt.transactionHash })
    ).rejects.toThrow();
  });

  it("supports independent, configurable quorum proxy endpoints for one chain", async () => {
    const set: ProxySet = await startQuorumProxies(chainA.rpcUrl, 3);
    try {
      const urls = set.proxies.map((p) => p.url);
      expect(new Set(urls).size).toBe(3);

      const chainIds = await Promise.all(urls.map((url) => rpcCall<string>(url, "eth_chainId")));
      expect(chainIds.map((id) => Number(id))).toEqual([CHAIN_A_ID, CHAIN_A_ID, CHAIN_A_ID]);

      // Desynchronize exactly one endpoint: the others keep serving the truth.
      set.proxies[0].state.chainIdOverride = 999;
      expect(Number(await rpcCall<string>(urls[0], "eth_chainId"))).toBe(999);
      expect(Number(await rpcCall<string>(urls[1], "eth_chainId"))).toBe(CHAIN_A_ID);
      expect(Number(await rpcCall<string>(urls[2], "eth_chainId"))).toBe(CHAIN_A_ID);

      // Desynchronize block identity for the same block number.
      const latestHex = await rpcCall<string>(urls[1], "eth_blockNumber");
      set.proxies[1].state.blockHashOverride = new Map([
        [latestHex.toLowerCase(), randomBlockHash(0xab)],
      ]);
      const block = await rpcCall<{ hash: Hex }>(urls[1], "eth_getBlockByNumber", [
        latestHex,
        false,
      ]);
      expect(block.hash).toBe(randomBlockHash(0xab));
    } finally {
      await set.close();
    }
  });

  it("signs and recovers the canonical withdrawal intent (domain + fields)", async () => {
    const chainId = CHAIN_A_ID;
    const verifyingContract = "0x1111111111111111111111111111111111111111" as Address;
    const domain = buildWithdrawalDomain(chainId, verifyingContract);
    expect(domain).toMatchObject({
      name: WITHDRAWAL_DOMAIN_NAME,
      version: WITHDRAWAL_DOMAIN_VERSION,
      chainId,
      verifyingContract,
    });

    // Exact field list/order required by the supervisor spec.
    expect(WITHDRAWAL_INTENT_EIP712_FIELDS.map((f) => `${f.name}:${f.type}`)).toEqual([
      "intentId:string",
      "principalId:string",
      "assetId:string",
      "destination:address",
      "amountAtomic:uint256",
      "nonce:uint256",
      "deadline:uint256",
      "chainId:uint256",
    ]);

    const intent = {
      intentId: "wd_acceptance_1",
      principalId: "principal_1",
      assetId: `eip155:${chainId}/erc20:${usdc6.address.toLowerCase()}`,
      destination: getAccount(3).address.toLowerCase() as Address,
      amountAtomic: bigIntToAtomicAmount(parseUnits("42", 6)),
      nonce: 7,
      deadline: Math.floor(Date.now() / 1000) + 3600,
      chainId,
    };

    const signature = await signWithdrawalIntent(intent, domain, ANVIL_ACCOUNT_ZERO_KEY);
    const recovered = await recoverWithdrawalSigner(intent, domain, signature);
    expect(recovered.toLowerCase()).toBe(treasury.address.toLowerCase());
  });
});
