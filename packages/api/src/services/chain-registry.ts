/**
 * Canonical RPC endpoint registry + quorum reader.
 *
 * Responsibilities:
 *  - Take an explicit, operator-configured list of RPC endpoints, each with a
 *    stable endpoint id and an expected EIP-155 chain id.
 *  - Validate every endpoint at startup via `eth_chainId`. Wrong chain is a
 *    hard, fail-closed error. Unreachable endpoints are also rejected at
 *    startup (an unvalidated endpoint must never serve settlement reads).
 *  - Reject duplicate endpoints by resolved socket identity (DNS-resolved IP +
 *    effective port), so aliases, different paths/query keys on the same
 *    provider host:port, and overlapping IP sets are all detected. Distinct
 *    configured ports (e.g. two local proxies) remain independent participants.
 *  - Require at least two validated participants per chain: settlement reads
 *    must never be satisfiable by a single endpoint.
 *  - Serve reads through quorum: settlement-critical reads (receipts, canonical
 *    block identity, treasury balances, settlement height) require enough
 *    independent, agreeing responses and fail closed on any disagreement.
 *    Non-critical reads (ordinary block number) may fall back to a responsive
 *    endpoint.
 *  - On disagreement, await durable evidence and await the freeze handler
 *    (never fire-and-forget). Evidence never contains raw credential URLs or
 *    raw upstream error messages.
 *
 * The module is deliberately free of signing/private keys; it only ever creates
 * public HTTP viem clients.
 */

import { lookup } from "node:dns/promises";
import { TransactionReceiptNotFoundError, createPublicClient, http, parseAbi } from "viem";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface RpcEndpointConfig {
  /** Stable, operator-assigned id. Unique across every endpoint. */
  id: string;
  /** Expected EIP-155 chain id. Validated against `eth_chainId` at startup. */
  chainId: number;
  /** HTTP(S) RPC URL. */
  url: string;
  /** Optional display label used in evidence. Defaults to `id`. */
  label?: string;
}

export interface NormalizedLog {
  address: string;
  topics: string[];
  data: string;
  logIndex: number;
  removed: boolean;
}

export interface NormalizedReceipt {
  transactionHash: string;
  blockHash: string;
  blockNumber: bigint;
  from: string;
  to: string | null;
  contractAddress: string | null;
  status: "success" | "reverted";
  logs: NormalizedLog[];
}

export interface NormalizedBlock {
  number: bigint;
  hash: string;
  parentHash: string;
}

/** Minimal structural client contract. The default implementation wraps viem. */
export interface QuorumRpcClient {
  getChainId(): Promise<bigint>;
  getBlockNumber(): Promise<bigint>;
  getBlock(args: { blockNumber: bigint } | { blockHash: string }): Promise<NormalizedBlock>;
  getTransactionReceipt(args: { hash: string }): Promise<NormalizedReceipt | null>;
  getBalance(args: { address: string }): Promise<bigint>;
  getTokenBalance(args: { token: string; owner: string }): Promise<bigint>;
  getTransactionCount(args: { address: string; blockTag: "latest" | "pending" }): Promise<bigint>;
}

export interface RpcClientFactoryOptions {
  timeoutMs: number;
  fetch?: typeof globalThis.fetch;
}

export type RpcClientFactory = (
  endpoint: RpcEndpointConfig,
  options: RpcClientFactoryOptions
) => QuorumRpcClient;

/** Resolves a hostname to one or more IP addresses. Injected in unit tests. */
export type HostResolver = (hostname: string) => Promise<string[]>;

export type RegistryIncidentKind = "RPC_DISAGREEMENT" | "RPC_QUORUM_FAILURE";

export interface RegistryIncidentEvidence {
  chainId: number;
  method: string;
  reason: string;
  /**
   * Endpoint observations. `endpoint` is a redacted origin (`scheme://host:port`)
   * with path/query/userinfo stripped so credentials embedded in RPC URLs are
   * never persisted as incident evidence. `error` is a sanitized message.
   */
  endpoints: Array<{
    id: string;
    endpoint: string;
    ok: boolean;
    fingerprint?: string;
    error?: string;
  }>;
}

export interface RegistryIncident {
  kind: RegistryIncidentKind;
  severity: "CRITICAL";
  status: "OPEN";
  chainId: number;
  evidence: RegistryIncidentEvidence;
}

export interface IncidentSink {
  record(incident: RegistryIncident): Promise<void>;
}

export interface RegistryLogger {
  info(obj: Record<string, unknown>, msg?: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
  error(obj: Record<string, unknown>, msg?: string): void;
}

export interface ChainRegistryOptions {
  endpoints: RpcEndpointConfig[];
  /** Explicit quorum size. Defaults to a majority of validated participants. */
  quorum?: number;
  /** Allowed spread (in blocks) for non-critical block-number reads. Default 2. */
  blockNumberTolerance?: number;
  /** Per-request transport timeout. Default 10_000ms. */
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
  createClient?: RpcClientFactory;
  resolveHost?: HostResolver;
  incidentSink?: IncidentSink;
  onFreeze?: (chainId: number, evidence: RegistryIncidentEvidence) => void | Promise<void>;
  logger?: RegistryLogger;
}

/** Receipt, its canonical block, and quorum-derived confirmation depth. */
export interface CanonicalReceipt {
  receipt: NormalizedReceipt;
  block: NormalizedBlock;
  confirmations: number;
}

/** Read surface reused by native-gas, treasury and custody callers. */
export interface QuorumReader {
  getTransactionReceipt(chainId: number, txHash: string): Promise<NormalizedReceipt | null>;
  getBlock(
    chainId: number,
    ref: { blockNumber: bigint } | { blockHash: string }
  ): Promise<NormalizedBlock>;
  getBlockNumber(chainId: number): Promise<bigint>;
  /** Quorum-bounded height used for settlement confirmation depth. */
  getSettlementBlockNumber(chainId: number): Promise<bigint>;
  getBalance(chainId: number, address: string): Promise<bigint>;
  getTokenBalance(chainId: number, token: string, owner: string): Promise<bigint>;
  getTransactionCount(
    chainId: number,
    address: string,
    blockTag?: "latest" | "pending"
  ): Promise<bigint>;
  getCanonicalReceipt(chainId: number, txHash: string): Promise<CanonicalReceipt | null>;
  isChainAuthorized(chainId: number): boolean;
}

// ---------------------------------------------------------------------------
// Errors (never embed raw URLs; only redacted origins / endpoint ids)
// ---------------------------------------------------------------------------

export class RpcEndpointError extends Error {
  constructor(
    message: string,
    public readonly endpointId?: string
  ) {
    super(message);
    this.name = "RpcEndpointError";
  }
}

export class RpcChainMismatchError extends RpcEndpointError {
  constructor(
    public readonly endpointId: string,
    public readonly expectedChainId: number,
    public readonly actualChainId: number,
    public readonly redactedOrigin: string
  ) {
    super(
      `RPC endpoint "${endpointId}" reports chain ${actualChainId}, expected ${expectedChainId} (${redactedOrigin})`,
      endpointId
    );
    this.name = "RpcChainMismatchError";
  }
}

export class RpcDuplicateEndpointError extends RpcEndpointError {
  constructor(
    public readonly socketIdentity: string,
    public readonly endpointIds: string[]
  ) {
    super(
      `Duplicate RPC endpoint socket ${socketIdentity} shared by endpoints: ${endpointIds.join(", ")}`
    );
    this.name = "RpcDuplicateEndpointError";
  }
}

export class RpcQuorumError extends Error {
  constructor(
    message: string,
    public readonly chainId: number,
    public readonly evidence: RegistryIncidentEvidence
  ) {
    super(message);
    this.name = "RpcQuorumError";
  }
}

export class RpcDisagreementError extends RpcQuorumError {
  constructor(chainId: number, evidence: RegistryIncidentEvidence) {
    super(`RPC quorum disagreement on chain ${chainId} for ${evidence.method}`, chainId, evidence);
    this.name = "RpcDisagreementError";
  }
}

export class ChainFrozenError extends Error {
  constructor(public readonly chainId: number) {
    super(`Chain ${chainId} is frozen after an RPC integrity failure`);
    this.name = "ChainFrozenError";
  }
}

/** Minimum validated participants required for any chain. */
export const MINIMUM_CHAIN_PARTICIPANTS = 2;

// ---------------------------------------------------------------------------
// ERC20 Transfer parsing (no ABI dependency; works on raw log topics)
// ---------------------------------------------------------------------------

export const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

export interface ParsedErc20Transfer {
  from: string;
  to: string;
  amount: bigint;
}

/**
 * Parse a raw ERC20 `Transfer(address,address,uint256)` log. Returns null for
 * non-Transfer logs, malformed logs, or logs marked `removed`.
 */
export function parseErc20Transfer(log: NormalizedLog): ParsedErc20Transfer | null {
  if (log.removed) return null;
  const topics = (log.topics ?? []).map((topic) => topic.toLowerCase());
  if (topics.length !== 3 || topics[0] !== TRANSFER_TOPIC) return null;
  if (topics[1].length < 40 || topics[2].length < 40) return null;

  const from = `0x${topics[1].slice(-40)}`;
  const to = `0x${topics[2].slice(-40)}`;

  const rawData = !log.data || log.data === "0x" ? "0x0" : log.data;
  let amount: bigint;
  try {
    amount = BigInt(rawData);
  } catch {
    return null;
  }
  if (amount < 0n) return null;
  return { from, to, amount };
}

// ---------------------------------------------------------------------------
// URL / socket normalization
// ---------------------------------------------------------------------------

/** `scheme://host:port` only; strips path/query/userinfo (API keys). */
export function redactEndpointUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    return `${url.protocol}//${url.hostname}${url.port ? `:${url.port}` : ""}`;
  } catch {
    return "<redacted>";
  }
}

/** Strip embedded URLs (which may carry credentials) from provider messages. */
export function sanitizeErrorMessage(message: string): string {
  return message.replace(/https?:\/\/[^\s"'<>]+/gi, (match) => redactEndpointUrl(match));
}

function effectivePort(rawUrl: string): string {
  const url = new URL(rawUrl);
  if (url.port) return url.port;
  if (url.protocol === "https:") return "443";
  if (url.protocol === "http:") return "80";
  return "";
}

function normalizeAddressLiteral(address: string): string {
  const lower = address
    .toLowerCase()
    .trim()
    .replace(/^\[|\]$/g, "");
  // IPv4-mapped IPv6 (::ffff:127.0.0.1) is the same socket as 127.0.0.1.
  // Node's URL parser canonicalizes the mapped form to hex (::ffff:7f00:1).
  const mappedDotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mappedDotted) return mappedDotted[1];
  const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (mappedHex) {
    const high = Number.parseInt(mappedHex[1], 16);
    const low = Number.parseInt(mappedHex[2], 16);
    return `${(high >> 8) & 255}.${high & 255}.${(low >> 8) & 255}.${low & 255}`;
  }
  return lower;
}

/**
 * Resolve an endpoint to the set of `IP:port` sockets it may use. Two endpoints
 * are duplicates when their socket sets overlap: different paths/query keys on
 * the same resolved provider host:port are NOT independent, while distinct
 * ports (local proxies) are.
 */
export async function resolveEndpointSockets(
  endpoint: RpcEndpointConfig,
  resolveHost: HostResolver
): Promise<string[]> {
  let url: URL;
  try {
    url = new URL(endpoint.url);
  } catch {
    throw new RpcEndpointError(`RPC endpoint "${endpoint.id}" has an invalid URL`, endpoint.id);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new RpcEndpointError(`RPC endpoint "${endpoint.id}" must use http(s)`, endpoint.id);
  }

  let addresses: string[];
  // `URL.hostname` keeps IPv6 literals bracketed; DNS resolvers and socket
  // identities want the bare address.
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const port = effectivePort(endpoint.url);
  try {
    addresses = await resolveHost(hostname);
  } catch (error) {
    throw new RpcEndpointError(
      `RPC endpoint "${endpoint.id}" host could not be resolved: ${sanitizeErrorMessage(
        errorMessage(error)
      )}`,
      endpoint.id
    );
  }
  if (addresses.length === 0) {
    throw new RpcEndpointError(
      `RPC endpoint "${endpoint.id}" host resolved to no addresses`,
      endpoint.id
    );
  }

  return [...new Set(addresses.map((address) => `${normalizeAddressLiteral(address)}:${port}`))];
}

/** Async duplicate check. Ids and URLs are validated synchronously first. */
export async function assertUniqueEndpoints(
  endpoints: RpcEndpointConfig[],
  resolveHost: HostResolver = defaultHostResolver
): Promise<void> {
  const ids = new Set<string>();
  for (const endpoint of endpoints) {
    if (!endpoint.id || endpoint.id.trim().length === 0) {
      throw new RpcEndpointError("RPC endpoint is missing an explicit id", endpoint.id);
    }
    if (ids.has(endpoint.id)) {
      throw new RpcDuplicateEndpointError(`id:${endpoint.id}`, [endpoint.id, endpoint.id]);
    }
    ids.add(endpoint.id);
  }

  const owners = new Map<string, string>();
  for (const endpoint of endpoints) {
    const sockets = await resolveEndpointSockets(endpoint, resolveHost);
    for (const socket of sockets) {
      const existing = owners.get(socket);
      if (existing && existing !== endpoint.id) {
        throw new RpcDuplicateEndpointError(socket, [existing, endpoint.id]);
      }
      owners.set(socket, endpoint.id);
    }
  }
}

export async function defaultHostResolver(hostname: string): Promise<string[]> {
  const results = await lookup(hostname, { all: true });
  return results.map((result) => result.address);
}

// ---------------------------------------------------------------------------
// Normalization helpers
// ---------------------------------------------------------------------------

function canonicalJson(value: unknown): string {
  if (typeof value === "bigint") return `"${value.toString()}"`;
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0
  );
  return `{${entries
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(",")}}`;
}

export function receiptFingerprint(receipt: NormalizedReceipt | null): string {
  if (receipt === null) return "null";
  return canonicalJson({
    tx: receipt.transactionHash,
    blockHash: receipt.blockHash,
    blockNumber: receipt.blockNumber,
    from: receipt.from,
    to: receipt.to,
    contractAddress: receipt.contractAddress,
    status: receipt.status,
    logs: receipt.logs.map((log) => ({
      address: log.address,
      topics: log.topics,
      data: log.data,
      logIndex: log.logIndex,
      removed: log.removed,
    })),
  });
}

export function blockFingerprint(block: NormalizedBlock): string {
  return canonicalJson({
    number: block.number,
    hash: block.hash,
    parentHash: block.parentHash,
  });
}

// ---------------------------------------------------------------------------
// Default viem client factory (public HTTP only, never signs)
// ---------------------------------------------------------------------------

const ERC20_BALANCE_ABI = parseAbi(["function balanceOf(address owner) view returns (uint256)"]);

function normalizeAddress(value: string): string {
  return value.toLowerCase();
}

function normalizeStatus(status: unknown): "success" | "reverted" {
  if (status === "success" || status === 1 || status === 1n || status === "0x1") return "success";
  return "reverted";
}

export function createDefaultRpcClient(
  endpoint: RpcEndpointConfig,
  options: RpcClientFactoryOptions
): QuorumRpcClient {
  const transport = http(endpoint.url, {
    timeout: options.timeoutMs,
    ...(options.fetch ? { fetchFn: options.fetch } : {}),
  });
  const client = createPublicClient({ transport });

  return {
    async getChainId() {
      return BigInt(await client.getChainId());
    },
    async getBlockNumber() {
      return client.getBlockNumber({ cacheTime: 0 });
    },
    async getBlock(args) {
      const block =
        "blockHash" in args
          ? await client.getBlock({ blockHash: args.blockHash as `0x${string}` })
          : await client.getBlock({ blockNumber: args.blockNumber });
      return {
        number: block.number ?? 0n,
        hash: normalizeAddress(block.hash),
        parentHash: normalizeAddress(block.parentHash),
      };
    },
    async getTransactionReceipt(args) {
      let receipt;
      try {
        receipt = await client.getTransactionReceipt({ hash: args.hash as `0x${string}` });
      } catch (error) {
        // A genuinely absent receipt is a valid observation ("no receipt"),
        // not an infrastructure failure. Every other error (transport,
        // timeout, malformed response) must surface as an endpoint failure so
        // an RPC outage can never be mistaken for a missing/reorged receipt.
        if (error instanceof TransactionReceiptNotFoundError) return null;
        throw error;
      }
      if (!receipt) return null;
      return {
        transactionHash: normalizeAddress(receipt.transactionHash),
        blockHash: normalizeAddress(receipt.blockHash),
        blockNumber: receipt.blockNumber,
        from: normalizeAddress(receipt.from),
        to: receipt.to ? normalizeAddress(receipt.to) : null,
        contractAddress: receipt.contractAddress ? normalizeAddress(receipt.contractAddress) : null,
        status: normalizeStatus(receipt.status),
        logs: receipt.logs.map((log) => ({
          address: normalizeAddress(log.address),
          topics: log.topics.map((topic) => topic.toLowerCase()),
          data: log.data,
          logIndex: log.logIndex ?? 0,
          removed: Boolean(log.removed),
        })),
      };
    },
    async getBalance(args) {
      return client.getBalance({ address: args.address as `0x${string}` });
    },
    async getTokenBalance(args) {
      const result = await client.readContract({
        address: args.token as `0x${string}`,
        abi: ERC20_BALANCE_ABI,
        functionName: "balanceOf",
        args: [args.owner as `0x${string}`],
      });
      return BigInt(result);
    },
    async getTransactionCount(args) {
      return BigInt(
        await client.getTransactionCount({
          address: args.address as `0x${string}`,
          blockTag: args.blockTag,
        })
      );
    },
  };
}

// ---------------------------------------------------------------------------
// ChainRegistry
// ---------------------------------------------------------------------------

interface ReadOutcome<T> {
  endpointId: string;
  url: string;
  ok: boolean;
  value?: T;
  fingerprint?: string;
  error?: string;
}

export class ChainRegistry implements QuorumReader {
  private readonly endpoints: RpcEndpointConfig[];
  private readonly configuredQuorum?: number;
  private readonly blockNumberTolerance: number;
  private readonly timeoutMs: number;
  private readonly factory: RpcClientFactory;
  private readonly resolveHost: HostResolver;
  private readonly incidentSink?: IncidentSink;
  private readonly onFreeze?: ChainRegistryOptions["onFreeze"];
  private readonly logger?: RegistryLogger;

  private readonly clients = new Map<string, QuorumRpcClient>();
  private readonly frozenChains = new Set<number>();
  private startPromise: Promise<void> | null = null;

  constructor(options: ChainRegistryOptions) {
    this.endpoints = options.endpoints;
    this.configuredQuorum = options.quorum;
    this.blockNumberTolerance = options.blockNumberTolerance ?? 2;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.resolveHost = options.resolveHost ?? defaultHostResolver;
    this.factory =
      options.createClient ??
      ((endpoint, factoryOptions) =>
        createDefaultRpcClient(endpoint, {
          timeoutMs: factoryOptions.timeoutMs,
          fetch: factoryOptions.fetch ?? options.fetch,
        }));
    this.incidentSink = options.incidentSink;
    this.onFreeze = options.onFreeze;
    this.logger = options.logger;
  }

  /** Validate endpoints, quorum topology and chain ids. Idempotent. */
  async start(): Promise<void> {
    if (!this.startPromise) {
      this.startPromise = this.doStart();
    }
    return this.startPromise;
  }

  private async doStart(): Promise<void> {
    await assertUniqueEndpoints(this.endpoints, this.resolveHost);

    // Quorum topology must be validated before any endpoint is trusted.
    for (const chainId of this.getChainIds()) {
      const participants = this.getEndpoints(chainId).length;
      if (participants < MINIMUM_CHAIN_PARTICIPANTS) {
        throw new RpcEndpointError(
          `Chain ${chainId} has ${participants} endpoint(s); at least ${MINIMUM_CHAIN_PARTICIPANTS} independent participants are required`,
          undefined
        );
      }
      // An explicit quorum is never clamped: a value above the participant
      // count, a non-integer, or a value below the two-endpoint settlement
      // minimum (which would let one endpoint satisfy a critical read) is
      // rejected at startup rather than silently reduced with Math.min.
      if (
        this.configuredQuorum !== undefined &&
        (!Number.isInteger(this.configuredQuorum) ||
          this.configuredQuorum < MINIMUM_CHAIN_PARTICIPANTS ||
          this.configuredQuorum > participants)
      ) {
        throw new RpcEndpointError(
          `Configured quorum ${this.configuredQuorum} is invalid for chain ${chainId} with ${participants} participants`,
          undefined
        );
      }
    }

    for (const endpoint of this.endpoints) {
      const client = this.factory(endpoint, { timeoutMs: this.timeoutMs });
      let actualChainId: number;
      try {
        actualChainId = Number(await this.withTimeout(client.getChainId(), endpoint.id));
      } catch (error) {
        throw new RpcEndpointError(
          `RPC endpoint "${endpoint.id}" could not be validated via eth_chainId: ${sanitizeErrorMessage(
            errorMessage(error)
          )}`,
          endpoint.id
        );
      }
      if (!Number.isInteger(actualChainId) || actualChainId <= 0) {
        throw new RpcEndpointError(
          `RPC endpoint "${endpoint.id}" returned an invalid chain id: ${actualChainId}`,
          endpoint.id
        );
      }
      if (actualChainId !== endpoint.chainId) {
        throw new RpcChainMismatchError(
          endpoint.id,
          endpoint.chainId,
          actualChainId,
          redactEndpointUrl(endpoint.url)
        );
      }
      this.clients.set(endpoint.id, client);
    }

    this.logger?.info(
      { endpoints: this.endpoints.length, chains: this.getChainIds() },
      "Chain registry validated all RPC endpoints"
    );
  }

  getChainIds(): number[] {
    return [...new Set(this.endpoints.map((endpoint) => endpoint.chainId))].sort((a, b) => a - b);
  }

  getEndpoints(chainId: number): RpcEndpointConfig[] {
    return this.endpoints.filter((endpoint) => endpoint.chainId === chainId);
  }

  /**
   * Chain authorization: a chain is authorized only when at least the minimum
   * number of endpoints was explicitly configured for it (and validated at
   * startup). An asset whose chain is absent from the registry must never be
   * settled.
   */
  isChainAuthorized(chainId: number): boolean {
    return this.getEndpoints(chainId).length >= MINIMUM_CHAIN_PARTICIPANTS;
  }

  isFrozen(chainId: number): boolean {
    return this.frozenChains.has(chainId);
  }

  /**
   * Freeze a chain. Awaits the durable freeze handler; a freeze is never
   * fire-and-forget. Used by RPC disagreement handling and by deposit reorg
   * handling. Record-keeping of the triggering incident is the caller's job.
   */
  async freezeChain(chainId: number, evidence: RegistryIncidentEvidence): Promise<void> {
    const already = this.frozenChains.has(chainId);
    this.frozenChains.add(chainId);
    if (already) return;

    this.logger?.error({ chainId, evidence }, "Chain frozen after integrity failure");
    if (this.onFreeze) {
      try {
        await this.onFreeze(chainId, evidence);
      } catch (error) {
        this.logger?.error(
          { chainId, error: sanitizeErrorMessage(errorMessage(error)) },
          "Freeze handler failed (chain remains frozen)"
        );
      }
    }
  }

  /** Explicit operator action to clear a freeze. */
  thawChain(chainId: number): void {
    this.frozenChains.delete(chainId);
  }

  private quorumSize(chainId: number): number {
    const count = this.getEndpoints(chainId).length;
    if (this.configuredQuorum !== undefined) return this.configuredQuorum;
    return Math.floor(count / 2) + 1;
  }

  private async withTimeout<T>(promise: Promise<T>, endpointId: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<T>((_resolve, reject) => {
          timer = setTimeout(
            () =>
              reject(new Error(`RPC request timed out after ${this.timeoutMs}ms (${endpointId})`)),
            this.timeoutMs
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async collect<T>(
    chainId: number,
    method: string,
    call: (client: QuorumRpcClient, endpoint: RpcEndpointConfig) => Promise<T>,
    fingerprint: (value: T) => string
  ): Promise<Array<ReadOutcome<T>>> {
    const endpoints = this.getEndpoints(chainId);
    return Promise.all(
      endpoints.map(async (endpoint): Promise<ReadOutcome<T>> => {
        const client = this.clients.get(endpoint.id);
        if (!client) {
          return { endpointId: endpoint.id, url: endpoint.url, ok: false, error: "not validated" };
        }
        try {
          const value = await this.withTimeout(call(client, endpoint), endpoint.id);
          return {
            endpointId: endpoint.id,
            url: endpoint.url,
            ok: true,
            value,
            fingerprint: fingerprint(value),
          };
        } catch (error) {
          return {
            endpointId: endpoint.id,
            url: endpoint.url,
            ok: false,
            error: sanitizeErrorMessage(errorMessage(error)),
          };
        }
      })
    );
  }

  private buildEvidence(
    chainId: number,
    method: string,
    reason: string,
    outcomes: Array<ReadOutcome<unknown>>
  ): RegistryIncidentEvidence {
    return {
      chainId,
      method,
      reason,
      endpoints: outcomes.map((outcome) => ({
        id: outcome.endpointId,
        endpoint: redactEndpointUrl(outcome.url),
        ok: outcome.ok,
        ...(outcome.fingerprint ? { fingerprint: outcome.fingerprint } : {}),
        ...(outcome.error ? { error: sanitizeErrorMessage(outcome.error) } : {}),
      })),
    };
  }

  private async recordIncident(incident: RegistryIncident): Promise<void> {
    this.logger?.error({ incident }, "RPC integrity incident");
    if (!this.incidentSink) return;
    try {
      await this.incidentSink.record(incident);
    } catch (error) {
      this.logger?.error(
        { error: sanitizeErrorMessage(errorMessage(error)) },
        "Failed to record RPC incident (durable sink)"
      );
    }
  }

  /**
   * Quorum read.
   *
   * Critical reads require at least `quorum` successful responses and unanimous
   * agreement among them. Disagreement awaits `RPC_DISAGREEMENT` evidence +
   * freeze then throws. Insufficient responses await `RPC_QUORUM_FAILURE`
   * evidence and throw.
   *
   * Non-critical reads may fall back to any responsive endpoint; when responses
   * disagree, the value backed by the most endpoints wins. No freeze is
   * triggered for non-critical reads.
   */
  private async read<T>(
    chainId: number,
    method: string,
    call: (client: QuorumRpcClient, endpoint: RpcEndpointConfig) => Promise<T>,
    fingerprint: (value: T) => string,
    options: { critical: boolean }
  ): Promise<T> {
    await this.start();
    if (options.critical && this.isFrozen(chainId)) {
      throw new ChainFrozenError(chainId);
    }

    const outcomes = await this.collect(chainId, method, call, fingerprint);
    const successes = outcomes.filter((outcome) => outcome.ok) as Array<
      ReadOutcome<T> & { value: T }
    >;
    const quorum = this.quorumSize(chainId);

    if (successes.length === 0) {
      const evidence = this.buildEvidence(chainId, method, "no_responses", outcomes);
      await this.recordIncident({
        kind: "RPC_QUORUM_FAILURE",
        severity: "CRITICAL",
        status: "OPEN",
        chainId,
        evidence,
      });
      throw new RpcQuorumError(
        `No RPC endpoint responded for ${method} on chain ${chainId}`,
        chainId,
        evidence
      );
    }

    const groups = new Map<string, T[]>();
    for (const outcome of successes) {
      const key = outcome.fingerprint!;
      const bucket = groups.get(key);
      if (bucket) bucket.push(outcome.value);
      else groups.set(key, [outcome.value]);
    }

    if (groups.size === 1) {
      const value = successes[0].value;
      if (options.critical && successes.length < quorum) {
        const evidence = this.buildEvidence(chainId, method, "insufficient_quorum", outcomes);
        await this.recordIncident({
          kind: "RPC_QUORUM_FAILURE",
          severity: "CRITICAL",
          status: "OPEN",
          chainId,
          evidence,
        });
        throw new RpcQuorumError(
          `Insufficient quorum for ${method} on chain ${chainId}: ${successes.length}/${quorum}`,
          chainId,
          evidence
        );
      }
      if (successes.length < quorum) {
        this.logger?.warn(
          { chainId, method, responses: successes.length, quorum },
          "Non-critical read served below quorum (fallback allowed)"
        );
      }
      return value;
    }

    // Responses disagree.
    const evidence = this.buildEvidence(chainId, method, "response_disagreement", outcomes);
    if (options.critical) {
      await this.recordIncident({
        kind: "RPC_DISAGREEMENT",
        severity: "CRITICAL",
        status: "OPEN",
        chainId,
        evidence,
      });
      await this.freezeChain(chainId, evidence);
      throw new RpcDisagreementError(chainId, evidence);
    }

    this.logger?.warn(
      { chainId, method, groups: groups.size },
      "Non-critical RPC disagreement; using majority response"
    );
    let best: T[] | null = null;
    for (const group of groups.values()) {
      if (!best || group.length > best.length) best = group;
    }
    return best![0];
  }

  // -------------------------------------------------------------------------
  // QuorumReader implementation
  // -------------------------------------------------------------------------

  async getTransactionReceipt(chainId: number, txHash: string): Promise<NormalizedReceipt | null> {
    return this.read(
      chainId,
      "eth_getTransactionReceipt",
      (client) => client.getTransactionReceipt({ hash: txHash }),
      receiptFingerprint,
      { critical: true }
    );
  }

  async getBlock(
    chainId: number,
    ref: { blockNumber: bigint } | { blockHash: string }
  ): Promise<NormalizedBlock> {
    return this.read(
      chainId,
      "eth_getBlockByNumber",
      (client) => client.getBlock(ref),
      blockFingerprint,
      { critical: true }
    );
  }

  /**
   * Non-critical height read. Different endpoints are expected to lag each
   * other (or may be down), so fallback is allowed. The minimum height is
   * returned so confirmation estimates stay conservative. Zero responses still
   * fail closed.
   */
  async getBlockNumber(chainId: number): Promise<bigint> {
    await this.start();
    const outcomes = await this.collect(
      chainId,
      "eth_blockNumber",
      (client) => client.getBlockNumber(),
      (value) => value.toString()
    );
    const successes = outcomes.filter((outcome) => outcome.ok) as Array<
      ReadOutcome<bigint> & { value: bigint }
    >;

    if (successes.length === 0) {
      const evidence = this.buildEvidence(chainId, "eth_blockNumber", "no_responses", outcomes);
      await this.recordIncident({
        kind: "RPC_QUORUM_FAILURE",
        severity: "CRITICAL",
        status: "OPEN",
        chainId,
        evidence,
      });
      throw new RpcQuorumError(
        `No RPC endpoint responded for eth_blockNumber on chain ${chainId}`,
        chainId,
        evidence
      );
    }

    const heights = successes.map((outcome) => outcome.value);
    const min = heights.reduce((acc, value) => (value < acc ? value : acc));
    const max = heights.reduce((acc, value) => (value > acc ? value : acc));
    const quorum = this.quorumSize(chainId);

    if (max - min > BigInt(this.blockNumberTolerance)) {
      this.logger?.warn(
        {
          chainId,
          method: "eth_blockNumber",
          min: min.toString(),
          max: max.toString(),
          tolerance: this.blockNumberTolerance,
        },
        "RPC height spread exceeds tolerance (non-critical, using minimum)"
      );
    } else if (successes.length < quorum) {
      this.logger?.warn(
        { chainId, method: "eth_blockNumber", responses: successes.length, quorum },
        "Non-critical read served below quorum (fallback allowed)"
      );
    }

    return min;
  }

  /**
   * Settlement height: requires at least `quorum` successful responses and
   * returns the conservative minimum height. A single fallback endpoint must
   * never determine confirmation depth for a credit.
   */
  async getSettlementBlockNumber(chainId: number): Promise<bigint> {
    await this.start();
    if (this.isFrozen(chainId)) throw new ChainFrozenError(chainId);

    const outcomes = await this.collect(
      chainId,
      "eth_blockNumber:settlement",
      (client) => client.getBlockNumber(),
      (value) => value.toString()
    );
    const successes = outcomes.filter((outcome) => outcome.ok) as Array<
      ReadOutcome<bigint> & { value: bigint }
    >;
    const quorum = this.quorumSize(chainId);

    if (successes.length < quorum) {
      const evidence = this.buildEvidence(
        chainId,
        "eth_blockNumber:settlement",
        "insufficient_quorum",
        outcomes
      );
      await this.recordIncident({
        kind: "RPC_QUORUM_FAILURE",
        severity: "CRITICAL",
        status: "OPEN",
        chainId,
        evidence,
      });
      throw new RpcQuorumError(
        `Insufficient quorum for settlement height on chain ${chainId}: ${successes.length}/${quorum}`,
        chainId,
        evidence
      );
    }

    return successes
      .map((outcome) => outcome.value)
      .reduce((acc, value) => (value < acc ? value : acc));
  }

  async getBalance(chainId: number, address: string): Promise<bigint> {
    return this.read(
      chainId,
      "eth_getBalance",
      (client) => client.getBalance({ address }),
      (value) => value.toString(),
      { critical: true }
    );
  }

  async getTokenBalance(chainId: number, token: string, owner: string): Promise<bigint> {
    return this.read(
      chainId,
      "eth_call:balanceOf",
      (client) => client.getTokenBalance({ token, owner }),
      (value) => value.toString(),
      { critical: true }
    );
  }

  /**
   * Treasury nonce read. Uses `pending` so a pending (not-yet-mined) outgoing
   * transaction is counted, and `latest` for a mined-nonce fence. Critical:
   * a nonce must never be derived from a single fallback endpoint.
   */
  async getTransactionCount(
    chainId: number,
    address: string,
    blockTag: "latest" | "pending" = "pending"
  ): Promise<bigint> {
    return this.read(
      chainId,
      `eth_getTransactionCount:${blockTag}`,
      (client) => client.getTransactionCount({ address, blockTag }),
      (value) => value.toString(),
      { critical: true }
    );
  }

  /**
   * Fetch the receipt and confirm the canonical block hash at the receipt's
   * block number in one place. Confirmation depth comes from a quorum-bounded
   * settlement height, never a single fallback endpoint.
   */
  async getCanonicalReceipt(chainId: number, txHash: string): Promise<CanonicalReceipt | null> {
    if (!this.isChainAuthorized(chainId)) {
      throw new RpcQuorumError(`Chain ${chainId} is not authorized in the registry`, chainId, {
        chainId,
        method: "canonical_receipt",
        reason: "chain_not_authorized",
        endpoints: [],
      });
    }
    const receipt = await this.getTransactionReceipt(chainId, txHash);
    if (receipt === null) return null;
    const block = await this.getBlock(chainId, { blockNumber: receipt.blockNumber });
    if (block.hash !== receipt.blockHash) {
      const evidence: RegistryIncidentEvidence = {
        chainId,
        method: "canonical_receipt",
        reason: "block_hash_mismatch",
        endpoints: [
          { id: "receipt", endpoint: "internal", ok: true, fingerprint: receipt.blockHash },
          { id: "block", endpoint: "internal", ok: true, fingerprint: block.hash },
        ],
      };
      await this.recordIncident({
        kind: "RPC_DISAGREEMENT",
        severity: "CRITICAL",
        status: "OPEN",
        chainId,
        evidence,
      });
      await this.freezeChain(chainId, evidence);
      throw new RpcDisagreementError(chainId, evidence);
    }
    const head = await this.getSettlementBlockNumber(chainId);
    // Inclusive depth: the receipt's own block counts as the first
    // confirmation, matching the custody workflow and deposit monitor.
    const confirmations = Number(head - receipt.blockNumber) + 1;
    return { receipt, block, confirmations: confirmations < 0 ? 0 : confirmations };
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
