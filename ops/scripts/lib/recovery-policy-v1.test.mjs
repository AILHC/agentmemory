import assert from 'node:assert/strict';
import test from 'node:test';
import {
  RECOVERY_POLICY_DESCRIPTOR,
  RECOVERY_POLICY_HASH,
  RECOVERY_POLICY_VERSION,
  decideRecovery,
  normalizeOperationEvidence,
  recoveryPolicyHash,
  recoveryValueHash,
  resolveOperationRecovery,
} from './recovery-policy-v1.mjs';

const HASH = 'a'.repeat(64);

function noEffect(proof, observation = 'execution_error', reasonCode = 'provider_unavailable') {
  return { kind: 'no_effect', observation, reasonCode, proof };
}

const proofCases = [
  {
    name: 'request not dispatched',
    proof: { kind: 'request_not_dispatched', attemptId: 'attempt-1', journalSeq: 7 },
    snapshot: {
      requestDispatch: {
        state: 'not_dispatched',
        persisted: true,
        attemptId: 'attempt-1',
        journalSeq: 7,
      },
    },
  },
  {
    name: 'receipt before formal effect',
    proof: {
      kind: 'receipt_before_formal_effect',
      receiptKey: 'receipt-1',
      receiptVersion: 1,
      phase: 'provider_call',
      commitPlanAbsent: true,
    },
    snapshot: {
      receipt: {
        key: 'receipt-1',
        version: 1,
        phase: 'provider_call',
        commitPlanAbsent: true,
      },
    },
  },
  {
    name: 'legacy lesson zero effect',
    proof: {
      kind: 'legacy_lessons_zero_effect',
      lessonRunId: 'lesson-run-1',
      receiptKey: 'receipt-2',
      inputHash: HASH,
      configHash: 'b'.repeat(64),
      createdLessonCount: 0,
      replacedLessonCount: 0,
      chunkLessonCount: 0,
      finishedAt: '2026-07-30T00:00:00.000Z',
    },
    snapshot: {
      lessonRun: {
        id: 'lesson-run-1',
        inputHash: HASH,
        configHash: 'b'.repeat(64),
        createdLessonCount: 0,
        replacedLessonCount: 0,
        chunkLessonCount: 0,
        finishedAt: '2026-07-30T00:00:00.000Z',
      },
      receipt: { key: 'receipt-2' },
    },
  },
  {
    name: 'legacy summary before final write',
    proof: {
      kind: 'legacy_summary_before_final_write',
      summaryRunId: 'summary-run-1',
      receiptKey: 'receipt-3',
      inputHash: HASH,
      completedFinalWrites: 0,
    },
    snapshot: {
      summaryRun: {
        id: 'summary-run-1',
        inputHash: HASH,
        completedFinalWrites: 0,
      },
      receipt: { key: 'receipt-3' },
    },
  },
];

for (const proofCase of proofCases) {
  test(`normalizes closed no-effect proof: ${proofCase.name}`, () => {
    const evidence = noEffect(proofCase.proof);
    assert.deepEqual(normalizeOperationEvidence(evidence, proofCase.snapshot), evidence);
    assert.equal(
      normalizeOperationEvidence(evidence, {}).kind,
      'unknown',
    );
  });
}

test('missing or contradictory no-effect proof always becomes unknown', () => {
  const missing = normalizeOperationEvidence({
    kind: 'no_effect',
    observation: 'execution_error',
    reasonCode: 'timeout',
  });
  assert.deepEqual(missing, {
    kind: 'unknown',
    receiptKey: 'receipt_unavailable',
    reasonCode: 'no_effect_unproven',
  });

  const proof = proofCases[0];
  const contradicted = normalizeOperationEvidence(noEffect(proof.proof), {
    ...proof.snapshot,
    receipt: { formalEffect: true },
  });
  assert.equal(contradicted.kind, 'unknown');
});

test('the recovery entry point always normalizes before deciding and binds the observation', () => {
  const proof = proofCases[0];
  const candidateEvidence = noEffect(proof.proof);
  const valid = resolveOperationRecovery({
    candidateEvidence,
    snapshot: proof.snapshot,
    budget: { attemptsUsed: 0, maxAttempts: 1 },
  });
  assert.equal(valid.evidence.kind, 'no_effect');
  assert.equal(valid.decision.action, 'retry');
  assert.equal(valid.policyHash, RECOVERY_POLICY_HASH);
  assert.equal(valid.normalization.candidate_evidence_hash, recoveryValueHash(candidateEvidence));
  assert.equal(valid.normalization.snapshot_hash, recoveryValueHash(proof.snapshot));
  assert.equal(valid.normalization.normalized_evidence_hash, recoveryValueHash(valid.evidence));

  const stale = resolveOperationRecovery({
    candidateEvidence,
    snapshot: {
      ...proof.snapshot,
      receipt: { formalEffect: true },
    },
    budget: { attemptsUsed: 0, maxAttempts: 1 },
  });
  assert.equal(stale.evidence.kind, 'unknown');
  assert.equal(stale.decision.action, 'reconcile');
});

test('recovery decision table covers every evidence kind', () => {
  const proof = {
    kind: 'request_not_dispatched',
    attemptId: 'attempt-1',
    journalSeq: 1,
  };
  const cases = [
    [{
      kind: 'committed',
      receiptKey: 'receipt',
      receiptVersion: 1,
      resultRef: 'result',
      effectHash: HASH,
    }, { effectVerification: 'all_applied' }, 'replay'],
    [{
      kind: 'committed',
      receiptKey: 'receipt',
      receiptVersion: 1,
      resultRef: 'result',
      effectHash: HASH,
    }, { effectVerification: 'plan_incomplete' }, 'resume_commit'],
    [{
      kind: 'committed',
      receiptKey: 'receipt',
      receiptVersion: 1,
      resultRef: 'result',
      effectHash: HASH,
    }, { effectVerification: 'conflict' }, 'block_run'],
    [{ kind: 'unknown', receiptKey: 'receipt', reasonCode: 'unknown' }, {}, 'reconcile'],
    [{ kind: 'committing', commitPlanRef: 'plan', effectHash: HASH }, {}, 'reconcile_commit'],
    [{ kind: 'staged', resultRef: 'result', effectHash: HASH }, {}, 'resume_commit'],
    [{
      kind: 'no_effect',
      observation: 'business_empty',
      reasonCode: 'empty',
      proof,
    }, {}, 'skipped'],
    [{
      kind: 'no_effect',
      observation: 'business_rejected',
      reasonCode: 'rejected',
      proof,
    }, {}, 'isolate'],
    [
      { kind: 'no_effect', observation: 'execution_error', reasonCode: 'failure', proof },
      { budget: { attemptsUsed: 0, maxAttempts: 1 } },
      'retry',
    ],
    [
      { kind: 'no_effect', observation: 'execution_error', reasonCode: 'failure', proof },
      { budget: { attemptsUsed: 1, maxAttempts: 1 } },
      'isolate',
    ],
    [{ kind: 'system_fault', code: 'journal_integrity_error' }, {}, 'block_run'],
  ];

  for (const [evidence, options, action] of cases) {
    assert.equal(decideRecovery({ evidence, ...options }).action, action);
  }
});

test('unknown structures and policy versions fail closed', () => {
  assert.deepEqual(decideRecovery({
    policyVersion: 'future/v2',
    evidence: { kind: 'unknown' },
  }), {
    policyVersion: RECOVERY_POLICY_VERSION,
    action: 'block_run',
    code: 'unsupported_recovery_contract',
  });
  assert.equal(decideRecovery({ evidence: { kind: 'future' } }).action, 'block_run');
  assert.equal(
    normalizeOperationEvidence({ kind: 'system_fault', code: 'provider_timeout' }).code,
    'unsupported_recovery_contract',
  );
});

test('reason codes cannot expand recovery semantics and decisions are deterministic', () => {
  const actions = new Set();
  for (let index = 0; index < 500; index += 1) {
    const evidence = {
      kind: 'no_effect',
      observation: 'execution_error',
      reasonCode: `provider_error_${index}`,
      proof: {
        kind: 'request_not_dispatched',
        attemptId: 'attempt-1',
        journalSeq: 1,
      },
    };
    const input = {
      evidence,
      budget: { attemptsUsed: index % 2, maxAttempts: 1 },
    };
    const first = decideRecovery(input);
    const second = decideRecovery(structuredClone(input));
    assert.deepEqual(first, second);
    actions.add(first.action);
  }
  assert.deepEqual([...actions].sort(), ['isolate', 'retry']);
});

test('policy hash binds proofs, observations, faults, and decision semantics', () => {
  for (const mutate of [
    (descriptor) => descriptor.evidence.noEffectObservations.push('future_observation'),
    (descriptor) => {
      descriptor.evidence.noEffectProofs.request_not_dispatched.push('future_field');
    },
    (descriptor) => descriptor.evidence.systemFaultCodes.push('future_fault'),
    (descriptor) => {
      descriptor.validation.retryBudget.availableWhen = 'attemptsUsed<=maxAttempts';
    },
    (descriptor) => {
      descriptor.failClosed.unprovedNoEffect = 'retry';
    },
    (descriptor) => descriptor.decisions.push(['unknown', '*', 'retry']),
  ]) {
    const changed = structuredClone(RECOVERY_POLICY_DESCRIPTOR);
    mutate(changed);
    assert.notEqual(recoveryPolicyHash(changed), RECOVERY_POLICY_HASH);
  }
});
