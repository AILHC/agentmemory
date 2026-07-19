import assert from 'node:assert/strict';
import test from 'node:test';

import { AdaptiveProviderLimiter } from './adaptive-provider-limiter.mjs';

const route = {
  provider: 'pi-agent-sdk',
  model: 'openai-codex/gpt-5.4-mini',
  endpointClass: 'memory-consolidate-prepare',
};

test('provider failures reduce concurrency and sustained successes restore it gradually', () => {
  const limiter = new AdaptiveProviderLimiter({ initial: 2, min: 1, max: 3, increaseAfter: 2 });

  assert.equal(limiter.state(route).concurrency, 2);
  limiter.recordFailure(route, { class: 'transient_provider', cause: 'pi_stream_failed' });
  assert.equal(limiter.state(route).concurrency, 1);

  limiter.recordProviderSuccess(route);
  assert.equal(limiter.state(route).concurrency, 1);
  limiter.recordProviderSuccess(route);
  assert.equal(limiter.state(route).concurrency, 2);
  limiter.recordProviderSuccess(route);
  limiter.recordProviderSuccess(route);
  assert.equal(limiter.state(route).concurrency, 3);
});

test('serialized buckets preserve the active route state across resume', () => {
  const first = new AdaptiveProviderLimiter();
  first.recordFailure(route, { class: 'transient_provider', cause: 'rate_limited' }, {
    retryAfterMs: 30_000,
    now: Date.parse('2026-07-18T00:00:00.000Z'),
  });

  const resumed = new AdaptiveProviderLimiter({ buckets: first.toJSON() });
  assert.deepEqual(resumed.state(route), {
    concurrency: 1,
    successStreak: 0,
    retryAt: '2026-07-18T00:00:30.000Z',
  });
});
