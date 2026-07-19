import test from 'node:test';
import assert from 'node:assert/strict';
import { runStagePipeline } from './stage-pipeline.mjs';
import { AdaptiveProviderLimiter } from './adaptive-provider-limiter.mjs';

test('ordered commit preserves input order when prepare finishes out of order', async () => {
  const releases = new Map();
  const committed = [];
  const pending = runStagePipeline([1, 2, 3], {
    mode: 'ordered-commit',
    concurrency: 3,
    prepare: (item) => new Promise((resolve) => releases.set(item, () => resolve(`p${item}`))),
    commit: async (item, proposal) => {
      committed.push(item);
      return proposal;
    },
  });
  while (releases.size < 3) await new Promise((resolve) => setImmediate(resolve));
  releases.get(3)();
  releases.get(1)();
  releases.get(2)();
  assert.deepEqual(await pending, ['p1', 'p2', 'p3']);
  assert.deepEqual(committed, [1, 2, 3]);
});

test('provider failures reduce only their route bucket', () => {
  const limiter = new AdaptiveProviderLimiter({ initial: 3 });
  const a = { provider: 'pi', model: 'a', endpointClass: 'memory' };
  const b = { provider: 'pi', model: 'b', endpointClass: 'memory' };
  const c = { provider: 'pi', model: 'a', endpointClass: 'skill' };
  limiter.recordFailure(a, { class: 'transient_provider', cause: 'pi_stream_failed' });
  assert.equal(limiter.state(a).concurrency, 2);
  assert.equal(limiter.state(b).concurrency, 3);
  assert.equal(limiter.state(c).concurrency, 3);
  limiter.recordFailure(b, { class: 'unit', cause: 'parse_failed' });
  assert.equal(limiter.state(b).concurrency, 3);
});
