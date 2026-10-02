/**
 * Independent local JSON-RPC proxy endpoints for ChainRegistry/quorum
 * acceptance.
 *
 * Each proxy is a distinct URL that forwards to a real upstream Anvil chain.
 * Because the URLs are distinct, a registry must accept several independent
 * endpoints that all serve the *same* chain (the "no duplicate URL" rule is
 * about duplicate strings, not about distinct proxies of one chain). A proxy's
 * mutable `state` lets a test desynchronize exactly one endpoint — wrong
 * chain id, wrong block hash for a block number, latency, or transport error —
 * to exercise quorum disagreement and fail-closed behavior.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Hex } from "viem";

export interface RpcProxyState {
  /** When set, `eth_chainId` reports this chain instead of the upstream value. */
  chainIdOverride?: number;
  /** Replace the `hash` (and matching `blockHash`) for these block numbers. */
  blockHashOverride?: Map<string, Hex>;
  /** Simulate an unavailable endpoint for these methods. */
  failMethods?: Set<string>;
  /** Return a conflicting eth_call value from this endpoint only. */
  ethCallResultOverride?: Hex;
  /**
   * Forward the call upstream (the node really executes it) but return an
   * error to the caller. Models "accepted broadcast, dropped response".
   */
  failAfterForwardMethods?: Set<string>;
  /** Artificial latency in ms added before forwarding. */
  latencyMs?: number;
}

export interface RpcProxy {
  /** Loopback URL for host-side test code. */
  url: string;
  /** Host-gateway URL for code running inside a Docker container. */
  hostUrl: string;
  state: RpcProxyState;
  close(): Promise<void>;
}

interface JsonRpcCall {
  jsonrpc: "2.0";
  id: number | string | null;
  method: string;
  params?: unknown[];
}

function toQuantity(value: number): Hex {
  return `0x${value.toString(16)}`;
}

function sendJson(res: http.ServerResponse, status: number, payload: unknown) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function errorFor(call: JsonRpcCall, message: string) {
  return { jsonrpc: "2.0", id: call.id, error: { code: -32000, message } };
}

function isBlockQuery(method: string): boolean {
  return method === "eth_getBlockByNumber" || method === "eth_getBlockByHash";
}

function applyOverrides(call: JsonRpcCall, result: unknown, state: RpcProxyState): unknown {
  if (call.method === "eth_call" && state.ethCallResultOverride !== undefined) {
    return state.ethCallResultOverride;
  }
  if (state.chainIdOverride !== undefined && call.method === "eth_chainId") {
    return toQuantity(state.chainIdOverride);
  }
  if (
    state.blockHashOverride &&
    isBlockQuery(call.method) &&
    result &&
    typeof result === "object"
  ) {
    const block = result as Record<string, unknown>;
    const number = typeof block.number === "string" ? block.number : undefined;
    const override = number ? state.blockHashOverride.get(number.toLowerCase()) : undefined;
    if (override) {
      return { ...block, hash: override };
    }
  }
  return result;
}

async function forward(upstreamUrl: string, payload: unknown): Promise<unknown> {
  const res = await fetch(upstreamUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`upstream HTTP ${res.status}`);
  return res.json();
}

/**
 * Start one proxy. Pass `port: 0` to bind an ephemeral port.
 */
export async function startRpcProxy(upstreamUrl: string, port = 0): Promise<RpcProxy> {
  const state: RpcProxyState = {};

  const server = http.createServer((req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      void (async () => {
        let parsed: JsonRpcCall | JsonRpcCall[];
        try {
          parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as
            JsonRpcCall | JsonRpcCall[];
        } catch {
          sendJson(res, 200, {
            jsonrpc: "2.0",
            id: null,
            error: { code: -32700, message: "parse" },
          });
          return;
        }
        if (state.latencyMs) await new Promise((r) => setTimeout(r, state.latencyMs));
        const calls = Array.isArray(parsed) ? parsed : [parsed];
        try {
          const results = await Promise.all(
            calls.map(async (call) => {
              if (state.failMethods?.has(call.method)) {
                return errorFor(call, `proxy unavailable for ${call.method}`);
              }
              const forwarded = (await forward(upstreamUrl, call)) as {
                id: JsonRpcCall["id"];
                result?: unknown;
                error?: unknown;
              };
              if (forwarded.error !== undefined) return forwarded;
              if (state.failAfterForwardMethods?.has(call.method)) {
                return errorFor(call, `response dropped after node accepted ${call.method}`);
              }
              return {
                jsonrpc: "2.0",
                id: call.id,
                result: applyOverrides(call, forwarded.result, state),
              };
            })
          );
          sendJson(res, 200, Array.isArray(parsed) ? results : results[0]);
        } catch (error) {
          sendJson(
            res,
            200,
            errorFor(calls[0], error instanceof Error ? error.message : "proxy failure")
          );
        }
      })();
    });
  });

  // Bind to all interfaces so both host-side test code (127.0.0.1) and
  // containerized services (host.docker.internal) can reach the same proxy.
  await new Promise<void>((resolve) => server.listen(port, "0.0.0.0", resolve));
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    hostUrl: `http://host.docker.internal:${address.port}`,
    state,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

export interface ProxySet {
  proxies: RpcProxy[];
  close(): Promise<void>;
}

/** Start `count` distinct proxy URLs that all forward to one upstream chain. */
export async function startQuorumProxies(upstreamUrl: string, count = 3): Promise<ProxySet> {
  const proxies: RpcProxy[] = [];
  for (let i = 0; i < count; i++) {
    proxies.push(await startRpcProxy(upstreamUrl, 0));
  }
  return {
    proxies,
    close: async () => {
      await Promise.all(proxies.map((proxy) => proxy.close()));
    },
  };
}

/** Read a value via JSON-RPC directly (used to prove proxies remain real). */
export async function rpcCall<T = unknown>(
  url: string,
  method: string,
  params: unknown[] = []
): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const json = (await res.json()) as { result?: T; error?: { message: string } };
  if (json.error) throw new Error(json.error.message);
  return json.result as T;
}

export function randomBlockHash(seed: number): Hex {
  const hex = seed.toString(16).padStart(2, "0");
  return `0x${hex.repeat(32).slice(0, 64)}` as Hex;
}

export type { AddressInfo };
