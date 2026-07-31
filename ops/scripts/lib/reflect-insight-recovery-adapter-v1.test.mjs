import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { adaptReflectInsightOperationEvidence } from './reflect-insight-recovery-adapter-v1.mjs';
import { resolveOperationRecovery } from './recovery-policy-v1.mjs';

const unit = { unit_id: 'reflect-1', input_hash: 'b'.repeat(64) };
const attemptId = 'attempt-1';
const effectHash = 'a'.repeat(64);
const expectedReceiptKey = `xop_${createHash('sha256')
  .update(JSON.stringify([attemptId, 'reflect_insight', unit.unit_id]))
  .digest('hex')
  .slice(0, 32)}`;

function operationReceipt() {
  return {
    key: expectedReceiptKey,
    version: 1,
    status: 'succeeded',
    runId: attemptId,
    stage: 'reflect_insight',
    unitId: unit.unit_id,
    inputHash: 'c'.repeat(64),
    runnerInputHash: unit.input_hash,
  };
}

test('Reflect adapter reports committed facts without making the recovery decision', () => {
  const facts = adaptReflectInsightOperationEvidence({
    unit,
    attemptId,
    result: {
      status: 'succeeded',
      reflectRecoveryEvidence: {
        schema: 'reflect-insight-commit/v1',
        kind: 'committed',
        receiptKey: expectedReceiptKey,
        receiptVersion: 1,
        resultRef: `reflect-insight-recoveries:${expectedReceiptKey}`,
        effectHash,
      },
      operationReceipt: operationReceipt(),
    },
  });
  assert.equal(facts.candidateEvidence.kind, 'committed');
  assert.equal(facts.effectVerification, 'all_applied');
  assert.equal('decision' in facts, false);
  assert.equal(resolveOperationRecovery({ ...facts }).decision.action, 'replay');
});

test('Reflect adapter reports a proven no-effect fact', () => {
  const facts = adaptReflectInsightOperationEvidence({
    unit,
    attemptId,
    result: {
      status: 'skipped',
      reflectRecoveryEvidence: {
        kind: 'no_effect',
        observation: 'business_empty',
        reasonCode: 'insufficient_supporting_items',
        proof: {
          kind: 'receipt_before_formal_effect',
          receiptKey: expectedReceiptKey,
          receiptVersion: 1,
          phase: 'candidate_staging',
          commitPlanAbsent: true,
        },
      },
      operationReceipt: operationReceipt(),
    },
  });
  assert.equal(facts.candidateEvidence.kind, 'no_effect');
  assert.equal(resolveOperationRecovery({ ...facts }).decision.action, 'skipped');
});

test('Reflect adapter fails closed for incomplete facts and reports conflicts as system faults', () => {
  const unknown = adaptReflectInsightOperationEvidence({
    unit,
    attemptId,
    result: { status: 'succeeded', reflectRecoveryEvidence: { kind: 'committed' } },
  });
  assert.equal(unknown.candidateEvidence.kind, 'unknown');
  assert.deepEqual(unknown.snapshot, {});

  const conflict = adaptReflectInsightOperationEvidence({
    unit,
    attemptId,
    result: {
      failure: {
        class: 'hard',
        cause: 'reflect_insight_source_mutation_conflict',
      },
    },
  });
  assert.deepEqual(conflict.candidateEvidence, {
    kind: 'system_fault',
    code: 'commit_plan_conflict',
  });

  const textOnly = adaptReflectInsightOperationEvidence({
    unit,
    attemptId,
    result: { error: 'reflect_insight_source_mutation_conflict' },
  });
  assert.equal(textOnly.candidateEvidence.kind, 'unknown');
});
