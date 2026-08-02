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

function stableHash(value) {
  const normalize = (item) => {
    if (Array.isArray(item)) return item.map(normalize);
    if (!item || typeof item !== 'object') return item;
    return Object.fromEntries(Object.entries(item)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, normalize(child)]));
  };
  return createHash('sha256').update(JSON.stringify(normalize(value))).digest('hex');
}

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
  const receipt = operationReceipt();
  const facts = adaptReflectInsightOperationEvidence({
    unit,
    attemptId,
    result: {
      success: true,
      status: 'succeeded',
      inputHash: receipt.inputHash,
      insightIds: ['insight-1'],
      reflectRecoveryEvidence: {
        schema: 'reflect-insight-commit/v1',
        kind: 'committed',
        receiptKey: expectedReceiptKey,
        receiptVersion: 1,
        resultRef: `reflect-insight-recoveries:${expectedReceiptKey}`,
        effectHash,
        identity: {
          runId: attemptId,
          unitId: unit.unit_id,
          inputHash: receipt.inputHash,
        },
      },
      operationReceipt: receipt,
    },
  });
  assert.equal(facts.candidateEvidence.kind, 'committed');
  assert.equal(facts.effectVerification, 'all_applied');
  assert.equal('decision' in facts, false);
  assert.equal(resolveOperationRecovery({ ...facts }).decision.action, 'replay');
});

test('Reflect adapter reports a committed structured no-effect fact', () => {
  const receipt = operationReceipt();
  const proposalHash = 'd'.repeat(64);
  const noEffect = {
    schema: 'reflect-insight-no-effect/v1',
    proposalHash,
    reasonCode: 'no_novel_insight',
  };
  const facts = adaptReflectInsightOperationEvidence({
    unit,
    attemptId,
    result: {
      success: true,
      status: 'skipped',
      inputHash: receipt.inputHash,
      insightIds: [],
      reflectRecoveryEvidence: {
        kind: 'no_effect',
        observation: 'business_empty',
        reasonCode: 'no_novel_insight',
        identity: {
          runId: attemptId,
          unitId: unit.unit_id,
          inputHash: receipt.inputHash,
        },
        proof: {
          kind: 'committed_structured_no_effect',
          receiptKey: expectedReceiptKey,
          receiptVersion: 1,
          ...noEffect,
          proofHash: stableHash(noEffect),
        },
      },
      operationReceipt: receipt,
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
  assert.deepEqual(unknown.snapshot, { reflectRecovery: { unitId: unit.unit_id } });

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
