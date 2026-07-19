const PROVIDER_BACKOFF_CAUSES = new Set([
  'rate_limited',
  'pi_stream_failed',
  'circuit_breaker_open',
  'provider_unavailable',
]);

export class AdaptiveProviderLimiter {
  constructor({ initial = 2, min = 1, max = 3, increaseAfter = 20, buckets = {} } = {}) {
    this.initial = initial;
    this.min = min;
    this.max = max;
    this.increaseAfter = increaseAfter;
    this.buckets = new Map(Object.entries(buckets));
  }

  key({ provider = 'unknown', model = 'unknown', endpointClass = 'unknown' }) {
    return `${provider}\u0000${model}\u0000${endpointClass}`;
  }

  state(route) {
    const key = this.key(route);
    if (!this.buckets.has(key)) {
      this.buckets.set(key, {
        concurrency: this.initial,
        successStreak: 0,
        retryAt: null,
      });
    }
    return this.buckets.get(key);
  }

  available(route, inFlight, now = Date.now()) {
    const state = this.state(route);
    if (state.retryAt && Date.parse(state.retryAt) > now) return 0;
    return Math.max(0, state.concurrency - inFlight);
  }

  recordProviderSuccess(route) {
    const state = this.state(route);
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
      state.concurrency = this.min;
      state.successStreak = 0;
      if (retryAfterMs > 0) state.retryAt = new Date(now + retryAfterMs).toISOString();
    }
    return { ...state };
  }

  toJSON() {
    return Object.fromEntries(this.buckets);
  }
}
