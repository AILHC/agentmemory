const PROVIDER_BACKOFF_CAUSES = new Set([
  'rate_limited',
  'pi_stream_failed',
  'circuit_breaker_open',
  'provider_unavailable',
  'timeout',
  'network_error',
  'server_error',
]);

export class AdaptiveProviderLimiter {
  constructor({
    initial = 2,
    min = 1,
    max = 3,
    increaseAfter = 8,
    failureThreshold = 2,
    failureWindowMs = 60_000,
    cooldownMs = 60_000,
    buckets = {},
  } = {}) {
    this.min = Math.max(1, Math.trunc(Number(min) || 1));
    this.max = Math.max(this.min, Math.trunc(Number(max) || this.min));
    this.initial = Math.min(this.max, Math.max(this.min, Math.trunc(Number(initial) || this.min)));
    this.increaseAfter = Math.max(1, Math.trunc(Number(increaseAfter) || 1));
    this.failureThreshold = Math.max(2, Math.trunc(Number(failureThreshold) || 2));
    this.failureWindowMs = Math.max(1, Math.trunc(Number(failureWindowMs) || 1));
    this.cooldownMs = Math.max(0, Math.trunc(Number(cooldownMs) || 0));
    this.buckets = new Map(
      Object.entries(buckets).map(([key, value]) => [key, this.normalizeState(value)]),
    );
  }

  key({ provider = 'unknown', model = 'unknown', endpointClass = 'unknown' }) {
    return `${provider}\u0000${model}\u0000${endpointClass}`;
  }

  normalizeState(value = {}) {
    const retryAt = typeof value.retryAt === 'string' && Number.isFinite(Date.parse(value.retryAt))
      ? new Date(Date.parse(value.retryAt)).toISOString()
      : null;
    const failureTimestamps = Array.isArray(value.failureTimestamps)
      ? value.failureTimestamps
        .filter((timestamp) => typeof timestamp === 'string' && Number.isFinite(Date.parse(timestamp)))
        .map((timestamp) => new Date(Date.parse(timestamp)).toISOString())
        .sort()
        .slice(-this.failureThreshold)
      : [];
    const concurrency = Math.min(
      this.max,
      Math.max(this.min, Math.trunc(Number(value.concurrency) || this.initial)),
    );
    return {
      concurrency,
      successStreak: Math.max(0, Math.trunc(Number(value.successStreak) || 0)),
      retryAt,
      failureTimestamps,
      probeRequired: typeof value.probeRequired === 'boolean'
        ? value.probeRequired
        : Boolean(retryAt),
    };
  }

  state(route) {
    const key = this.key(route);
    if (!this.buckets.has(key)) {
      this.buckets.set(key, this.normalizeState());
    }
    return this.buckets.get(key);
  }

  available(route, inFlight, now = Date.now()) {
    const state = this.state(route);
    if (state.retryAt && Date.parse(state.retryAt) > now) return 0;
    if (state.probeRequired) return Math.max(0, 1 - inFlight);
    return Math.max(0, state.concurrency - inFlight);
  }

  requiresProbe(route) {
    return this.state(route).probeRequired;
  }

  recordProviderSuccess(route, { probe = false } = {}) {
    const state = this.state(route);
    if (state.probeRequired && !probe) return { ...state };
    if (probe) {
      state.probeRequired = false;
      state.failureTimestamps = [];
    }
    state.retryAt = null;
    state.successStreak += 1;
    if (state.successStreak >= this.increaseAfter && state.concurrency < this.max) {
      state.concurrency += 1;
      state.successStreak = 0;
    }
    return { ...state };
  }

  recordFailure(route, failure, { retryAfterMs = 0, now = Date.now() } = {}) {
    const state = this.state(route);
    if (failure?.class === 'transient_provider' || PROVIDER_BACKOFF_CAUSES.has(failure?.cause)) {
      const observedAt = Number.isFinite(Number(now)) ? Number(now) : Date.now();
      const requestedCooldown = Number.isFinite(Number(retryAfterMs))
        ? Math.max(0, Number(retryAfterMs))
        : 0;
      state.failureTimestamps = state.failureTimestamps
        .filter((timestamp) => observedAt - Date.parse(timestamp) <= this.failureWindowMs);
      state.failureTimestamps.push(new Date(observedAt).toISOString());
      const denseFailure = state.failureTimestamps.length >= this.failureThreshold;
      if (state.concurrency === this.max || denseFailure) {
        state.concurrency = Math.max(this.min, state.concurrency - 1);
      }
      state.successStreak = 0;
      state.probeRequired = true;
      state.retryAt = new Date(observedAt + Math.max(this.cooldownMs, requestedCooldown)).toISOString();
    }
    return { ...state };
  }

  toJSON() {
    return Object.fromEntries(
      [...this.buckets.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => [key, this.normalizeState(value)]),
    );
  }
}
