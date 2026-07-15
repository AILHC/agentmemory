import type { CircuitBreakerState } from "../types.js";

interface CircuitBreakerOptions {
  failureThreshold?: number;
  failureWindowMs?: number;
  recoveryTimeoutMs?: number;
}

interface CircuitBreakerPermit {
  readonly mode: "closed" | "half-open";
  readonly generation: number;
  readonly token: symbol;
}

function positiveFinite(val: number | undefined, fallback: number): number {
  return Number.isFinite(val) && val! > 0 ? val! : fallback;
}

export class CircuitBreaker {
  private state: "closed" | "open" | "half-open" = "closed";
  private failures = 0;
  private lastFailureAt: number | null = null;
  private openedAt: number | null = null;
  private generation = 0;
  private halfOpenProbe: symbol | null = null;
  private activePermits = new Set<symbol>();

  private readonly failureThreshold: number;
  private readonly failureWindowMs: number;
  private readonly recoveryTimeoutMs: number;

  constructor(opts?: CircuitBreakerOptions) {
    this.failureThreshold = Math.max(
      1,
      Math.floor(positiveFinite(opts?.failureThreshold, 3)),
    );
    this.failureWindowMs = positiveFinite(opts?.failureWindowMs, 60_000);
    this.recoveryTimeoutMs = positiveFinite(opts?.recoveryTimeoutMs, 30_000);
  }

  get isAllowed(): boolean {
    if (this.state === "closed") return true;
    if (this.state === "half-open") return this.halfOpenProbe === null;
    return this.recoveryReady();
  }

  tryAcquire(): CircuitBreakerPermit | null {
    if (this.state === "open") {
      if (!this.recoveryReady()) return null;
      this.state = "half-open";
    }
    if (this.state === "half-open" && this.halfOpenProbe !== null) return null;

    const token = Symbol("circuit-breaker-permit");
    const permit: CircuitBreakerPermit = Object.freeze({
      mode: this.state === "half-open" ? "half-open" : "closed",
      generation: this.generation,
      token,
    });
    this.activePermits.add(token);
    if (permit.mode === "half-open") this.halfOpenProbe = token;
    return permit;
  }

  recordSuccess(permit: CircuitBreakerPermit): void {
    if (!this.consumeCurrentPermit(permit)) return;
    if (permit.mode === "half-open" && this.state === "half-open") {
      this.state = "closed";
      this.failures = 0;
      this.lastFailureAt = null;
      this.openedAt = null;
      this.nextGeneration();
      return;
    }
    if (permit.mode === "closed" && this.state === "closed") {
      this.failures = 0;
      this.lastFailureAt = null;
      this.openedAt = null;
    }
  }

  recordFailure(permit: CircuitBreakerPermit): void {
    if (!this.consumeCurrentPermit(permit)) return;
    const now = Date.now();
    if (permit.mode === "half-open" && this.state === "half-open") {
      this.lastFailureAt = now;
      this.open(now);
      return;
    }
    if (permit.mode !== "closed" || this.state !== "closed") return;
    if (
      this.lastFailureAt !== null
      && now - this.lastFailureAt > this.failureWindowMs
    ) {
      this.failures = 0;
    }
    this.failures += 1;
    this.lastFailureAt = now;
    if (this.failures >= this.failureThreshold) this.open(now);
  }

  release(permit: CircuitBreakerPermit): void {
    this.consumePermit(permit);
  }

  getState(): CircuitBreakerState {
    return {
      state: this.state,
      failures: this.failures,
      lastFailureAt: this.lastFailureAt,
      openedAt: this.openedAt,
    };
  }

  private recoveryReady(): boolean {
    return this.openedAt !== null
      && Date.now() - this.openedAt >= this.recoveryTimeoutMs;
  }

  private consumeCurrentPermit(permit: CircuitBreakerPermit): boolean {
    return this.consumePermit(permit) && permit.generation === this.generation;
  }

  private consumePermit(permit: CircuitBreakerPermit): boolean {
    if (!this.activePermits.delete(permit.token)) return false;
    if (this.halfOpenProbe === permit.token) this.halfOpenProbe = null;
    return true;
  }

  private open(now: number): void {
    this.state = "open";
    this.openedAt = now;
    this.nextGeneration();
  }

  private nextGeneration(): void {
    this.generation += 1;
    this.halfOpenProbe = null;
    this.activePermits.clear();
  }
}
