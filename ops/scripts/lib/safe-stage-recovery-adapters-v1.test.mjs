import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  adaptMemoryConsolidateOperationEvidence,
  adaptSafeStageOperationEvidence,
  adaptSkillExtractOperationEvidence,
} from './safe-stage-recovery-adapters-v1.mjs';
import { resolveOperationRecovery } from './recovery-policy-v1.mjs';

const attemptId = 'run-attempt-1';

function receiptKey(stage, unitId) {
  return `xop_${createHash('sha256')
    .update(JSON.stringify([attemptId, stage, unitId]))
    .digest('hex')
    .slice(0, 32)}`;
}

function commitContext(stage) {
  return {
    preparedHandle: `${stage}-handle`,
    proposalHash: `${stage}-proposal`,
    prepareAttemptId: `${stage}-prepare`,
    prepareInputHash: `${stage}-prepare-input`,
  };
}

function unit(stage) {
  const context = commitContext(stage);
  return {
    unit_id: stage === 'memory_consolidate' ? 'mcw-1' : 'skill-1',
    input_hash: createHash('sha256')
      .update(JSON.stringify(Object.fromEntries(Object.entries({
        prepareRunId: context.prepareAttemptId,
        unitId: stage === 'memory_consolidate' ? 'mcw-1' : 'skill-1',
        prepareInputHash: context.prepareInputHash,
        preparedHandle: context.preparedHandle,
        proposalHash: context.proposalHash,
      }).sort(([left], [right]) => left.localeCompare(right, 'en')))))
      .digest('hex'),
  };
}

function committedFacts(stage, overrides = {}) {
  const currentUnit = unit(stage);
  const resultId = stage === 'memory_consolidate' ? 'mem-deterministic-1' : 'skill-deterministic-1';
  const proposalHash = `${stage}-proposal`;
  return {
    receipt: {
      key: receiptKey(stage, currentUnit.unit_id),
      version: 1,
      stage,
      runId: attemptId,
      unitId: currentUnit.unit_id,
      inputHash: currentUnit.input_hash,
      status: 'succeeded',
    },
    proposal: {
      key: `${stage}-key`,
      handle: `${stage}-handle`,
      proposalHash,
      stage,
      inputHash: currentUnit.input_hash,
      status: 'committed',
      commitIntent: {
        resultId,
        auditId: `${stage}-audit`,
        createdAt: '2026-07-30T00:00:00.000Z',
      },
    },
    result: { id: resultId },
    audit: {
      id: `${stage}-audit`,
      functionId: stage === 'memory_consolidate'
        ? 'mem::full-memory-consolidate-window-commit'
        : 'mem::full-skill-extract-commit',
      targetIds: [resultId],
    },
    response: stage === 'memory_consolidate'
      ? { status: 'succeeded', memoryIds: [resultId] }
      : { status: 'succeeded', proceduralMemoryIds: [resultId] },
    ...overrides,
  };
}

function noEffectFacts(stage, overrides = {}) {
  const currentUnit = unit(stage);
  return {
    receipt: {
      key: receiptKey(stage, currentUnit.unit_id),
      version: 1,
      stage,
      runId: attemptId,
      unitId: currentUnit.unit_id,
      inputHash: currentUnit.input_hash,
      phase: 'candidate_staging',
      commitPlanAbsent: true,
      formalEffect: false,
    },
    response: stage === 'memory_consolidate'
      ? { status: 'skipped', consolidated: 0 }
      : { status: 'skipped', extracted: false },
    ...overrides,
  };
}

function receiptBoundFacts(stage, status = 'succeeded') {
  const currentUnit = unit(stage);
  const resultId = stage === 'memory_consolidate' ? 'mem-receipt-1' : 'skill-receipt-1';
  const proposalHash = `${stage}-proposal`;
  return {
    receipt: {
      key: receiptKey(stage, currentUnit.unit_id),
      version: 1,
      stage,
      runId: attemptId,
      unitId: currentUnit.unit_id,
      inputHash: currentUnit.input_hash,
      status,
    },
    commitContext: commitContext(stage),
    response: status === 'succeeded'
      ? {
          success: true,
          status: 'succeeded',
          ...(stage === 'memory_consolidate'
            ? { memoryIds: [resultId] }
            : { proceduralMemoryIds: [resultId] }),
          domainEffectEvidence: {
            schema: stage === 'memory_consolidate'
              ? 'memory-consolidate-domain-effect/v1'
              : 'skill-extract-domain-effect/v1',
            proposalHash,
            resultId,
            auditId: `${stage}-audit`,
            effectHash: 'a'.repeat(64),
          },
        }
      : {
          success: false,
          retrySameIdentity: true,
        },
  };
}

for (const [stage, adapt] of [
  ['memory_consolidate', adaptMemoryConsolidateOperationEvidence],
  ['skill_extract', adaptSkillExtractOperationEvidence],
]) {
  test(`${stage} does not promote identifier-only persisted facts to committed`, () => {
    const facts = adapt({ unit: unit(stage), attemptId, safeFacts: committedFacts(stage) });
    assert.deepEqual(facts.candidateEvidence, {
      kind: 'unknown',
      receiptKey: receiptKey(stage, unit(stage).unit_id),
      reasonCode: 'safe_stage_effect_unknown',
    });
    assert.equal('effectVerification' in facts, false);
  });

  test(`${stage} reports proven no-effect facts without inventing a commit`, () => {
    const facts = adapt({ unit: unit(stage), attemptId, safeFacts: noEffectFacts(stage) });
    assert.equal(facts.candidateEvidence.kind, 'no_effect');
    assert.equal(facts.candidateEvidence.observation, 'business_empty');
    assert.equal(facts.snapshot.receipt.formalEffect, false);
    assert.equal('effectVerification' in facts, false);

    const resolved = resolveOperationRecovery({
      ...facts,
      budget: { attemptsUsed: 0, maxAttempts: 1 },
    });
    assert.equal(resolved.decision.action, 'skipped');
  });

  test(`${stage} binds a successful commit response to its outer operation receipt`, () => {
    const facts = adapt({
      unit: unit(stage),
      attemptId,
      safeFacts: receiptBoundFacts(stage),
    });
    assert.equal(facts.candidateEvidence.kind, 'committed');
    assert.equal(facts.effectVerification, 'all_applied');
    assert.equal(facts.snapshot.receipt.status, 'succeeded');
    assert.equal(facts.snapshot.commit.preparedHandle, `${stage}-handle`);
    assert.equal(facts.snapshot.domainEffect.resultId, facts.snapshot.commit.resultIds[0]);
  });

  test(`${stage} does not trust a successful receipt without domain effect evidence`, () => {
    const safeFacts = receiptBoundFacts(stage);
    delete safeFacts.response.domainEffectEvidence;
    const facts = adapt({
      unit: unit(stage),
      attemptId,
      safeFacts,
    });
    assert.equal(facts.candidateEvidence.kind, 'unknown');
    assert.equal('effectVerification' in facts, false);
  });

  test(`${stage} rejects domain evidence not bound to the commit input hash`, () => {
    const safeFacts = receiptBoundFacts(stage);
    const currentUnit = unit(stage);
    currentUnit.input_hash = 'wrong-commit-input-hash';
    safeFacts.receipt.inputHash = currentUnit.input_hash;
    safeFacts.receipt.key = receiptKey(stage, currentUnit.unit_id);
    const facts = adapt({
      unit: currentUnit,
      attemptId,
      safeFacts,
    });
    assert.equal(facts.candidateEvidence.kind, 'unknown');
    assert.equal('effectVerification' in facts, false);
  });

  test(`${stage} rejects an unsupported receipt version`, () => {
    const safeFacts = receiptBoundFacts(stage);
    safeFacts.receipt.version = 2;
    const facts = adapt({
      unit: unit(stage),
      attemptId,
      safeFacts,
    });
    assert.equal(facts.candidateEvidence.kind, 'unknown');
    assert.equal('effectVerification' in facts, false);
  });

  test(`${stage} reports an in-flight idempotent commit without deciding recovery`, () => {
    const facts = adapt({
      unit: unit(stage),
      attemptId,
      safeFacts: receiptBoundFacts(stage, 'running'),
    });
    assert.equal(facts.candidateEvidence.kind, 'committing');
    assert.equal(facts.snapshot.receipt.status, 'running');
    assert.equal('decision' in facts, false);

    const resolved = resolveOperationRecovery({
      ...facts,
      budget: { attemptsUsed: 0, maxAttempts: 0 },
    });
    assert.equal(resolved.decision.action, 'reconcile_commit');
  });

  test(`${stage} rejects an in-flight commit context not bound to the unit input hash`, () => {
    const currentUnit = unit(stage);
    const safeFacts = receiptBoundFacts(stage, 'running');
    safeFacts.commitContext.preparedHandle = 'different-handle';
    const facts = adapt({
      unit: currentUnit,
      attemptId,
      safeFacts,
    });
    assert.equal(facts.candidateEvidence.kind, 'unknown');
    assert.equal('effectVerification' in facts, false);
  });

  test(`${stage} fails closed to unknown for incomplete persisted facts`, () => {
    const facts = adapt({
      unit: unit(stage),
      attemptId,
      safeFacts: committedFacts(stage, { audit: undefined }),
    });
    assert.deepEqual(facts.candidateEvidence, {
      kind: 'unknown',
      receiptKey: receiptKey(stage, unit(stage).unit_id),
      reasonCode: 'safe_stage_effect_unknown',
    });
    assert.deepEqual(facts.snapshot, {});
  });

  test(`${stage} closes conflicting proposal identity as a system fault`, () => {
    const facts = adapt({
      unit: unit(stage),
      attemptId,
      safeFacts: committedFacts(stage, {
        proposal: { ...committedFacts(stage).proposal, inputHash: 'other-input' },
      }),
    });
    assert.deepEqual(facts.candidateEvidence, {
      kind: 'system_fault',
      code: 'operation_identity_conflict',
    });
    assert.deepEqual(facts.snapshot, {});
  });

  test(`${stage} maps only a closed structured hard failure to a system fault`, () => {
    const cause = stage === 'memory_consolidate'
      ? 'memory_consolidate_committed_effect_conflict'
      : 'skill_extract_committed_effect_conflict';
    const facts = adapt({
      unit: unit(stage),
      attemptId,
      result: {
        ok: false,
        data: { failure: { class: 'hard', cause } },
      },
    });
    assert.deepEqual(facts.candidateEvidence, {
      kind: 'system_fault',
      code: 'commit_plan_conflict',
    });
  });

  test(`${stage} does not promote matching free-form error text to a system fault`, () => {
    const error = stage === 'memory_consolidate'
      ? 'memory_consolidate_committed_effect_conflict'
      : 'skill_extract_committed_effect_conflict';
    const facts = adapt({
      unit: unit(stage),
      attemptId,
      result: { ok: false, data: { error } },
    });
    assert.equal(facts.candidateEvidence.kind, 'unknown');
  });
}

test('generic adapter rejects unsupported stages without choosing a recovery action', () => {
  const facts = adaptSafeStageOperationEvidence({
    stage: 'semantic_rollup',
    unit: unit('memory_consolidate'),
    attemptId,
  });
  assert.equal(facts.candidateEvidence.kind, 'unknown');
  assert.equal(facts.candidateEvidence.reasonCode, 'safe_stage_adapter_input_invalid');
  assert.equal('decision' in facts, false);
});

test('memory consolidation binds committed structured no-effect to the commit receipt', () => {
  const stage = 'memory_consolidate';
  const currentUnit = unit(stage);
  const context = commitContext(stage);
  const facts = adaptMemoryConsolidateOperationEvidence({
    unit: currentUnit,
    attemptId,
    safeFacts: {
      receipt: {
        key: receiptKey(stage, currentUnit.unit_id),
        version: 1,
        stage,
        runId: attemptId,
        unitId: currentUnit.unit_id,
        inputHash: currentUnit.input_hash,
        status: 'succeeded',
      },
      commitContext: context,
      response: {
        success: true,
        status: 'skipped',
        consolidated: 0,
        memoryIds: [],
        noEffectEvidence: {
          schema: 'memory-consolidate-no-effect/v1',
          proposalHash: context.proposalHash,
          reasonCode: 'no_durable_memory',
          proofHash: 'c'.repeat(64),
        },
      },
    },
  });
  assert.equal(facts.candidateEvidence.kind, 'no_effect');
  assert.equal(facts.candidateEvidence.proof.kind, 'committed_structured_no_effect');
  assert.equal(facts.snapshot.receipt.status, 'succeeded');
  assert.equal(resolveOperationRecovery({ ...facts }).decision.action, 'skipped');
});
