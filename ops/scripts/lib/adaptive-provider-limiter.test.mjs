import assert from 'node:assert/strict';
import test from 'node:test';

import { AdaptiveProviderLimiter } from './adaptive-provider-limiter.mjs';

const route = {
  provider: 'pi-agent-sdk',
  model: 'openai-codex/gpt-5.4-mini',
  endpointClass: 'memory-consolidate-prepare',
};

test('one transient failure reduces one level and a dense second failure reaches the minimum', () => {
  const limiter = new AdaptiveProviderLimiter({
    initial: 3,
    min: 1,
    max: 3,
    failureThreshold: 2,
    failureWindowMs: 60_000,
    cooldownMs: 60_000,
  });
  const startedAt = Date.parse('2026-07-18T00:00:00.000Z');

  limiter.recordFailure(route, { class: 'transient_provider', cause: 'timeout' }, {
    now: startedAt,
  });
  assert.equal(limiter.state(route).concurrency, 2);

  limiter.recordFailure(route, { class: 'transient_provider', cause: 'timeout' }, {
    now: startedAt + 30_000,
  });
  assert.equal(limiter.state(route).concurrency, 1);
});

test('an isolated failure after the degradation window does not reduce a degraded bucket again', () => {
  const limiter = new AdaptiveProviderLimiter({
    initial: 3,
    min: 1,
    max: 3,
    failureThreshold: 2,
    failureWindowMs: 60_000,
  });
  const startedAt = Date.parse('2026-07-18T00:00:00.000Z');

  limiter.recordFailure(route, { class: 'transient_provider', cause: 'timeout' }, {
    now: startedAt,
  });
  limiter.recordFailure(route, { class: 'transient_provider', cause: 'timeout' }, {
    now: startedAt + 60_001,
  });
  assert.equal(limiter.state(route).concurrency, 2);

  limiter.recordFailure(route, { class: 'transient_provider', cause: 'timeout' }, {
    now: startedAt + 60_002,
  });
  assert.equal(limiter.state(route).concurrency, 1);
});

test('eight consecutive provider successes restore one concurrency level at a time', () => {
  const limiter = new AdaptiveProviderLimiter({ initial: 1, min: 1, max: 3 });

  for (let index = 0; index < 7; index += 1) limiter.recordProviderSuccess(route);
  assert.equal(limiter.state(route).concurrency, 1);
  limiter.recordProviderSuccess(route);
  assert.equal(limiter.state(route).concurrency, 2);

  for (let index = 0; index < 8; index += 1) limiter.recordProviderSuccess(route);
  assert.equal(limiter.state(route).concurrency, 3);
});

test('a transient failure cools down and permits only one recovery probe', () => {
  const limiter = new AdaptiveProviderLimiter({
    initial: 3,
    min: 1,
    max: 3,
    cooldownMs: 60_000,
  });
  const startedAt = Date.parse('2026-07-18T00:00:00.000Z');

  limiter.recordFailure(route, { class: 'transient_provider', cause: 'timeout' }, {
    now: startedAt,
  });
  assert.equal(limiter.available(route, 0, startedAt + 59_999), 0);
  assert.equal(limiter.available(route, 0, startedAt + 60_000), 1);
  assert.equal(limiter.available(route, 1, startedAt + 60_000), 0);
  assert.equal(limiter.requiresProbe(route), true);

  limiter.recordProviderSuccess(route, { probe: false });
  assert.equal(limiter.requiresProbe(route), true);
  assert.equal(limiter.state(route).successStreak, 0);

  limiter.recordProviderSuccess(route, { probe: true });
  assert.equal(limiter.requiresProbe(route), false);
  assert.equal(limiter.available(route, 0, startedAt + 60_000), 2);
  assert.equal(limiter.state(route).successStreak, 1);
});

test('serialized buckets preserve the active route state across resume', () => {
  const first = new AdaptiveProviderLimiter();
  first.recordFailure(route, { class: 'transient_provider', cause: 'rate_limited' }, {
    retryAfterMs: 30_000,
    now: Date.parse('2026-07-18T00:00:00.000Z'),
  });

  const resumed = new AdaptiveProviderLimiter({ buckets: first.toJSON() });
  assert.deepEqual(resumed.state(route), {
    concurrency: 2,
    successStreak: 0,
    retryAt: '2026-07-18T00:01:00.000Z',
    failureTimestamps: ['2026-07-18T00:00:00.000Z'],
    probeRequired: true,
  });
});

test('legacy serialized buckets are normalized without mutating the loaded snapshot', () => {
  const retryAt = '2026-07-18T00:01:00.000Z';
  const key = `${route.provider}\u0000${route.model}\u0000${route.endpointClass}`;
  const legacyBuckets = {
    [key]: {
      concurrency: 1,
      successStreak: 4,
      retryAt,
    },
  };
  const resumed = new AdaptiveProviderLimiter({ buckets: legacyBuckets });

  assert.deepEqual(resumed.state(route), {
    concurrency: 1,
    successStreak: 4,
    retryAt,
    failureTimestamps: [],
    probeRequired: true,
  });
  assert.deepEqual(legacyBuckets[key], {
    concurrency: 1,
    successStreak: 4,
    retryAt,
  });
  assert.deepEqual(
    new AdaptiveProviderLimiter({ buckets: resumed.toJSON() }).toJSON(),
    resumed.toJSON(),
  );
});

test('legacy degraded buckets without a retry deadline resume after their prior cooldown', () => {
  const key = `${route.provider}\u0000${route.model}\u0000${route.endpointClass}`;
  const resumed = new AdaptiveProviderLimiter({
    buckets: {
      [key]: {
        concurrency: 1,
        successStreak: 0,
        retryAt: null,
      },
    },
  });

  assert.equal(resumed.requiresProbe(route), false);
  assert.equal(resumed.available(route, 0, Date.parse('2026-07-18T00:00:00.000Z')), 1);
});
