/**
 * Canonical ChainRegistry / RPC quorum acceptance against the REAL
 * implementation (`packages/api/src/services/chain-registry.ts`).
 *
 * Uses three distinct local proxy URLs that all forward to the same real Anvil
 * chain. Verifies: distinct independent endpoints for one chain are accepted,
 * duplicate URLs and mis-declared chains are rejected, quorum liveness is
 * enforced, and disagreement freezes the chain instead of being accepted.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ChainRegistry,
  ChainFrozenError,
  RpcChainMismatchError,
  RpcDisagreementError,
  RpcDuplicateEndpointError,
  RpcQuorumError,
  type RpcEndpointConfig,
} from "../../../api/src/services/chain-registry.js";
import { attachTwoChainAnvil, CHAIN_A_ID, type LocalChain } from "./helpers/anvil-two-chain.js";
import {
  randomBlockHash,
  rpcCall,
  startQuorumProxies,
  type ProxySet,
} from "./helpers/quorum-proxy.js";

describe("canonical ChainRegistry quorum acceptance", () => {
  let chainA: LocalChain;
  let chainB: LocalChain;
  let proxies: ProxySet;

  beforeEach(async () => {
    ({ chainA, chainB } = await attachTwoChainAnvil());
    proxies = await startQuorumProxies(chainA.rpcUrl, 3);
  });

  afterEach(async () => {
    await proxies.close();
  });

  function endpointsA(): RpcEndpointConfig[] {
    return proxies.proxies.map((proxy, index) => ({
      id: `a${index}`,
      chainId: CHAIN_A_ID,
      url: proxy.url,
    }));
  }

  it("accepts distinct independent proxy endpoints that all serve the same chain", async () => {
    const registry = new ChainRegistry({ endpoints: endpointsA(), quorum: 2 });
    await registry.start();
    expect(registry.getEndpoints(CHAIN_A_ID)).toHaveLength(3);
    expect(new Set(registry.getEndpoints(CHAIN_A_ID).map((endpoint) => endpoint.url)).size).toBe(3);
    expect(registry.isChainAuthorized(CHAIN_A_ID)).toBe(true);
    expect(registry.isFrozen(CHAIN_A_ID)).toBe(false);
  });

  it("rejects duplicate endpoint URLs", async () => {
    const url = proxies.proxies[0].url;
    const registry = new ChainRegistry({
      endpoints: [
        { id: "dup0", chainId: CHAIN_A_ID, url },
        { id: "dup1", chainId: CHAIN_A_ID, url },
      ],
      quorum: 1,
    });
    await expect(registry.start()).rejects.toBeInstanceOf(RpcDuplicateEndpointError);
  });

  it("rejects an endpoint whose live chain id does not match its declaration", async () => {
    const registry = new ChainRegistry({
      endpoints: [
        { id: "ok", chainId: CHAIN_A_ID, url: proxies.proxies[0].url },
        // Points at chain B but declares chain A.
        { id: "mismatch", chainId: CHAIN_A_ID, url: chainB.rpcUrl },
      ],
      // Explicit quorum must be >= the two-endpoint settlement minimum.
      quorum: 2,
    });
    await expect(registry.start()).rejects.toBeInstanceOf(RpcChainMismatchError);
  });

  it("fails closed when fewer than quorum endpoints respond", async () => {
    const registry = new ChainRegistry({ endpoints: endpointsA(), quorum: 2 });
    await registry.start();

    proxies.proxies[1].state.failMethods = new Set(["eth_getBlockByNumber"]);
    proxies.proxies[2].state.failMethods = new Set(["eth_getBlockByNumber"]);
    const latest = BigInt(await rpcCall<string>(chainA.rpcUrl, "eth_blockNumber"));

    await expect(registry.getBlock(CHAIN_A_ID, { blockNumber: latest })).rejects.toBeInstanceOf(
      RpcQuorumError
    );
  });

  it("detects endpoint disagreement and freezes the chain instead of accepting a view", async () => {
    const registry = new ChainRegistry({ endpoints: endpointsA(), quorum: 2 });
    await registry.start();

    const latestHex = await rpcCall<string>(chainA.rpcUrl, "eth_blockNumber");
    proxies.proxies[0].state.blockHashOverride = new Map([
      [latestHex.toLowerCase(), randomBlockHash(0xcd)],
    ]);

    await expect(
      registry.getBlock(CHAIN_A_ID, { blockNumber: BigInt(latestHex) })
    ).rejects.toBeInstanceOf(RpcDisagreementError);
    expect(registry.isFrozen(CHAIN_A_ID)).toBe(true);

    // Frozen chains refuse further critical reads.
    await expect(
      registry.getBlock(CHAIN_A_ID, { blockNumber: BigInt(latestHex) })
    ).rejects.toBeInstanceOf(ChainFrozenError);
  });

  it("serves the true chain id under quorum and reports no freeze", async () => {
    const registry = new ChainRegistry({ endpoints: endpointsA(), quorum: 2 });
    await registry.start();
    const block = await registry.getBlock(CHAIN_A_ID, { blockNumber: 0n });
    expect(block.number).toBe(0n);
    expect(registry.isFrozen(CHAIN_A_ID)).toBe(false);
  });

  it("rejects a chain with fewer than the minimum independent participants", async () => {
    const registry = new ChainRegistry({
      endpoints: [{ id: "solo", chainId: CHAIN_A_ID, url: proxies.proxies[0].url }],
      quorum: 1,
    });
    await expect(registry.start()).rejects.toThrow(/at least 2 independent participants/i);
  });
});
