import assert from 'node:assert/strict';
import test from 'node:test';
import {
  adaptCrystalOperationEvidence,
} from './crystal-recovery-adapter-v1.mjs';

const runnerInputHash = 'a'.repeat(64);
const receiptInputHash = 'b'.repeat(64);
const effectHash = 'c'.repeat(64);

function succeeded(overrides = {}) {
  return {
    success: true,
    crystalIds: ['crys-1'],
    crystalRecoveryEvidence: {
      schema: 'crystal-recovery/v1',
      phase: 'committed',
      receiptKey: 'xop_0123456789abcdef0123456789abcdef',
      receiptVersion: 1,
      resultRef: 'crystal:crys-1',
      effectHash,
      identity: {
        runId: 'attempt-1',
        unitId: 'group-1',
        inputHash: receiptInputHash,
      },
      group: {
        groupId: 'group-1',
        actionIds: ['action-1'],
        actionUpdatedAts: ['2026-07-29T00:00:00.000Z'],
      },
    },
    operationReceipt: {
      key: 'xop_0123456789abcdef0123456789abcdef',
      version: 1,
      status: 'succeeded',
      runId: 'attempt-1',
      stage: 'crystal',
      unitId: 'group-1',
      inputHash: receiptInputHash,
      runnerInputHash,
    },
    ...overrides,
  };
}

function adapt(result) {
  return adaptCrystalOperationEvidence({
    result,
    unit: {
      unit_id: 'group-1',
      input_hash: runnerInputHash,
      action_ids: ['action-1'],
      action_updated_ats: ['2026-07-29T00:00:00.000Z'],
    },
    attemptId: 'attempt-1',
    operationId: 'group-1',
  });
}

test('crystal adapter binds the committed crystal to the runner receipt', () => {
  const facts = adapt(succeeded());
  assert.equal(facts.candidateEvidence.kind, 'committed');
  assert.equal(facts.candidateEvidence.receiptKey, 'xop_0123456789abcdef0123456789abcdef');
  assert.equal(facts.effectVerification, 'all_applied');
  assert.equal(facts.snapshot.crystal.expectedCrystalId, 'crys-1');
  assert.equal('decision' in facts, false);
});

for (const [name, mutate] of [
  ['runner input drift', (data) => { data.operationReceipt.runnerInputHash = 'd'.repeat(64); }],
  ['group drift', (data) => { data.crystalRecoveryEvidence.group.groupId = 'other'; }],
  ['action drift', (data) => { data.crystalRecoveryEvidence.group.actionIds = ['other']; }],
  ['receipt drift', (data) => { data.crystalRecoveryEvidence.receiptKey = 'xop_ffffffffffffffffffffffffffffffff'; }],
  ['result drift', (data) => { data.crystalIds = ['other']; }],
  ['effect hash absent', (data) => { data.crystalRecoveryEvidence.effectHash = 'invalid'; }],
]) {
  test(`crystal adapter fails closed for ${name}`, () => {
    const value = succeeded();
    mutate(value);
    const facts = adapt(value);
    assert.equal(facts.candidateEvidence.kind, 'unknown');
    assert.equal(facts.effectVerification, undefined);
  });
}

test('crystal adapter surfaces plan drift as a system fault candidate', () => {
  const facts = adapt({
    success: false,
    failure: { class: 'hard', cause: 'crystal_plan_drifted' },
  });
  assert.deepEqual(facts.candidateEvidence, {
    kind: 'system_fault',
    code: 'commit_plan_conflict',
  });
});

test('crystal adapter surfaces only closed structured crystal failure codes', () => {
  const conflict = adapt({
    success: false,
    failure: { class: 'hard', cause: 'crystal_formal_effect_conflict' },
  });
  assert.deepEqual(conflict.candidateEvidence, {
    kind: 'system_fault',
    code: 'commit_plan_conflict',
  });

  for (const result of [
    { success: false, error: 'crystal conflict' },
    { success: false, error: 'already crystallized into another crystal' },
    {
      success: false,
      error: 'identity conflict',
      failure: { class: 'unit', cause: 'crystal_formal_effect_conflict' },
    },
    {
      success: false,
      failure: { class: 'hard', cause: 'new_unregistered_crystal_failure' },
    },
  ]) {
    assert.equal(adapt(result).candidateEvidence.kind, 'unknown');
  }
});
