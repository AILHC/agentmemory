import assert from 'node:assert/strict';
import test from 'node:test';
import {
  adaptSemanticRollupOperationEvidence,
} from './semantic-rollup-recovery-adapter-v1.mjs';

const inputHash = 'a'.repeat(64);
const configHash = 'b'.repeat(64);
const effectHash = 'c'.repeat(64);
const runnerInputHash = 'd'.repeat(64);
const receiptInputHash = 'e'.repeat(64);
const sourceSummaryHashes = {
  'session-1': 'f'.repeat(64),
  'session-2': '0'.repeat(64),
};

function succeeded(overrides = {}) {
  return {
    success: true,
    status: 'succeeded',
    runId: 'run-1',
    windowId: 'window-1',
    inputHash,
    configHash,
    semanticMemoryIds: ['sem-1', 'sem-2'],
    operationReceipt: {
      key: 'xop_0123456789abcdef0123456789abcdef',
      version: 1,
      status: 'succeeded',
      runId: 'attempt-1',
      stage: 'semantic_rollup',
      unitId: 'window-1',
      inputHash: receiptInputHash,
      runnerInputHash,
    },
    semanticRecoveryEvidence: {
      schema: 'semantic-rollup-recovery/v1',
      phase: 'committed',
      receiptKey: 'xop_0123456789abcdef0123456789abcdef',
      receiptVersion: 1,
      resultRef: 'mem:audit:aud-1',
      effectHash,
      identity: {
        runId: 'attempt-1',
        unitId: 'window-1',
        receiptInputHash,
        runnerInputHash,
        extractionRunId: 'run-1',
        extractionWindowId: 'window-1',
        inputHash,
        configHash,
      },
      sourceSummaryHashes: { ...sourceSummaryHashes },
    },
    ...overrides,
  };
}

function adapt(result) {
  return adaptSemanticRollupOperationEvidence({
    result,
    unit: {
      unit_id: 'window-1',
      input_hash: runnerInputHash,
      source_summary_hashes: { ...sourceSummaryHashes },
    },
    attemptId: 'attempt-1',
    operationId: 'window-1',
  });
}

test('semantic rollup adapter reports a fully bound committed collection without deciding recovery', () => {
  const facts = adapt(succeeded());
  assert.equal(facts.candidateEvidence.kind, 'committed');
  assert.equal(facts.candidateEvidence.receiptKey, 'xop_0123456789abcdef0123456789abcdef');
  assert.equal(facts.effectVerification, 'all_applied');
  assert.deepEqual(facts.snapshot.semanticRollup.expectedSemanticMemoryIds, ['sem-1', 'sem-2']);
  assert.equal('decision' in facts, false);
  assert.equal('policyVersion' in facts, false);
});

for (const [name, mutate] of [
  ['window identity conflict', (data) => { data.semanticRecoveryEvidence.identity.extractionWindowId = 'other-window'; }],
  ['config identity conflict', (data) => { data.semanticRecoveryEvidence.identity.configHash = 'd'.repeat(64); }],
  ['receipt reference conflict', (data) => { data.semanticRecoveryEvidence.receiptKey = 'xop_ffffffffffffffffffffffffffffffff'; }],
  ['duplicate expected ids', (data) => { data.semanticMemoryIds = ['sem-1', 'sem-1']; }],
  ['missing effect hash', (data) => { data.semanticRecoveryEvidence.effectHash = 'invalid'; }],
  ['runner receipt identity conflict', (data) => { data.operationReceipt.runnerInputHash = 'f'.repeat(64); }],
  ['source summary hash conflict', (data) => { data.semanticRecoveryEvidence.sourceSummaryHashes['session-1'] = '1'.repeat(64); }],
]) {
  test(`semantic rollup adapter fails closed for ${name}`, () => {
    const value = succeeded();
    mutate(value);
    const facts = adapt(value);
    assert.equal(facts.candidateEvidence.kind, 'unknown');
    assert.equal(facts.effectVerification, undefined);
  });
}

test('semantic rollup adapter surfaces closed structured hard failures as candidate system faults', () => {
  const facts = adapt({
    success: false,
    failure: { class: 'hard', cause: 'configuration_identity_conflict' },
  });
  assert.deepEqual(facts.candidateEvidence, {
    kind: 'system_fault',
    code: 'configuration_identity_conflict',
  });
  assert.equal('decision' in facts, false);

  for (const result of [
    { success: false, error: 'configuration_identity_conflict' },
    {
      success: false,
      failure: { class: 'unit', cause: 'semantic_rollup_commit_conflict' },
    },
    {
      success: false,
      failure: { class: 'hard', cause: 'new_unregistered_semantic_failure' },
    },
  ]) {
    assert.equal(adapt(result).candidateEvidence.kind, 'unknown');
  }
});
