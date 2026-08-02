import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  adaptConsolidationProceduralOperationEvidence,
} from './consolidation-procedural-recovery-adapter-v1.mjs';

const HASH = 'a'.repeat(64);
const RUNNER_HASH = 'd'.repeat(64);

function receiptKey(attemptId, unitId) {
  return `xop_${createHash('sha256')
    .update(JSON.stringify([attemptId, 'consolidation_procedural', unitId]))
    .digest('hex')
    .slice(0, 32)}`;
}

function committedResult() {
  const key = receiptKey('attempt-1', 'cpw-1');
  return {
    success: true,
    status: 'succeeded',
    inputHash: HASH,
    proceduralMemoryIds: ['proc-1'],
    operationReceipt: {
      key,
      version: 1,
      status: 'succeeded',
      runId: 'attempt-1',
      stage: 'consolidation_procedural',
      unitId: 'cpw-1',
      inputHash: HASH,
      runnerInputHash: RUNNER_HASH,
    },
    proceduralRecoveryEvidence: {
      schema: 'consolidation-procedural-commit/v1',
      kind: 'committed',
      receiptKey: key,
      receiptVersion: 1,
      resultRef: `procedural-recoveries:${key}`,
      effectHash: 'b'.repeat(64),
      identity: { runId: 'attempt-1', unitId: 'cpw-1', inputHash: HASH },
    },
  };
}

function noEffectResult() {
  const key = receiptKey('attempt-1', 'cpw-1');
  return {
    success: true,
    status: 'skipped',
    inputHash: HASH,
    operationReceipt: {
      key,
      version: 1,
      status: 'succeeded',
      runId: 'attempt-1',
      stage: 'consolidation_procedural',
      unitId: 'cpw-1',
      inputHash: HASH,
      runnerInputHash: RUNNER_HASH,
    },
    proceduralRecoveryEvidence: {
      kind: 'no_effect',
      observation: 'business_empty',
      reasonCode: 'fewer_than_2_recurring_patterns',
      identity: { runId: 'attempt-1', unitId: 'cpw-1', inputHash: HASH },
      proof: {
        kind: 'receipt_before_formal_effect',
        receiptKey: key,
        receiptVersion: 1,
        phase: 'candidate_staging',
        commitPlanAbsent: true,
      },
    },
  };
}

function committedNoEffectResult() {
  const key = receiptKey('attempt-1', 'cpw-1');
  const proof = {
    schema: 'consolidation-procedural-no-effect/v1',
    proposalHash: 'e'.repeat(64),
    reasonCode: 'no_reusable_procedure',
  };
  proof.proofHash = createHash('sha256').update(JSON.stringify({
    proposalHash: proof.proposalHash,
    reasonCode: proof.reasonCode,
    schema: proof.schema,
  })).digest('hex');
  return {
    success: true,
    status: 'skipped',
    inputHash: HASH,
    proceduralMemoryIds: [],
    operationReceipt: {
      key,
      version: 1,
      status: 'succeeded',
      runId: 'attempt-1',
      stage: 'consolidation_procedural',
      unitId: 'cpw-1',
      inputHash: HASH,
      runnerInputHash: RUNNER_HASH,
    },
    proceduralRecoveryEvidence: {
      kind: 'no_effect',
      observation: 'business_empty',
      reasonCode: proof.reasonCode,
      identity: { runId: 'attempt-1', unitId: 'cpw-1', inputHash: HASH },
      proof: {
        kind: 'committed_structured_no_effect',
        receiptKey: key,
        receiptVersion: 1,
        ...proof,
      },
    },
  };
}

test('procedural adapter only projects receipt-bound committed facts', () => {
  const adapted = adaptConsolidationProceduralOperationEvidence({
    result: { data: committedResult() },
    unit: { unit_id: 'cpw-1', input_hash: RUNNER_HASH },
    attemptId: 'attempt-1',
  });
  assert.deepEqual(adapted.candidateEvidence, {
    kind: 'committed',
    receiptKey: receiptKey('attempt-1', 'cpw-1'),
    receiptVersion: 1,
    resultRef: `procedural-recoveries:${receiptKey('attempt-1', 'cpw-1')}`,
    effectHash: 'b'.repeat(64),
  });
  assert.equal(adapted.effectVerification, 'all_applied');
  assert.deepEqual(adapted.snapshot.proceduralRecovery.expectedProceduralMemoryIds, ['proc-1']);
});

test('procedural adapter rejects a mismatched identity as unknown without deciding recovery', () => {
  const result = committedResult();
  result.proceduralRecoveryEvidence.identity.inputHash = 'c'.repeat(64);
  const adapted = adaptConsolidationProceduralOperationEvidence({
    result,
    unit: { unit_id: 'cpw-1', input_hash: RUNNER_HASH },
    attemptId: 'attempt-1',
  });
  assert.equal(adapted.candidateEvidence.kind, 'unknown');
  assert.equal(adapted.candidateEvidence.reasonCode, 'consolidation_procedural_effect_state_unknown');
});

test('procedural adapter projects receipt-bound business-empty evidence without a commit decision', () => {
  const adapted = adaptConsolidationProceduralOperationEvidence({
    result: noEffectResult(),
    unit: { unit_id: 'cpw-1', input_hash: RUNNER_HASH },
    attemptId: 'attempt-1',
  });
  assert.deepEqual(adapted.candidateEvidence, {
    kind: 'no_effect',
    observation: 'business_empty',
    reasonCode: 'fewer_than_2_recurring_patterns',
    proof: {
      kind: 'receipt_before_formal_effect',
      receiptKey: receiptKey('attempt-1', 'cpw-1'),
      receiptVersion: 1,
      phase: 'candidate_staging',
      commitPlanAbsent: true,
    },
  });
  assert.equal(adapted.snapshot.receipt.formalEffect, false);
});

test('procedural adapter projects a receipt-bound committed structured no-effect', () => {
  const result = committedNoEffectResult();
  const adapted = adaptConsolidationProceduralOperationEvidence({
    result,
    unit: { unit_id: 'cpw-1', input_hash: RUNNER_HASH },
    attemptId: 'attempt-1',
  });
  assert.deepEqual(adapted.candidateEvidence, {
    kind: 'no_effect',
    observation: 'business_empty',
    reasonCode: 'no_reusable_procedure',
    proof: result.proceduralRecoveryEvidence.proof,
  });
  assert.equal(adapted.snapshot.receipt.status, 'succeeded');
  assert.deepEqual(adapted.snapshot.committedNoEffect, {
    schema: result.proceduralRecoveryEvidence.proof.schema,
    proposalHash: result.proceduralRecoveryEvidence.proof.proposalHash,
    reasonCode: result.proceduralRecoveryEvidence.proof.reasonCode,
    proofHash: result.proceduralRecoveryEvidence.proof.proofHash,
  });
});

test('procedural adapter rejects a tampered committed structured no-effect proof', () => {
  const result = committedNoEffectResult();
  result.proceduralRecoveryEvidence.proof.proofHash = 'f'.repeat(64);
  const adapted = adaptConsolidationProceduralOperationEvidence({
    result,
    unit: { unit_id: 'cpw-1', input_hash: RUNNER_HASH },
    attemptId: 'attempt-1',
  });
  assert.equal(adapted.candidateEvidence.kind, 'unknown');
});

test('procedural adapter isolates a receipt-bound source drift after backlog replacement', () => {
  const key = receiptKey('attempt-1', 'cpw-1');
  const adapted = adaptConsolidationProceduralOperationEvidence({
    result: {
      failure: {
        class: 'hard',
        cause: 'consolidation_procedural_source_drifted_before_commit',
      },
      operationReceipt: {
        key,
        version: 1,
        status: 'failed',
        runId: 'attempt-1',
        stage: 'consolidation_procedural',
        unitId: 'cpw-1',
        inputHash: HASH,
        runnerInputHash: RUNNER_HASH,
      },
    },
    unit: { unit_id: 'cpw-1', input_hash: RUNNER_HASH },
    attemptId: 'attempt-1',
  });
  assert.deepEqual(adapted.candidateEvidence, {
    kind: 'no_effect',
    observation: 'business_rejected',
    reasonCode: 'consolidation_procedural_source_drifted_before_commit',
    proof: {
      kind: 'receipt_before_formal_effect',
      receiptKey: key,
      receiptVersion: 1,
      phase: 'candidate_staging',
      commitPlanAbsent: true,
    },
  });
  assert.equal(adapted.snapshot.receipt.formalEffect, false);
});

test('procedural adapter reports only explicit recovery conflicts as system faults', () => {
  const adapted = adaptConsolidationProceduralOperationEvidence({
    result: {
      failure: {
        class: 'hard',
        cause: 'consolidation_procedural_source_mutation_conflict',
      },
    },
    unit: { unit_id: 'cpw-1' },
    attemptId: 'attempt-1',
  });
  assert.deepEqual(adapted.candidateEvidence, {
    kind: 'system_fault',
    code: 'commit_plan_conflict',
  });

  const textOnly = adaptConsolidationProceduralOperationEvidence({
    result: { error: 'consolidation_procedural_source_mutation_conflict' },
    unit: { unit_id: 'cpw-1' },
    attemptId: 'attempt-1',
  });
  assert.equal(textOnly.candidateEvidence.kind, 'unknown');
});
