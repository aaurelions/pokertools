import { config } from "../config.js";

export class CircuitBreakerOpenError extends Error {
  constructor(serviceName: string) {
    super(`${serviceName} circuit breaker is open`);
    this.name = "CircuitBreakerOpenError";
  }
}

export class CircuitBreaker {
  private failures = 0;
  private openedUntil = 0;

  constructor(private readonly serviceName: string) {}

  beforeRequest() {
    if (Date.now() < this.openedUntil) {
      throw new CircuitBreakerOpenError(this.serviceName);
    }
  }

  recordSuccess() {
    this.failures = 0;
    this.openedUntil = 0;
  }

  recordFailure() {
    this.failures += 1;
    if (this.failures >= config.CIRCUIT_BREAKER_FAILURE_THRESHOLD) {
      this.openedUntil = Date.now() + config.CIRCUIT_BREAKER_OPEN_MS;
    }
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function withRetry<T>(operation: () => Promise<T>, breaker?: CircuitBreaker): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= config.RPC_RETRY_COUNT; attempt++) {
    try {
      breaker?.beforeRequest();
      const result = await operation();
      breaker?.recordSuccess();
      return result;
    } catch (error) {
      lastError = error;
      breaker?.recordFailure();
      if (attempt === config.RPC_RETRY_COUNT || error instanceof CircuitBreakerOpenError) break;
      await sleep(config.RPC_RETRY_DELAY_MS * 2 ** attempt);
    }
  }
  throw lastError;
}
