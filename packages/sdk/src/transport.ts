/**
 * Shared REST transport for the PokerTools SDK.
 *
 * This is the single implementation of authenticated JSON HTTP with timeout,
 * bounded retry and typed error mapping. `PokerClient` and `CompetitionClient`
 * compose it; neither wraps the other.
 *
 * Retry safety: reads (GET) are always retried. A mutation is retried only when
 * the caller explicitly declares the operation retry-safe (`retrySafe: true`,
 * for naturally idempotent resource operations such as competition
 * opt-in/start/settle/cancel) or when its body carries a stable
 * server-recognized identity (`idempotencyKey`, canonical `requestId`, a signed
 * withdrawal intent, or an exact deposit log identity). The identical serialized
 * bytes are replayed, so a lost response can never create a second logical
 * mutation; arbitrary mutations are never replayed on a guess.
 */

import { PokerSDKConfig, PokerSDKError } from "./types";

const DEFAULT_TRANSPORT_CONFIG = {
  timeout: 30000,
  retry: {
    count: 3,
    delay: 1000,
    backoff: 2,
  },
};

/**
 * A body is safe to replay automatically only when it carries a stable
 * server-recognized identity field.
 */
function hasStableOperationId(body: unknown): boolean {
  if (typeof body !== "object" || body === null) return false;
  const record = body as Record<string, unknown>;

  if (typeof record.idempotencyKey === "string" && record.idempotencyKey.length > 0) {
    return true;
  }
  // Canonical action submission: requestId is the idempotency identity.
  if (typeof record.requestId === "string" && record.requestId.length > 0) {
    return true;
  }
  // EIP-712 withdrawal submission: the signed intent identity is canonical.
  const intent = record.intent;
  if (typeof intent === "object" && intent !== null) {
    const i = intent as Record<string, unknown>;
    if (
      typeof i.intentId === "string" &&
      i.intentId.length > 0 &&
      typeof i.nonce === "number" &&
      Number.isInteger(i.nonce)
    ) {
      return true;
    }
  }
  // Exact deposit log identity (assetId, txHash, logIndex).
  if (
    typeof record.txHash === "string" &&
    typeof record.logIndex === "number" &&
    Number.isInteger(record.logIndex)
  ) {
    return true;
  }
  return false;
}

export interface TransportRequestOptions {
  /**
   * Non-2xx status codes whose bodies are still typed responses (e.g. `/ready`
   * returns 503 with the canonical readiness payload). Those statuses resolve
   * instead of throwing and are never retried. Mutations must not use this to
   * accept failure bodies.
   */
  allowStatus?: readonly number[];
  /**
   * Explicit retry-safety declaration for a mutation whose server operation is
   * naturally idempotent for its resource even though the body carries no
   * idempotency identity (e.g. competition opt-in/start/settle/cancel, whose
   * request bodies are strict empty objects). This is independent of the
   * body-identity heuristic: only set it for operations the server guarantees
   * to be replay-safe, and never for arbitrary mutations.
   */
  retrySafe?: boolean;
}

/**
 * Authenticated JSON transport with timeout, retry and canonical error
 * mapping. Debug logging never includes request bodies, tokens or secrets.
 */
export class PokerHttpTransport {
  private readonly baseUrl: string;
  private readonly timeout: number;
  private readonly retry: Required<NonNullable<PokerSDKConfig["retry"]>>;
  private readonly fetchFn: typeof fetch;
  private readonly debug: boolean;

  private token: string | null;

  constructor(config: PokerSDKConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    this.timeout = config.timeout ?? DEFAULT_TRANSPORT_CONFIG.timeout;
    this.retry = {
      count: config.retry?.count ?? DEFAULT_TRANSPORT_CONFIG.retry.count,
      delay: config.retry?.delay ?? DEFAULT_TRANSPORT_CONFIG.retry.delay,
      backoff: config.retry?.backoff ?? DEFAULT_TRANSPORT_CONFIG.retry.backoff,
    };
    this.fetchFn = config.fetch ?? globalThis.fetch.bind(globalThis);
    this.debug = config.debug ?? false;
    this.token = config.token ?? null;
  }

  /**
   * Set the authentication token. Wallet sessions, scoped SERVICE credentials
   * and orchestration credentials are all opaque bearer tokens; the transport
   * does not distinguish them.
   */
  setToken(token: string | null): void {
    this.token = token;
  }

  getToken(): string | null {
    return this.token;
  }

  /**
   * Make a JSON HTTP request with timeout and retry logic.
   */
  async request<T>(
    method: string,
    path: string,
    body?: unknown,
    options?: TransportRequestOptions
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = { Accept: "application/json" };
    const serializedBody = body === undefined ? undefined : JSON.stringify(body);
    if (serializedBody !== undefined) headers["Content-Type"] = "application/json";

    if (this.token) {
      headers.Authorization = `Bearer ${this.token}`;
    }

    const canRetry = method === "GET" || options?.retrySafe === true || hasStableOperationId(body);
    const retryCount = canRetry ? this.retry.count : 0;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= retryCount; attempt++) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeout);
      try {
        if (this.debug) {
          console.log(`[PokerSDK] ${method} ${path}`);
        }

        const response = await this.fetchFn(url, {
          method,
          headers,
          body: serializedBody,
          signal: controller.signal,
        });

        // Handle 304 Not Modified
        if (response.status === 304) {
          throw new PokerSDKError("Not Modified", "NOT_MODIFIED", 304);
        }

        // Handle non-2xx responses
        if (!response.ok && !options?.allowStatus?.includes(response.status)) {
          const errorData = (await response.json().catch(() => ({}))) as {
            message?: string;
            error?: string;
            code?: string;
          };

          throw new PokerSDKError(
            errorData.message ?? errorData.error ?? `HTTP ${response.status}`,
            errorData.code ?? errorData.error ?? "HTTP_ERROR",
            response.status,
            errorData
          );
        }

        if (response.status === 204 || response.status === 205) return undefined as T;
        const data = (await response.json()) as T;

        if (this.debug) {
          console.log(`[PokerSDK] Response: ${response.status}`);
        }

        return data;
      } catch (error) {
        clearTimeout(timeoutId);
        lastError = error as Error;
        if (error instanceof PokerSDKError && error.statusCode === 304) throw error;

        // Don't retry client errors (4xx) except rate limiting
        if (error instanceof PokerSDKError) {
          if (
            error.statusCode &&
            error.statusCode >= 400 &&
            error.statusCode < 500 &&
            error.statusCode !== 429
          ) {
            throw error;
          }
        }

        // Don't retry on abort
        if (controller.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
          throw new PokerSDKError("Request timeout", "TIMEOUT", undefined, {
            timeout: this.timeout,
          });
        }

        // Retry with backoff
        if (attempt < retryCount) {
          const delay = this.retry.delay * Math.pow(this.retry.backoff, attempt);
          if (this.debug) {
            console.log(`[PokerSDK] Retry ${attempt + 1}/${this.retry.count} in ${delay}ms`);
          }
          await this.sleep(delay);
        }
      } finally {
        clearTimeout(timeoutId);
      }
    }

    throw lastError ?? new PokerSDKError("Request failed", "REQUEST_FAILED");
  }

  /**
   * Sleep helper
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
