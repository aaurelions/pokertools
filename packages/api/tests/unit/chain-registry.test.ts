import { describe, it, expect } from "vitest";
import {
  ChainFrozenError,
  ChainRegistry,
  RpcChainMismatchError,
  RpcDisagreementError,
  RpcDuplicateEndpointError,
  RpcEndpointError,
  RpcQuorumError,
  TRANSFER_TOPIC,
  assertUniqueEndpoints,
  createDefaultRpcClient,
  parseErc20Transfer,
  sanitizeErrorMessage,
  redactEndpointUrl,
  type HostResolver,
  type NormalizedBlock,
  type NormalizedLog,
  type NormalizedReceipt,
  type QuorumRpcClient,
  type RegistryIncident,
  type RpcEndpointConfig,
} from "../../src/services/chain-registry.js";

const TX = `0x${"ab".repeat(32)}`;
const BLOCK_HASH = `0x${"cd".repeat(32)}`;
const OTHER_BLOCK_HASH = `0x${"ef".repeat(32)}`;
const WALLET = "0x1111111111111111111111111111111111111111";
const TOKEN = "0x2222222222222222222222222222222222222222";
const TREASURY = "0x3333333333333333333333333333333333333333";

function pad32(address: string): string {
  return `0x${address.replace(/^0x/, "").padStart(64, "0")}`;
}

function transferLog(
  logIndex: number,
  amount: bigint,
  to = TREASURY,
  from = WALLET
): NormalizedLog {
  return {
    address: TOKEN,
    topics: [TRANSFER_TOPIC, pad32(from), pad32(to)],
    data: `0x${amount.toString(16).padStart(64, "0")}`,
    logIndex,
    removed: false,
  };
}

function makeReceipt(overrides: Partial<NormalizedReceipt> = {}): NormalizedReceipt {
  return {
    transactionHash: TX,
    blockHash: BLOCK_HASH,
    blockNumber: 100n,
    from: WALLET,
    to: TOKEN,
    contractAddress: null,
    status: "success",
    logs: [transferLog(0, 1000n)],
    ...overrides,
  };
}

function makeBlock(overrides: Partial<NormalizedBlock> = {}): NormalizedBlock {
  return { number: 100n, hash: BLOCK_HASH, parentHash: `0x${"01".repeat(32)}`, ...overrides };
}

// Deterministic synthetic DNS: loopback aliases collapse, everything else gets
// a stable distinct address.
const hostIps = new Map<string, string>();
const testResolver: HostResolver = async (host) => {
  const lower = host.toLowerCase();
  if (lower === "localhost" || lower === "127.0.0.1") return ["127.0.0.1"];
  if (lower === "::1") return ["::1"];
  if (/^\d+\.\d+\.\d+\.\d+$/.test(lower)) return [lower];
  if (!hostIps.has(lower)) hostIps.set(lower, `10.0.0.${hostIps.size + 1}`);
  return [hostIps.get(lower)!];
};

interface FakeEndpoint {
  expectedChainId: number;
  actualChainId?: number;
  /** Fails everything, including startup chain validation. */
  down?: boolean;
  /** Passes startup validation but fails subsequent data reads. */
  runtimeDown?: boolean;
  /** Custom (potentially unsafe) error message used when the endpoint fails. */
  errorMessage?: string;
  blockNumber?: bigint;
  receipt?: NormalizedReceipt | null;
  block?: NormalizedBlock;
  balance?: bigint;
  tokenBalance?: bigint;
  nonce?: bigint;
}

function makeFactory(states: Record<string, FakeEndpoint>) {
  return (endpoint: RpcEndpointConfig): QuorumRpcClient => {
    const state = states[endpoint.id];
    const unavailable = () =>
      Promise.reject(new Error(state.errorMessage ?? `endpoint ${endpoint.id} unavailable`));
    const dataDown = () => state.down || state.runtimeDown;
    return {
      getChainId: () =>
        state.down
          ? unavailable()
          : Promise.resolve(BigInt(state.actualChainId ?? state.expectedChainId)),
      getBlockNumber: () =>
        dataDown() ? unavailable() : Promise.resolve(state.blockNumber ?? 100n),
      getBlock: () => (dataDown() || !state.block ? unavailable() : Promise.resolve(state.block)),
      getTransactionReceipt: () =>
        dataDown()
          ? unavailable()
          : Promise.resolve(state.receipt === undefined ? makeReceipt() : state.receipt),
      getBalance: () => (dataDown() ? unavailable() : Promise.resolve(state.balance ?? 1_000_000n)),
      getTokenBalance: () =>
        dataDown() ? unavailable() : Promise.resolve(state.tokenBalance ?? 500n),
      getTransactionCount: () => (dataDown() ? unavailable() : Promise.resolve(state.nonce ?? 7n)),
    };
  };
}

function makeRegistry(
  endpoints: RpcEndpointConfig[],
  states: Record<string, FakeEndpoint>,
  extra: { incidents?: RegistryIncident[]; onFreeze?: () => void; quorum?: number } = {}
) {
  const incidents = extra.incidents ?? [];
  const registry = new ChainRegistry({
    endpoints,
    quorum: extra.quorum,
    resolveHost: testResolver,
    createClient: makeFactory(states),
    incidentSink: {
      record: async (incident) => {
        incidents.push(incident);
      },
    },
    onFreeze: extra.onFreeze,
  });
  return { registry, incidents };
}

function endpoint(id: string, url: string, chainId = 1): RpcEndpointConfig {
  return { id, chainId, url };
}

describe("ChainRegistry startup validation", () => {
  it("rejects an endpoint that reports the wrong chain id", async () => {
    const { registry } = makeRegistry(
      [endpoint("a", "http://rpc-a.example"), endpoint("b", "http://rpc-b.example")],
      {
        a: { expectedChainId: 1 },
        b: { expectedChainId: 1, actualChainId: 137 },
      }
    );

    await expect(registry.start()).rejects.toBeInstanceOf(RpcChainMismatchError);
  });

  it("rejects duplicate sockets even with different paths/query keys", async () => {
    await expect(
      assertUniqueEndpoints(
        [
          endpoint("a", "http://rpc.example:8545/v1"),
          endpoint("b", "http://rpc.example:8545/v2?key=1"),
        ],
        testResolver
      )
    ).rejects.toBeInstanceOf(RpcDuplicateEndpointError);
  });

  it("treats localhost and 127.0.0.1 on the same port as the same endpoint", async () => {
    await expect(
      assertUniqueEndpoints(
        [endpoint("a", "http://localhost:8545"), endpoint("b", "http://127.0.0.1:8545")],
        testResolver
      )
    ).rejects.toBeInstanceOf(RpcDuplicateEndpointError);
  });

  it("allows two independent local proxies on different ports for the same chain", async () => {
    const { registry } = makeRegistry(
      [endpoint("a", "http://127.0.0.1:8545"), endpoint("b", "http://127.0.0.1:8546")],
      { a: { expectedChainId: 1 }, b: { expectedChainId: 1 } }
    );

    await expect(registry.start()).resolves.toBeUndefined();
    expect(registry.getChainIds()).toEqual([1]);
    expect(registry.isChainAuthorized(1)).toBe(true);
  });

  it("requires at least two participants for a chain", async () => {
    const { registry } = makeRegistry([endpoint("a", "http://rpc-a.example")], {
      a: { expectedChainId: 1 },
    });

    await expect(registry.start()).rejects.toBeInstanceOf(RpcEndpointError);
  });

  it("rejects a configured quorum larger than the participants", async () => {
    const { registry } = makeRegistry(
      [endpoint("a", "http://rpc-a.example"), endpoint("b", "http://rpc-b.example")],
      { a: { expectedChainId: 1 }, b: { expectedChainId: 1 } },
      { quorum: 3 }
    );

    await expect(registry.start()).rejects.toThrow(/quorum 3 is invalid/);
  });

  it("rejects a configured quorum below the two-endpoint settlement minimum", async () => {
    const { registry } = makeRegistry(
      [endpoint("a", "http://rpc-a.example"), endpoint("b", "http://rpc-b.example")],
      { a: { expectedChainId: 1 }, b: { expectedChainId: 1 } },
      { quorum: 1 }
    );

    await expect(registry.start()).rejects.toThrow(/quorum 1 is invalid/);
  });

  it("detects distinct hostnames that resolve to the same socket as one participant", async () => {
    const aliasResolver: HostResolver = async (host) => {
      if (host === "primary.provider.test" || host === "alias.provider.test") {
        return ["203.0.113.7"];
      }
      return ["203.0.113.99"];
    };

    await expect(
      assertUniqueEndpoints(
        [
          endpoint("a", "http://primary.provider.test:8545/rpc"),
          endpoint("b", "http://alias.provider.test:8545/rpc"),
        ],
        aliasResolver
      )
    ).rejects.toBeInstanceOf(RpcDuplicateEndpointError);
  });

  it("detects overlapping resolved IP sets as the same participant", async () => {
    const overlapResolver: HostResolver = async (host) => {
      if (host === "pool-a.provider.test") return ["198.51.100.1", "198.51.100.2"];
      if (host === "pool-b.provider.test") return ["198.51.100.2", "198.51.100.3"];
      return [];
    };

    await expect(
      assertUniqueEndpoints(
        [
          endpoint("a", "http://pool-a.provider.test:8545"),
          endpoint("b", "http://pool-b.provider.test:8545"),
        ],
        overlapResolver
      )
    ).rejects.toBeInstanceOf(RpcDuplicateEndpointError);
  });

  it("treats bracketed IPv6 literals on the same port as the same endpoint", async () => {
    await expect(
      assertUniqueEndpoints(
        [endpoint("a", "http://[::1]:8545"), endpoint("b", "http://[::1]:8545/rpc")],
        testResolver
      )
    ).rejects.toBeInstanceOf(RpcDuplicateEndpointError);
  });

  it("treats an IPv4-mapped IPv6 literal as the same socket as its IPv4 form", async () => {
    const mappedResolver: HostResolver = async (host) => {
      if (host === "::ffff:7f00:1" || host === "127.0.0.1") return [host];
      return [];
    };

    await expect(
      assertUniqueEndpoints(
        [endpoint("a", "http://127.0.0.1:8545"), endpoint("b", "http://[::ffff:127.0.0.1]:8545")],
        mappedResolver
      )
    ).rejects.toBeInstanceOf(RpcDuplicateEndpointError);
  });

  it("rejects duplicate explicit endpoint ids", async () => {
    await expect(
      assertUniqueEndpoints(
        [endpoint("dup", "http://a.example"), endpoint("dup", "http://b.example")],
        testResolver
      )
    ).rejects.toBeInstanceOf(RpcDuplicateEndpointError);
  });

  it("fails startup when an endpoint cannot be validated", async () => {
    const { registry } = makeRegistry(
      [endpoint("a", "http://rpc-a.example"), endpoint("b", "http://rpc-b.example")],
      { a: { expectedChainId: 1 }, b: { expectedChainId: 1, down: true } }
    );

    await expect(registry.start()).rejects.toThrow(/could not be validated/);
  });
});

describe("ChainRegistry quorum reads", () => {
  it("returns a receipt when quorum endpoints agree", async () => {
    const endpoints = [
      endpoint("a", "http://rpc-a.example"),
      endpoint("b", "http://rpc-b.example"),
      endpoint("c", "http://rpc-c.example"),
    ];
    const { registry } = makeRegistry(endpoints, {
      a: { expectedChainId: 1, blockNumber: 100n },
      b: { expectedChainId: 1, runtimeDown: true },
      c: { expectedChainId: 1, blockNumber: 100n },
    });

    const receipt = await registry.getTransactionReceipt(1, TX);
    expect(receipt?.transactionHash).toBe(TX);
  });

  it("fails closed and freezes the chain on receipt disagreement", async () => {
    const incidents: RegistryIncident[] = [];
    let frozen = 0;
    const endpoints = [
      endpoint("a", "http://rpc-a.example"),
      endpoint("b", "http://rpc-b.example"),
    ];
    const { registry } = makeRegistry(
      endpoints,
      {
        a: { expectedChainId: 1, receipt: makeReceipt({ blockHash: BLOCK_HASH }) },
        b: { expectedChainId: 1, receipt: makeReceipt({ blockHash: OTHER_BLOCK_HASH }) },
      },
      { incidents, onFreeze: () => (frozen += 1) }
    );

    await expect(registry.getTransactionReceipt(1, TX)).rejects.toBeInstanceOf(
      RpcDisagreementError
    );
    expect(incidents).toHaveLength(1);
    expect(incidents[0].kind).toBe("RPC_DISAGREEMENT");
    expect(registry.isFrozen(1)).toBe(true);
    expect(frozen).toBe(1);

    // Once frozen, critical reads refuse without touching endpoints.
    await expect(registry.getBalance(1, WALLET)).rejects.toBeInstanceOf(ChainFrozenError);
  });

  it("fails closed on any disagreement among successes even when a quorum agrees", async () => {
    const incidents: RegistryIncident[] = [];
    const { registry } = makeRegistry(
      [
        endpoint("a", "http://rpc-a.example"),
        endpoint("b", "http://rpc-b.example"),
        endpoint("c", "http://rpc-c.example"),
      ],
      {
        a: { expectedChainId: 1, receipt: makeReceipt({ blockHash: BLOCK_HASH }) },
        b: { expectedChainId: 1, receipt: makeReceipt({ blockHash: BLOCK_HASH }) },
        c: { expectedChainId: 1, receipt: makeReceipt({ blockHash: OTHER_BLOCK_HASH }) },
      },
      { incidents }
    );

    // Two endpoints agree (a quorum of 2), but unanimity of successes is
    // required for a critical read, so the minority disagreement fails closed.
    await expect(registry.getTransactionReceipt(1, TX)).rejects.toBeInstanceOf(
      RpcDisagreementError
    );
    expect(registry.isFrozen(1)).toBe(true);
    expect(incidents).toHaveLength(1);
    expect(incidents[0].kind).toBe("RPC_DISAGREEMENT");
  });

  it("records RPC_QUORUM_FAILURE when too few endpoints respond", async () => {
    const incidents: RegistryIncident[] = [];
    const { registry } = makeRegistry(
      [endpoint("a", "http://rpc-a.example"), endpoint("b", "http://rpc-b.example")],
      { a: { expectedChainId: 1 }, b: { expectedChainId: 1, runtimeDown: true } },
      { incidents }
    );

    await expect(registry.getTokenBalance(1, TOKEN, WALLET)).rejects.toBeInstanceOf(RpcQuorumError);
    expect(incidents).toHaveLength(1);
    expect(incidents[0].kind).toBe("RPC_QUORUM_FAILURE");
    expect(registry.isFrozen(1)).toBe(false);
  });

  it("allows non-critical block-number fallback and returns the minimum height", async () => {
    const { registry } = makeRegistry(
      [endpoint("a", "http://rpc-a.example"), endpoint("b", "http://rpc-b.example")],
      {
        a: { expectedChainId: 1, blockNumber: 105n },
        b: { expectedChainId: 1, blockNumber: 103n },
      }
    );

    expect(await registry.getBlockNumber(1)).toBe(103n);
  });

  it("requires quorum for the settlement height and never single-endpoint fallback", async () => {
    const { registry } = makeRegistry(
      [endpoint("a", "http://rpc-a.example"), endpoint("b", "http://rpc-b.example")],
      {
        a: { expectedChainId: 1, blockNumber: 110n },
        b: { expectedChainId: 1, runtimeDown: true },
      }
    );

    await expect(registry.getSettlementBlockNumber(1)).rejects.toBeInstanceOf(RpcQuorumError);
  });

  it("returns a canonical receipt paired with its block and quorum confirmations", async () => {
    const { registry } = makeRegistry(
      [endpoint("a", "http://rpc-a.example"), endpoint("b", "http://rpc-b.example")],
      {
        a: {
          expectedChainId: 1,
          blockNumber: 110n,
          receipt: makeReceipt({ blockNumber: 100n }),
          block: makeBlock({ number: 100n, hash: BLOCK_HASH }),
        },
        b: {
          expectedChainId: 1,
          blockNumber: 108n,
          receipt: makeReceipt({ blockNumber: 100n }),
          block: makeBlock({ number: 100n, hash: BLOCK_HASH }),
        },
      }
    );

    const canonical = await registry.getCanonicalReceipt(1, TX);
    expect(canonical?.receipt.transactionHash).toBe(TX);
    // Conservative minimum across quorum participants; inclusive depth
    // (the receipt's own block counts as the first confirmation).
    expect(canonical?.confirmations).toBe(9);
  });

  it("reads the treasury nonce through quorum and never a single fallback endpoint", async () => {
    const { registry } = makeRegistry(
      [endpoint("a", "http://rpc-a.example"), endpoint("b", "http://rpc-b.example")],
      {
        a: { expectedChainId: 1, nonce: 4n },
        b: { expectedChainId: 1, nonce: 4n },
      }
    );

    expect(await registry.getTransactionCount(1, TREASURY, "pending")).toBe(4n);

    const { registry: failing } = makeRegistry(
      [endpoint("a", "http://rpc-a.example"), endpoint("b", "http://rpc-b.example")],
      {
        a: { expectedChainId: 1, nonce: 4n },
        b: { expectedChainId: 1, runtimeDown: true },
      }
    );
    await expect(failing.getTransactionCount(1, TREASURY, "pending")).rejects.toBeInstanceOf(
      RpcQuorumError
    );
  });

  it("fails closed when the canonical block hash differs from the receipt", async () => {
    const incidents: RegistryIncident[] = [];
    const { registry } = makeRegistry(
      [endpoint("a", "http://rpc-a.example"), endpoint("b", "http://rpc-b.example")],
      {
        a: {
          expectedChainId: 1,
          blockNumber: 110n,
          receipt: makeReceipt({ blockHash: BLOCK_HASH }),
          block: makeBlock({ hash: OTHER_BLOCK_HASH }),
        },
        b: {
          expectedChainId: 1,
          blockNumber: 110n,
          receipt: makeReceipt({ blockHash: BLOCK_HASH }),
          block: makeBlock({ hash: OTHER_BLOCK_HASH }),
        },
      },
      { incidents }
    );

    await expect(registry.getCanonicalReceipt(1, TX)).rejects.toBeInstanceOf(RpcDisagreementError);
    expect(registry.isFrozen(1)).toBe(true);
    expect(incidents[0].kind).toBe("RPC_DISAGREEMENT");
  });

  it("rejects settlement for a chain with no authorized endpoints", async () => {
    const { registry } = makeRegistry(
      [endpoint("a", "http://rpc-a.example"), endpoint("b", "http://rpc-b.example")],
      { a: { expectedChainId: 1 }, b: { expectedChainId: 1 } }
    );
    expect(registry.isChainAuthorized(999)).toBe(false);
    await expect(registry.getCanonicalReceipt(999, TX)).rejects.toBeInstanceOf(RpcQuorumError);
  });
});

describe("evidence redaction", () => {
  it("never persists raw credential URLs or unsanitized upstream errors", async () => {
    const incidents: RegistryIncident[] = [];
    const { registry } = makeRegistry(
      [endpoint("a", "http://rpc-a.example"), endpoint("b", "http://rpc-b.example")],
      {
        a: { expectedChainId: 1, receipt: makeReceipt({ blockHash: BLOCK_HASH }) },
        b: { expectedChainId: 1, receipt: makeReceipt({ blockHash: OTHER_BLOCK_HASH }) },
      },
      { incidents }
    );

    await expect(registry.getTransactionReceipt(1, TX)).rejects.toBeInstanceOf(
      RpcDisagreementError
    );
    const serialized = JSON.stringify(incidents);
    expect(serialized).not.toContain("key=");
    expect(serialized).not.toContain("user:pass");
  });

  it("redacts URL userinfo/query and sanitizes embedded URLs in errors", () => {
    expect(redactEndpointUrl("https://user:secret@rpc.example.com/v1?apikey=abc")).toBe(
      "https://rpc.example.com"
    );
    expect(
      sanitizeErrorMessage("HTTP request failed https://user:secret@rpc.example.com/v1?apikey=abc")
    ).toBe("HTTP request failed https://rpc.example.com");
  });

  it("persists only redacted origins and sanitized errors in disagreement evidence", async () => {
    const incidents: RegistryIncident[] = [];
    const credentialUrl = "https://user:pass@rpc-a.example/v1?apikey=SUPERSECRET";
    const { registry } = makeRegistry(
      [
        endpoint("a", credentialUrl),
        endpoint("b", "https://user:pass@rpc-b.example/v1?apikey=SUPERSECRET"),
        endpoint("c", "https://rpc-c.example/v1?apikey=SUPERSECRET"),
      ],
      {
        a: { expectedChainId: 1, receipt: makeReceipt({ blockHash: BLOCK_HASH }) },
        b: { expectedChainId: 1, receipt: makeReceipt({ blockHash: OTHER_BLOCK_HASH }) },
        c: {
          expectedChainId: 1,
          runtimeDown: true,
          errorMessage: `transport failed for ${credentialUrl}`,
        },
      },
      { incidents }
    );

    await expect(registry.getTransactionReceipt(1, TX)).rejects.toBeInstanceOf(
      RpcDisagreementError
    );

    const evidence = incidents[0].evidence;
    expect(evidence.endpoints.map((e) => e.endpoint)).toEqual([
      "https://rpc-a.example",
      "https://rpc-b.example",
      "https://rpc-c.example",
    ]);
    expect(evidence.endpoints.find((e) => e.id === "c")?.error).toBe(
      "transport failed for https://rpc-a.example"
    );
    const serialized = JSON.stringify(incidents);
    expect(serialized).not.toContain("SUPERSECRET");
    expect(serialized).not.toContain("user:pass");
  });
});

describe("createDefaultRpcClient", () => {
  it("validates an arbitrary endpoint via eth_chainId and reads without a viem chain", async () => {
    const calls: string[] = [];
    const fetchStub: typeof globalThis.fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { id: number; method: string };
      calls.push(body.method);
      const result = (() => {
        switch (body.method) {
          case "eth_chainId":
            return "0x7a69"; // 31337
          case "eth_blockNumber":
            return "0x64"; // 100
          case "eth_getBalance":
            return "0xde0b6b3a7640000"; // 1e18
          case "eth_call":
            return `0x${"0".repeat(63)}1`; // 1
          default:
            return null;
        }
      })();
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const client = createDefaultRpcClient(
      { id: "arbitrary", chainId: 31337, url: "http://arbitrary-rpc.example" },
      { timeoutMs: 1_000, fetch: fetchStub }
    );

    expect(await client.getChainId()).toBe(31337n);
    expect(await client.getBlockNumber()).toBe(100n);
    expect(await client.getBalance({ address: WALLET })).toBe(1_000_000_000_000_000_000n);
    expect(await client.getTokenBalance({ token: TOKEN, owner: WALLET })).toBe(1n);
    expect(calls).toContain("eth_chainId");
  });
});

describe("parseErc20Transfer", () => {
  it("parses a well-formed Transfer log", () => {
    const parsed = parseErc20Transfer(transferLog(3, 42n));
    expect(parsed).toEqual({ from: WALLET, to: TREASURY, amount: 42n });
  });

  it("rejects non-Transfer logs", () => {
    const log = transferLog(0, 1n);
    log.topics[0] = `0x${"00".repeat(32)}`;
    expect(parseErc20Transfer(log)).toBeNull();
  });

  it("rejects removed logs", () => {
    expect(parseErc20Transfer({ ...transferLog(0, 1n), removed: true })).toBeNull();
  });

  it("rejects malformed logs", () => {
    expect(parseErc20Transfer({ ...transferLog(0, 1n), topics: [TRANSFER_TOPIC] })).toBeNull();
    expect(parseErc20Transfer({ ...transferLog(0, 1n), data: "not-hex" })).toBeNull();
  });
});
