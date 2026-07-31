import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  adaptLessonOperationEvidence as adaptLessonOperationEvidenceFacts,
} from './lesson-recovery-adapter-v1.mjs';
import { resolveOperationRecovery } from './recovery-policy-v1.mjs';

const attemptId = 'attempt-1';
const sessionId = 'session-1';
const inputHash = 'a'.repeat(64);
const configHash = 'b'.repeat(64);
const runnerInputHash = 'c'.repeat(64);
const receiptInputHash = createHash('sha256').update(JSON.stringify({ configHash, runnerInputHash, serviceInputHash: inputHash })).digest('hex');
const receiptKey = `xop_${createHash('sha256').update(JSON.stringify([attemptId, 'lessons', sessionId])).digest('hex').slice(0, 32)}`;

function data(overrides = {}) {
  const scopeProofs = [
    `mem:extraction-operation-receipt:${receiptKey}`,
    'mem:extraction-operation-receipts',
    'mem:lesson-extraction:runs',
    'mem:lesson-extraction:chunks:lesson-run-1',
    'mem:lessons',
    'mem:lesson-commit:receipts:lesson-run-1',
  ].map((scope) => ({
    scope,
    exact_count: 0,
    safe_projection_hash: 'd'.repeat(64),
  }));
  return {
    failure: { class: 'unit', cause: 'lesson_no_blocks' },
    expectedLessonRunId: 'lesson-run-1', expectedRunInputHash: inputHash, expectedReceiptInputHash: receiptInputHash, expectedConfigHash: configHash,
    lessonRun: { id: 'lesson-run-1', sessionId, status: 'failed', inputHash, configHash, createdLessonIds: [], replacedLessonIds: [], finishedAt: '2026-07-29T00:00:00.000Z' },
    receipt: { key: receiptKey, runId: attemptId, unitId: sessionId, stage: 'lessons', inputHash: receiptInputHash, status: 'failed', failure: { class: 'unit', cause: 'lesson_no_blocks' } },
    lessonChunks: [], formalLessonWrites: [], ...overrides,
    collection: {
      schema: 'legacy-lesson-safe-facts-collection/v1',
      snapshot_hash: 'e'.repeat(64),
      state_tree_hash: 'f'.repeat(64),
      engine_hash: '1'.repeat(64),
      journal_input_summary_hash: '2'.repeat(64),
      scope_proofs: scopeProofs,
    },
  };
}

function adapt(value) {
  return resolveOperationRecovery({
    ...adaptLessonOperationEvidenceFacts({
      result: value,
      unit: { unit_id: sessionId },
      attemptId,
      operationId: sessionId,
    }),
    budget: { attemptsUsed: 0, maxAttempts: 1 },
  });
}

test('Lesson adapter reports facts without owning the recovery decision', () => {
  const facts = adaptLessonOperationEvidenceFacts({
    result: data(),
    unit: { unit_id: sessionId },
    attemptId,
    operationId: sessionId,
  });
  assert.equal(facts.candidateEvidence.kind, 'no_effect');
  assert.equal('decision' in facts, false);
  assert.equal('policyVersion' in facts, false);
});

test('adapts only closed legacy lesson_no_blocks evidence to skipped without body fields', () => {
  const result = adapt(data());
  assert.equal(result.decision.action, 'skipped');
  assert.equal(result.evidence.kind, 'no_effect');
  assert.equal(JSON.stringify(result).includes('lesson body sentinel'), false);
});

test('adapts a closed retryable legacy lesson_no_blocks run to skipped', () => {
  const value = data();
  value.lessonRun.status = 'retryable';
  const result = adapt(value);
  assert.equal(result.decision.action, 'skipped');
  assert.equal(result.evidence.kind, 'no_effect');
  assert.equal(result.evidence.proof.kind, 'legacy_lessons_zero_effect');
});

test('adapts a bound committed Lesson receipt to verified replay', () => {
  const result = adapt({
    runs: [{ id: 'lesson-run-1', status: 'succeeded' }],
    lessonEvidence: [{
      kind: 'committed',
      runId: 'lesson-run-1',
      stagingId: 'staging-1',
      planId: 'plan-1',
      receiptKey: `lcr_${'1'.repeat(32)}`,
      receiptVersion: 1,
      resultRef: 'lesson-commit-plans:plan-1',
      effectHash: 'd'.repeat(64),
    }],
  });
  assert.equal(result.decision.action, 'replay');
  assert.equal(result.effectVerification, 'all_applied');
});

test('fails closed when committed Lesson evidence is not bound to the returned run and plan', () => {
  const result = adapt({
    runs: [{ id: 'lesson-run-1', status: 'succeeded' }],
    lessonEvidence: [{
      kind: 'committed',
      runId: 'other-run',
      stagingId: 'staging-1',
      planId: 'plan-1',
      receiptKey: `lcr_${'1'.repeat(32)}`,
      receiptVersion: 1,
      resultRef: 'lesson-commit-plans:other-plan',
      effectHash: 'd'.repeat(64),
    }],
  });
  assert.equal(result.evidence.kind, 'unknown');
  assert.equal(result.decision.action, 'reconcile');
});

for (const [kind, expectedAction, referenceField] of [
  ['staged', 'resume_commit', 'resultRef'],
  ['committing', 'reconcile_commit', 'commitPlanRef'],
]) {
  test(`routes ${kind} Lesson evidence through the generic commit action`, () => {
    const result = adapt({
      lessonEvidence: [{
        kind,
        [referenceField]: `${kind}-ref`,
        effectHash: 'e'.repeat(64),
      }],
    });
    assert.equal(result.decision.action, expectedAction);
  });
}

for (const [name, mutate] of [
  ['missing field', (value) => { delete value.lessonRun.finishedAt; }],
  ['run conflict', (value) => { value.lessonRun.id = 'other-run'; }],
  ['receipt conflict', (value) => { value.receipt.key = 'other-receipt'; }],
  ['input conflict', (value) => { value.receipt.inputHash = 'c'.repeat(64); }],
  ['config conflict', (value) => { value.lessonRun.configHash = 'c'.repeat(64); }],
  ['chunk conflict', (value) => { value.lessonChunks = [{ runId: 'other-run', sessionId, lessonIds: [] }]; }],
  ['formal write', (value) => { value.formalLessonWrites = [{ sourceRunId: 'lesson-run-1' }]; }],
  ['missing completeness proof', (value) => { delete value.collection; }],
  ['similar error', (value) => { value.failure.cause = 'lesson_no_blocks_similar'; }],
]) {
  test(`fails closed for ${name}`, () => {
    const value = data();
    mutate(value);
    assert.equal(adapt(value).decision.action, 'reconcile');
  });
}
