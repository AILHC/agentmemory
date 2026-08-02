import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ADOPTED_BASELINE_PLAN_SCHEMA,
  adoptedBaselinePreviewHash,
  buildPreview,
  validatePlan,
} from './preview-agentmemory-adopted-baseline.mjs';

const HASH = 'a'.repeat(64);

function plan() {
  return {
    schema: ADOPTED_BASELINE_PLAN_SCHEMA,
    baseline_id: 'baseline-1',
    source_run_id: 'old-run',
    retired_run_ids: ['old-run'],
    decision_ref: 'MYC-122',
    historical_session_ids: ['historical-session'],
    current_session_ids: ['current-session'],
    current_lesson_ids: ['current-lesson'],
  };
}

test('baseline plan fixes the historical/current boundary and rejects overlap', () => {
  assert.deepEqual(validatePlan(plan()), {
    baselineId: 'baseline-1',
    sourceRunId: 'old-run',
    retiredRunIds: ['old-run'],
    decisionRef: 'MYC-122',
    historicalSessionIds: ['historical-session'],
    currentSessionIds: ['current-session'],
    currentLessonIds: ['current-lesson'],
  });
  assert.throws(() => validatePlan({
    ...plan(),
    current_session_ids: ['historical-session'],
  }), /must be disjoint/);
});

test('preview covers current sessions only for the three adopted stages', async () => {
  const previousFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    requests.push(body);
    if (body.action === 'preview_lesson_seed') {
      return new Response(JSON.stringify({
        success: true,
        records: [{
          baselineId: body.baselineId,
          lessonId: 'current-lesson',
          sourceVersionKey: `reflect_insight|lesson|current-lesson|${HASH}`,
          normalizedContentHash: HASH,
        }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({
      success: true,
      records: body.sessionIds.map((sessionId) => ({
        baselineId: body.baselineId,
        stage: body.stage,
        stageContractVersion: `${body.stage}/v1`,
        sessionId,
        normalizedContentHash: HASH,
      })),
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const preview = await buildPreview({
      baseUrl: 'http://127.0.0.1:3111',
      secret: 'not-exposed',
      plan: plan(),
    });
    assert.equal(preview.coverage.summary.count, 2);
    assert.equal(preview.coverage.lessons.count, 2);
    assert.equal(preview.coverage.memory_consolidate.count, 2);
    assert.equal(preview.coverage.semantic_rollup.count, 1);
    assert.equal(preview.coverage.skill_extract.count, 1);
    assert.equal(preview.lesson_seed.count, 1);
    assert.equal(preview.preview_hash, adoptedBaselinePreviewHash(preview));
    assert.equal(requests.length, 6);
    assert.equal(JSON.stringify(preview).includes('not-exposed'), false);
  } finally {
    globalThis.fetch = previousFetch;
  }
});
