import type {
  MemoryProvider,
  CircuitBreakerState,
  MemoryProviderCallOptions,
} from "../types.js";
import { CircuitBreaker } from "./circuit-breaker.js";
import { ProviderCallError } from "./provider-call-result.js";

const CIRCUIT_FAILURE_CODES = new Set([
  "rate_limited",
  "timeout",
  "network_error",
  "server_error",
]);

function countsTowardCircuitBreaker(error: unknown): boolean {
  return error instanceof ProviderCallError
    && CIRCUIT_FAILURE_CODES.has(String(error.metadata?.providerErrorCode));
}

export class ResilientProvider implements MemoryProvider {
  private breaker = new CircuitBreaker();
  name: string;

  constructor(private inner: MemoryProvider) {
    this.name = `resilient(${inner.name})`;
  }

  private async call<T>(fn: () => Promise<T>): Promise<T> {
    const permit = this.breaker.tryAcquire();
    if (!permit) throw new Error("circuit_breaker_open");
    try {
      const result = await fn();
      this.breaker.recordSuccess(permit);
      return result;
    } catch (err) {
      if (countsTowardCircuitBreaker(err)) {
        this.breaker.recordFailure(permit);
      } else {
        this.breaker.release(permit);
      }
      throw err;
    }
  }

  async compress(
    systemPrompt: string,
    userPrompt: string,
    options?: MemoryProviderCallOptions,
  ): Promise<string> {
    return this.call(() => this.inner.compress(systemPrompt, userPrompt, options));
  }

  async summarize(
    systemPrompt: string,
    userPrompt: string,
    options?: MemoryProviderCallOptions,
  ): Promise<string> {
    return this.call(() => this.inner.summarize(systemPrompt, userPrompt, options));
  }

  get circuitState(): CircuitBreakerState {
    return this.breaker.getState();
  }
}
