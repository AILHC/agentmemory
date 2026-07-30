import assert from 'node:assert/strict';
import test from 'node:test';
import { adaptSummaryOperationEvidence } from './summary-recovery-adapter-v1.mjs';

const unit = { unit_id: 'session-1', input_hash: 'runner-input' };
const attemptId = 'attempt-1';
const operationId = 'session-1:reduce';

function summaryResult(overrides = {}) {
  const summary = {
    title: 'Summary',
    narrative: 'Durable result',
    keyDecisions: [],
    filesModified: [],
    concepts: [],
  };
  return {
    ok: true,
    data: {
      status: 'succeeded',
      summary,
      attemptId,
      runnerInputHash: unit.input_hash,
      serviceInputHash: 'service-input',
      resumableRunId: 'summary-run-1',
      recoveryEvidence: {
        kind: 'committed',
        receiptKey: 'receipt-1',
        receiptVersion: 1,
        resultRef: 'summary-resumable-runs:summary-run-1',
        effectHash: 'bbd7feb740b1c81ad54d8d8333eb4abed6859eaf2159363cd505d182a408ab47',
      },
      ...overrides,
    },
  };
}

function requestNotDispatchedProof(observationStatus) {
  return {
    ok: false,
    data: {
      status: observationStatus,
      error: observationStatus,
      recoveryEvidence: {
        kind: 'no_effect',
        observation: observationStatus === 'skipped'
          ? 'business_empty'
          : observationStatus === 'infeasible'
            ? 'business_rejected'
            : 'execution_error',
        reasonCode: observationStatus,
        proof: {
          kind: 'receipt_before_formal_effect',
          receiptKey: 'receipt-1',
          receiptVersion: 1,
          phase: 'preflight',
          commitPlanAbsent: true,
        },
      },
    },
  };
}

test('successful and response-lost Summary results use committed replay evidence', () => {
  const first = adaptSummaryOperationEvidence({
    result: summaryResult(),
    unit,
    attemptId,
    operationId,
  });
  const replayed = adaptSummaryOperationEvidence({
    result: summaryResult(),
    unit,
    attemptId,
    operationId,
  });
  assert.deepEqual(first, replayed);
  assert.equal(first.evidence.kind, 'committed');
  assert.equal(first.decision.action, 'replay');
  assert.match(first.evidence.effectHash, /^[0-9a-f]{64}$/);
});

test('structured skipped and infeasible results preserve distinct business meaning', () => {
  const skipped = adaptSummaryOperationEvidence({
    result: requestNotDispatchedProof('skipped'),
    unit,
    attemptId,
    operationId,
  });
  assert.equal(skipped.evidence.kind, 'no_effect');
  assert.equal(skipped.evidence.observation, 'business_empty');
  assert.equal(skipped.decision.action, 'skipped');

  const infeasible = adaptSummaryOperationEvidence({
    result: requestNotDispatchedProof('infeasible'),
    unit,
    attemptId,
    operationId,
  });
  assert.equal(infeasible.evidence.kind, 'no_effect');
  assert.equal(infeasible.evidence.observation, 'business_rejected');
  assert.equal(infeasible.decision.action, 'isolate');
});

test('request not dispatched can retry while response loss and unknown state reconcile', () => {
  const preflight = adaptSummaryOperationEvidence({
    result: requestNotDispatchedProof('preflight_unavailable'),
    unit,
    attemptId,
    operationId,
    budget: { attemptsUsed: 0, maxAttempts: 1 },
  });
  assert.equal(preflight.evidence.kind, 'no_effect');
  assert.equal(preflight.evidence.observation, 'execution_error');
  assert.equal(preflight.decision.action, 'retry');

  for (const result of [
    { ok: false, status_code: 0, error: 'response_lost' },
    { ok: true, data: { status: 'future_status' } },
    { ok: false, data: { status: 'failed', failure: { cause: 'new_provider_error' } } },
  ]) {
    const adapted = adaptSummaryOperationEvidence({
      result,
      unit,
      attemptId,
      operationId,
    });
    assert.equal(adapted.evidence.kind, 'unknown');
    assert.equal(adapted.decision.action, 'reconcile');
  }
});

test('failed Summary responses preserve durable Retry-After scheduling evidence', () => {
  const notBefore = '2026-07-30T00:00:10.000Z';
  const adapted = adaptSummaryOperationEvidence({
    result: {
      ok: false,
      data: {
        status: 'failed',
        failure: {
          class: 'transient_provider',
          cause: 'rate_limited',
          phase: 'provider_call',
        },
        recoveryEvidence: {
          kind: 'no_effect',
          observation: 'execution_error',
          reasonCode: 'rate_limited',
          retryHint: { notBefore },
          proof: {
            kind: 'receipt_before_formal_effect',
            receiptKey: 'receipt-rate-limited',
            receiptVersion: 1,
            phase: 'provider_call',
            commitPlanAbsent: true,
          },
        },
      },
    },
    unit,
    attemptId,
    operationId,
    budget: { attemptsUsed: 0, maxAttempts: 1 },
  });

  assert.equal(adapted.evidence.retryHint.notBefore, notBefore);
  assert.equal(adapted.decision.action, 'retry');
  assert.equal(adapted.decision.notBefore, notBefore);
});

test('unproved skipped and infeasible results fail conservatively to coordination', () => {
  for (const status of ['skipped', 'infeasible']) {
    const adapted = adaptSummaryOperationEvidence({
      result: { ok: true, data: { status } },
      unit,
      attemptId,
      operationId,
    });
    assert.equal(adapted.evidence.kind, 'unknown');
    assert.equal(adapted.decision.action, 'reconcile');
  }
});

test('arbitrary response proof fields are not accepted as persisted facts', () => {
  const adapted = adaptSummaryOperationEvidence({
    result: {
      ok: false,
      data: {
        status: 'preflight_unavailable',
        noEffectProof: {
          kind: 'request_not_dispatched',
          attemptId,
          journalSeq: 9,
        },
        recoverySnapshot: {
          requestDispatch: {
            state: 'not_dispatched',
            persisted: true,
            attemptId,
            journalSeq: 9,
          },
        },
      },
    },
    unit,
    attemptId,
    operationId,
  });
  assert.equal(adapted.evidence.kind, 'unknown');
  assert.equal(adapted.decision.action, 'reconcile');
});

test('a mismatched Summary operation identity becomes a run-blocking system fault', () => {
  const adapted = adaptSummaryOperationEvidence({
    result: summaryResult({ operationUnitId: 'session-1:map:0' }),
    unit,
    attemptId,
    operationId,
  });
  assert.deepEqual(adapted.evidence, {
    kind: 'system_fault',
    code: 'operation_identity_conflict',
  });
  assert.equal(adapted.decision.action, 'block_run');
});
