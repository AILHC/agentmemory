import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CircuitBreaker } from "../src/providers/circuit-breaker.js";

function acquire(breaker: CircuitBreaker) {
  const permit = breaker.tryAcquire();
  expect(permit).not.toBeNull();
  return permit!;
}

function fail(breaker: CircuitBreaker): void {
  breaker.recordFailure(acquire(breaker));
}

function succeed(breaker: CircuitBreaker): void {
  breaker.recordSuccess(acquire(breaker));
}

function open(breaker: CircuitBreaker): void {
  fail(breaker);
  fail(breaker);
  fail(breaker);
}

describe("CircuitBreaker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts closed and returns a closed-generation permit", () => {
    const breaker = new CircuitBreaker();
    const permit = acquire(breaker);

    expect(permit).toMatchObject({ mode: "closed", generation: 0 });
    expect(breaker.getState()).toMatchObject({ state: "closed", failures: 0 });
    breaker.release(permit);
  });

  it("opens only after three consecutive failures", () => {
    const breaker = new CircuitBreaker();
    fail(breaker);
    fail(breaker);
    expect(breaker.getState()).toMatchObject({ state: "closed", failures: 2 });

    fail(breaker);

    expect(breaker.getState().state).toBe("open");
    expect(breaker.tryAcquire()).toBeNull();
  });

  it("closed success clears the consecutive failure count", () => {
    const breaker = new CircuitBreaker();
    fail(breaker);
    fail(breaker);

    succeed(breaker);

    expect(breaker.getState()).toMatchObject({
      state: "closed",
      failures: 0,
      lastFailureAt: null,
    });
  });

  it("failure success failure success failure never opens threshold three", () => {
    const breaker = new CircuitBreaker();

    fail(breaker);
    succeed(breaker);
    fail(breaker);
    succeed(breaker);
    fail(breaker);

    expect(breaker.getState()).toMatchObject({ state: "closed", failures: 1 });
    expect(breaker.tryAcquire()).not.toBeNull();
  });

  it("resets failures outside the failure window", () => {
    const breaker = new CircuitBreaker();
    fail(breaker);
    fail(breaker);
    vi.advanceTimersByTime(61_000);

    fail(breaker);

    expect(breaker.getState()).toMatchObject({ state: "closed", failures: 1 });
  });

  it("allows only one in-flight half-open probe", () => {
    const breaker = new CircuitBreaker();
    open(breaker);
    vi.advanceTimersByTime(30_000);

    const probe = acquire(breaker);

    expect(probe.mode).toBe("half-open");
    expect(breaker.getState().state).toBe("half-open");
    expect(breaker.tryAcquire()).toBeNull();
    breaker.release(probe);
    expect(acquire(breaker).mode).toBe("half-open");
  });

  it("only the current-generation half-open probe can close the breaker", () => {
    const breaker = new CircuitBreaker({ failureThreshold: 1 });
    const lateClosedPermit = acquire(breaker);
    fail(breaker);
    vi.advanceTimersByTime(30_000);
    const probe = acquire(breaker);

    breaker.recordSuccess(lateClosedPermit);

    expect(breaker.getState().state).toBe("half-open");
    expect(breaker.tryAcquire()).toBeNull();
    breaker.recordSuccess(probe);
    expect(breaker.getState()).toMatchObject({ state: "closed", failures: 0 });
  });

  it("ignores a late failure from an invalidated generation", () => {
    const breaker = new CircuitBreaker({ failureThreshold: 1 });
    const lateClosedPermit = acquire(breaker);
    fail(breaker);
    vi.advanceTimersByTime(30_000);
    breaker.recordSuccess(acquire(breaker));

    breaker.recordFailure(lateClosedPermit);

    expect(breaker.getState()).toMatchObject({ state: "closed", failures: 0 });
  });

  it("half-open failure reopens and duplicate releases are ignored", () => {
    const breaker = new CircuitBreaker({ failureThreshold: 1 });
    fail(breaker);
    vi.advanceTimersByTime(30_000);
    const probe = acquire(breaker);

    breaker.recordFailure(probe);
    const reopenedAt = breaker.getState().openedAt;
    breaker.recordFailure(probe);
    breaker.recordSuccess(probe);
    breaker.release(probe);

    expect(breaker.getState()).toMatchObject({ state: "open", openedAt: reopenedAt });
  });

  it("cancellation releases a half-open probe without recording success or failure", () => {
    const breaker = new CircuitBreaker({ failureThreshold: 1 });
    fail(breaker);
    vi.advanceTimersByTime(30_000);
    const cancelledProbe = acquire(breaker);

    breaker.release(cancelledProbe);
    breaker.release(cancelledProbe);

    expect(breaker.getState().state).toBe("half-open");
    const replacement = acquire(breaker);
    expect(replacement).toMatchObject({
      mode: "half-open",
      generation: cancelledProbe.generation,
    });
  });

  it("records failure and open timestamps", () => {
    const breaker = new CircuitBreaker({ failureThreshold: 1 });
    vi.setSystemTime(new Date("2026-01-15T10:00:00Z"));

    fail(breaker);

    const expected = new Date("2026-01-15T10:00:00Z").getTime();
    expect(breaker.getState()).toMatchObject({
      lastFailureAt: expected,
      openedAt: expected,
    });
  });
});
