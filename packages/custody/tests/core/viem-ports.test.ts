/**
 * Unit tests for the custody viem ports.
 *
 * Scope: the treasury signer (>= 2 distinct RPC endpoints, exact agreement on
 * chain id / gas / fee fields / native balance, worst-case affordability,
 * provenance and resolver binding), the raw-bytes broadcaster cache keying, and
 * fail-closed configuration errors. RPC quorum reads are owned by the API
 * finance-core adapter (`createAssetBackedCustodyQuorumReader`) and are
 * intentionally not covered here.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeFunctionData, keccak256, parseAbi, parseTransaction } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  ViemTreasuryBroadcaster,
  ViemTreasurySigner,
  staticAccountResolver,
} from "../../src/core/viem-ports.js";
import type { SignTransferRequest, TreasuryAsset } from "../../src/core/types.js";

interface FakeRpcClient {
  chainId: number;
  rpcUrl: string;
  getChainId: ReturnType<typeof vi.fn>;
  getBalance: ReturnType<typeof vi.fn>;
  estimateGas: ReturnType<typeof vi.fn>;
  estimateFeesPerGas: ReturnType<typeof vi.fn>;
  getGasPrice: ReturnType<typeof vi.fn>;
  sendRawTransaction: ReturnType<typeof vi.fn>;
}

const rpc = vi.hoisted(() => {
  const clients: FakeRpcClient[] = [];
  return { clients };
});

const NATIVE_BALANCE = 10n ** 18n;

// Keep the real viem surface for signing/encoding/parsing; only stub client
// construction so the ports run without a network.
vi.mock("viem", async (importOriginal) => {
  const actual = await importOriginal<typeof import("viem")>();
  return {
    ...actual,
    http: (url: string) => ({ __rpcUrl: url }),
    createPublicClient: (config: {
      chain?: { id?: number };
      transport?: { __rpcUrl?: string };
    }) => {
      const chainId = config.chain?.id ?? 0;
      const client: FakeRpcClient = {
        chainId,
        rpcUrl: config.transport?.__rpcUrl ?? "",
        getChainId: vi.fn(async () => chainId),
        getBalance: vi.fn(async () => NATIVE_BALANCE),
        estimateGas: vi.fn(async () => 50_000n),
        estimateFeesPerGas: vi.fn(async () => ({
          maxFeePerGas: 2n,
          maxPriorityFeePerGas: 1n,
        })),
        getGasPrice: vi.fn(async () => 1n),
        sendRawTransaction: vi.fn(async () => `0x${"ab".repeat(32)}` as `0x${string}`),
      };
      rpc.clients.push(client);
      return client;
    },
  };
});

const PK = `0x${"11".repeat(32)}` as const;
const account = privateKeyToAccount(PK);
const TOKEN = "0x00000000000000000000000000000000000000aa" as const;
const DESTINATION = "0x00000000000000000000000000000000000000cc" as const;
const TRANSFER_ABI = parseAbi(["function transfer(address to, uint256 amount) returns (bool)"]);
const EXPECTED_CALLDATA = encodeFunctionData({
  abi: TRANSFER_ABI,
  functionName: "transfer",
  args: [DESTINATION, 500n],
});

function makeAsset(chainId: number, rpcUrls: string[]): TreasuryAsset {
  return {
    assetId: `eip155:${chainId}/erc20:${TOKEN}`,
    chainId,
    tokenAddress: TOKEN,
    treasuryAddress: account.address,
    rpcUrls,
    minGasAtomic: "0",
    confirmations: 1,
    deepFinality: 3,
    status: "ACTIVE",
  };
}

function makeRequest(overrides: Partial<SignTransferRequest> = {}): SignTransferRequest {
  return {
    chainId: 31337,
    rpcUrls: ["http://rpc-sign-a.example", "http://rpc-sign-b.example"],
    tokenAddress: TOKEN,
    treasuryAddress: account.address,
    destination: DESTINATION,
    amountAtomic: "500",
    nonce: 7,
    ...overrides,
  };
}

function makeSigner(): ViemTreasurySigner {
  return new ViemTreasurySigner(staticAccountResolver(new Map([[31337, PK]])));
}

/** Run one successful signing call so both per-endpoint clients exist. */
async function warmSigner(): Promise<{
  signer: ViemTreasurySigner;
  request: SignTransferRequest;
}> {
  const signer = makeSigner();
  const request = makeRequest();
  await signer.signTransfer(request);
  return { signer, request };
}

async function captureError(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected the promise to reject");
}

afterEach(() => {
  rpc.clients.length = 0;
  vi.clearAllMocks();
});

describe("ViemTreasuryBroadcaster cache keying", () => {
  it("reuses one client for the same chainId+rpcUrl and broadcasts the exact bytes", async () => {
    const broadcaster = new ViemTreasuryBroadcaster();
    const asset = makeAsset(31337, ["http://rpc-a.example"]);

    await expect(broadcaster.broadcast(asset, "0xdeadbeef")).resolves.toBe(`0x${"ab".repeat(32)}`);
    await broadcaster.broadcast(asset, "0xbeef");

    expect(rpc.clients).toHaveLength(1);
    expect(rpc.clients[0].sendRawTransaction).toHaveBeenCalledTimes(2);
    expect(rpc.clients[0].sendRawTransaction).toHaveBeenNthCalledWith(1, {
      serializedTransaction: "0xdeadbeef",
    });
  });

  it("does not reuse a client across chains that share the same rpcUrl", async () => {
    const broadcaster = new ViemTreasuryBroadcaster();
    const first = makeAsset(31337, ["http://shared.example"]);
    const second = makeAsset(1, ["http://shared.example"]);

    await broadcaster.broadcast(first, "0x01");
    await broadcaster.broadcast(second, "0x02");

    expect(rpc.clients).toHaveLength(2);
    expect(rpc.clients.map((client) => client.chainId)).toEqual([31337, 1]);
    expect(rpc.clients.map((client) => client.rpcUrl)).toEqual([
      "http://shared.example",
      "http://shared.example",
    ]);
    expect(rpc.clients[0].sendRawTransaction).toHaveBeenCalledTimes(1);
    expect(rpc.clients[1].sendRawTransaction).toHaveBeenCalledTimes(1);
    expect(rpc.clients[1].sendRawTransaction).toHaveBeenCalledWith({
      serializedTransaction: "0x02",
    });
  });

  it("fails closed when the asset has no RPC URLs", async () => {
    const broadcaster = new ViemTreasuryBroadcaster();
    await expect(broadcaster.broadcast(makeAsset(31337, []), "0x01")).rejects.toThrow(
      /has no RPC URLs/
    );
    expect(rpc.clients).toHaveLength(0);
  });
});

describe("ViemTreasurySigner", () => {
  it("signs an EIP-1559 transfer from unanimous independent endpoints with decoded provenance", async () => {
    const signer = makeSigner();
    const signed = await signer.signTransfer(makeRequest());

    expect(rpc.clients).toHaveLength(2);
    expect(rpc.clients.map((client) => client.rpcUrl)).toEqual([
      "http://rpc-sign-a.example",
      "http://rpc-sign-b.example",
    ]);
    for (const client of rpc.clients) {
      const gasCall = client.estimateGas.mock.calls[0][0] as {
        account: string;
        to: string;
        data: string;
        value: bigint;
      };
      // Only the treasury address (never key material) reaches the RPC.
      expect(gasCall.account).toBe(account.address);
      expect(gasCall.to).toBe(TOKEN);
      expect(gasCall.data).toBe(EXPECTED_CALLDATA);
      expect(gasCall.value).toBe(0n);
      expect(client.getBalance).toHaveBeenCalledWith({ address: account.address });
      expect(client.getChainId).toHaveBeenCalledTimes(1);
    }

    const tx = parseTransaction(signed.rawTransaction);
    expect(tx.chainId).toBe(31337);
    expect(tx.nonce).toBe(7);
    expect(tx.to?.toLowerCase()).toBe(TOKEN);
    // Zero values are omitted from the RLP encoding, so parsing yields undefined.
    expect(tx.value ?? 0n).toBe(0n);
    expect(tx.gas).toBe(50_000n);
    expect(tx.maxFeePerGas).toBe(2n);
    expect(tx.maxPriorityFeePerGas).toBe(1n);
    expect(tx.type).toBe("eip1559");

    expect(signed.hash).toBe(keccak256(signed.rawTransaction));
    expect(signed.provenance).toEqual({
      chainId: 31337,
      to: TOKEN,
      valueAtomic: "0",
      nonce: 7,
      callData: EXPECTED_CALLDATA,
      destination: DESTINATION,
      amountAtomic: "500",
    });
  });

  it("caches one client per chainId+rpcUrl and signs legacy when all endpoints agree on gasPrice", async () => {
    const { signer, request } = await warmSigner();
    expect(rpc.clients).toHaveLength(2);

    for (const client of rpc.clients) {
      client.estimateFeesPerGas.mockResolvedValue({ gasPrice: 3n });
    }
    const legacy = await signer.signTransfer({ ...request, nonce: 8 });

    expect(rpc.clients).toHaveLength(2);
    const legacyTx = parseTransaction(legacy.rawTransaction);
    expect(legacyTx.type).toBe("legacy");
    expect(legacyTx.gasPrice).toBe(3n);
    expect(legacyTx.nonce).toBe(8);
  });

  it("falls back to getGasPrice on every endpoint when the fee estimate carries no price", async () => {
    const { signer, request } = await warmSigner();

    for (const client of rpc.clients) {
      client.estimateFeesPerGas.mockResolvedValue({});
      client.getGasPrice.mockResolvedValue(5n);
    }
    const legacy = await signer.signTransfer({ ...request, nonce: 9 });

    for (const client of rpc.clients) {
      expect(client.getGasPrice).toHaveBeenCalledTimes(1);
    }
    expect(parseTransaction(legacy.rawTransaction).gasPrice).toBe(5n);
  });

  it("rejects before any RPC call when the resolved account does not control the treasury", async () => {
    const signer = makeSigner();
    await expect(
      signer.signTransfer(makeRequest({ treasuryAddress: DESTINATION }))
    ).rejects.toThrow(/does not control/);
    expect(rpc.clients).toHaveLength(0);
  });

  it("rejects fewer than two distinct RPC URLs without touching RPCs", async () => {
    const signer = makeSigner();
    for (const rpcUrls of [
      ["http://only.example"],
      ["http://same.example", "http://same.example", " http://same.example "],
      [],
    ]) {
      await expect(signer.signTransfer(makeRequest({ rpcUrls }))).rejects.toThrow(
        /at least 2 distinct RPC URLs/
      );
    }
    expect(rpc.clients).toHaveLength(0);
  });

  it("fails closed when one endpoint's fee estimate dissents (no majority vote)", async () => {
    const { signer, request } = await warmSigner();
    rpc.clients[1].estimateFeesPerGas.mockResolvedValue({
      maxFeePerGas: 3n,
      maxPriorityFeePerGas: 1n,
    });

    await expect(signer.signTransfer({ ...request, nonce: 8 })).rejects.toThrow(/dissented/);
  });

  it("fails closed when one endpoint's gas estimate dissents", async () => {
    const { signer, request } = await warmSigner();
    rpc.clients[1].estimateGas.mockResolvedValue(60_000n);

    await expect(signer.signTransfer({ ...request, nonce: 8 })).rejects.toThrow(/dissented/);
  });

  it("fails closed when the native balance observations dissent", async () => {
    const { signer, request } = await warmSigner();
    rpc.clients[1].getBalance.mockResolvedValue(NATIVE_BALANCE - 1n);

    await expect(signer.signTransfer({ ...request, nonce: 8 })).rejects.toThrow(/dissented/);
  });

  it("fails closed on an endpoint error or chain-id mismatch without leaking transport details", async () => {
    const { signer, request } = await warmSigner();

    rpc.clients[1].estimateFeesPerGas.mockRejectedValueOnce(
      new Error("transport http://user:secret@rpc.example/key")
    );
    const transportError = await captureError(signer.signTransfer({ ...request, nonce: 8 }));
    expect(transportError.message).toMatch(/failed on 1\/2 endpoints/);
    expect(transportError.message).not.toContain("secret");

    rpc.clients[1].getChainId.mockResolvedValueOnce(1);
    await expect(signer.signTransfer({ ...request, nonce: 9 })).rejects.toThrow(
      /failed on 1\/2 endpoints/
    );
  });

  it("fails closed when every endpoint fails", async () => {
    const { signer, request } = await warmSigner();
    for (const client of rpc.clients) {
      client.getBalance.mockRejectedValueOnce(new Error("endpoint down"));
    }

    await expect(signer.signTransfer({ ...request, nonce: 8 })).rejects.toThrow(
      /failed on 2\/2 endpoints/
    );
  });

  it("fails closed when worst-case gas cost exceeds the agreed native balance", async () => {
    const { signer, request } = await warmSigner();
    for (const client of rpc.clients) {
      client.getBalance.mockResolvedValue(1n);
    }

    await expect(signer.signTransfer({ ...request, nonce: 8 })).rejects.toThrow(
      /exceeds the agreed native balance/
    );
  });

  it("fails closed on non-sane per-endpoint fee estimates", async () => {
    const { signer, request } = await warmSigner();
    rpc.clients[1].estimateFeesPerGas.mockResolvedValue({
      maxFeePerGas: 2n,
      maxPriorityFeePerGas: 3n,
    });

    await expect(signer.signTransfer({ ...request, nonce: 8 })).rejects.toThrow(
      /failed on 1\/2 endpoints/
    );
  });
});
