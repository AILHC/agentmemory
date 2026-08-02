import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  collectIncrementalExtractionStatus,
  INCREMENTAL_EXTRACTION_STAGES,
} from './incremental-extraction-status-v1.mjs';

const versions = Object.fromEntries(INCREMENTAL_EXTRACTION_STAGES.map((stage) => [
  stage,
  `${stage}/v1`,
]));

const contracts = {
  schema_version: 1,
  stages: INCREMENTAL_EXTRACTION_STAGES.map((stage) => ({
    stage,
    compatible_with: [versions[stage]],
  })),
};

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}

function scope(stage, kind, version = versions[stage]) {
  const token = `contract_${hash(version).slice(0, 16)}`;
  return `mem:extraction-contribution-${kind}:${stage}:${token}`;
}

function source(stage, id, content = id, sourceType = 'source') {
  return `${stage}|${sourceType}|${encodeURIComponent(id)}|${hash(content)}`;
}

function stateReader({ baseline = true } = {}) {
  const scopes = new Map();
  const put = (scopeName, key, value) => {
    const values = scopes.get(scopeName) ?? new Map();
    values.set(key, value);
    scopes.set(scopeName, values);
  };
  if (baseline) {
    put('mem:extraction-adopted-baseline-control', 'active', {
      activeBaselineId: 'baseline-test',
      updatedAt: '2026-08-02T00:00:00.000Z',
    });
    put('mem:extraction-adopted-baseline-manifests', 'baseline-test', {
      version: 1,
      id: 'baseline-test',
      state: 'sealed',
      sourceRunId: 'retired-old-run',
      retiredRunIds: ['retired-old-run'],
      decisionRef: 'MYC-122',
      expectedCoverage: {},
      expectedLessonSeed: { count: 0, digest: hash('[]') },
      naturalBoundaryStages: ['crystal', 'consolidation_procedural'],
      createdAt: '2026-08-02T00:00:00.000Z',
      updatedAt: '2026-08-02T00:00:00.000Z',
      sealedAt: '2026-08-02T00:00:00.000Z',
    });
  }
  return {
    put,
    async get(scopeName, key) {
      return scopes.get(scopeName)?.get(key) ?? null;
    },
    async list(scopeName) {
      return [...(scopes.get(scopeName)?.values() ?? [])];
    },
  };
}

function activate(kv, stage, version = versions[stage]) {
  kv.put(`mem:extraction-contribution-contract:${stage}`, 'active', {
    stage,
    version,
    activatedAt: '2026-08-02T00:00:00.000Z',
  });
}

function terminalRecord({
  stage,
  sourceVersionKey,
  state = 'committed',
  contributionId = `ctr-${stage}`,
  runId = `run-${stage}`,
  unitId = `unit-${stage}`,
  receiptKey = `receipt-${stage}`,
  effectKey = `effect-${stage}`,
  version = versions[stage],
}) {
  return {
    stage,
    stageContractVersion: version,
    sourceVersionKey,
    state,
    contributionId,
    runId,
    unitId,
    claimedAt: '2026-08-02T00:00:00.000Z',
    committedAt: '2026-08-02T00:00:01.000Z',
    operationReceiptRef: { scope: `receipts:${stage}`, key: receiptKey },
    effectRefs: state === 'committed'
      ? [{ scope: `effects:${stage}`, key: effectKey }]
      : [],
    ...(state === 'no_effect'
      ? {
          noEffectProof: {
            kind: 'strict_legal_empty',
            receiptKey,
            reasonCode: 'legal_empty',
          },
        }
      : {}),
  };
}

function seedTerminal(kv, record, { withEffect = true } = {}) {
  kv.put(scope(record.stage, 'records', record.stageContractVersion), record.sourceVersionKey, record);
  kv.put(scope(record.stage, 'heads', record.stageContractVersion), record.sourceVersionKey, {
    sourceVersionKey: record.sourceVersionKey,
    state: record.state,
    contributionId: record.contributionId,
    updatedAt: record.committedAt,
  });
  kv.put(record.operationReceiptRef.scope, record.operationReceiptRef.key, {
    key: record.operationReceiptRef.key,
    stage: record.stage,
    runId: record.runId,
    unitId: record.unitId,
    status: 'succeeded',
  });
  if (record.state === 'committed' && withEffect) {
    kv.put(record.effectRefs[0].scope, record.effectRefs[0].key, { id: record.effectRefs[0].key });
  }
}

test('projects all eight stages without exposing StateKV bodies', async () => {
  const kv = stateReader();
  const sentinel = 'SECRET_BODY_MUST_NOT_LEAVE_STATE';
  for (const stage of INCREMENTAL_EXTRACTION_STAGES) {
    activate(kv, stage);
    const record = terminalRecord({ stage, sourceVersionKey: source(stage, `${stage}-source`) });
    seedTerminal(kv, record);
    kv.put(record.effectRefs[0].scope, record.effectRefs[0].key, {
      id: record.effectRefs[0].key,
      content: sentinel,
    });
  }

  const status = await collectIncrementalExtractionStatus({
    kv,
    contracts,
    runId: 'redacted-run',
  });

  assert.deepEqual(status.contribution_counts, {
    claimed: 0,
    committed: 8,
    no_effect: 0,
  });
  assert.equal(status.acceptance_ready, true);
  assert.equal(status.stages.length, 8);
  assert.equal(JSON.stringify(status).includes(sentinel), false);
  assert.equal(status.adopted_baseline.state, 'sealed');
});

test('blocks acceptance for claimed, duplicate, missing-effect, correction, and contract faults', async () => {
  const kv = stateReader();
  for (const stage of INCREMENTAL_EXTRACTION_STAGES) activate(kv, stage);

  const committed = terminalRecord({
    stage: 'summary',
    sourceVersionKey: source('summary', 'stable-summary', 'v1'),
  });
  seedTerminal(kv, committed, { withEffect: false });
  const duplicate = terminalRecord({
    stage: 'summary',
    sourceVersionKey: source('summary', 'stable-summary', 'v2'),
    contributionId: 'duplicate-contribution',
    receiptKey: 'duplicate-receipt',
    effectKey: 'duplicate-effect',
  });
  seedTerminal(kv, duplicate);

  const claimedSource = source('lessons', 'claimed-source');
  kv.put(scope('lessons', 'records'), claimedSource, {
    stage: 'lessons',
    stageContractVersion: versions.lessons,
    sourceVersionKey: claimedSource,
    state: 'claimed',
    contributionId: 'claimed-contribution',
    runId: 'claimed-run',
    unitId: 'claimed-unit',
    claimedAt: '2026-08-02T00:00:00.000Z',
  });
  kv.put(scope('lessons', 'heads'), claimedSource, {
    sourceVersionKey: claimedSource,
    state: 'claimed',
    contributionId: 'claimed-contribution',
    updatedAt: '2026-08-02T00:00:00.000Z',
  });
  activate(kv, 'crystal', 'crystal/v2');

  const status = await collectIncrementalExtractionStatus({
    kv,
    contracts,
    runId: 'faulted-run',
    stageEvents: {
      skill_extract: [
        { seq: 0, type: 'unit_planned', payload: { unit_id: 'skill-a', source_ids: ['session-a'] } },
        { seq: 1, type: 'unit_terminal', payload: {
          unit_id: 'skill-a',
          status: 'failed',
          reason: 'skill_extract_source_correction_requires_migration',
        } },
      ],
    },
  });

  assert.equal(status.acceptance_ready, false);
  assert.equal(status.contribution_counts.claimed, 1);
  assert.equal(status.duplicate_source_contributions, 1);
  assert.equal(status.unreconciled_effects, 1);
  assert.deepEqual(status.contract_migration_required_stages, ['crystal']);
  assert.equal(status.source_correction_requires_migration >= 2, true);
});

test('distinguishes runnable backlog from threshold waiting without treating waiting as contributed', async () => {
  const kv = stateReader();
  for (const stage of INCREMENTAL_EXTRACTION_STAGES) activate(kv, stage);
  const projectToken = `project_${hash('*').slice(0, 16)}`;
  for (let index = 0; index < 9; index += 1) {
    const key = source(
      'memory_consolidate',
      `observation-${index}`,
      `observation-${index}`,
      'observation',
    );
    kv.put(`mem:memory-consolidation-backlog:${projectToken}`, key, {
      sourceVersionKey: key,
      observationId: `observation-${index}`,
      sessionId: 'session-a',
      normalizedContentHash: key.split('|').at(-1),
      concepts: ['shared-concept'],
      importance: 8,
      estimatedChars: 100,
      firstWaitingAt: `2026-08-01T00:00:0${index}.000Z`,
      updatedAt: '2026-08-02T00:00:00.000Z',
    });
  }
  const procedural = source(
    'consolidation_procedural',
    'pattern-a',
    'pattern-a',
    'memory',
  );
  kv.put('mem:consolidation-procedural-backlog', procedural, {
    sourceVersionKey: procedural,
    memoryId: 'pattern-a',
    normalizedContentHash: hash('pattern-a'),
    firstWaitingAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-02T00:00:00.000Z',
  });

  const waiting = await collectIncrementalExtractionStatus({
    kv,
    contracts,
    runId: 'waiting-run',
  });
  assert.equal(
    waiting.stages.find((stage) => stage.stage === 'memory_consolidate').backlog.status,
    'waiting_for_more_evidence',
  );
  assert.equal(
    waiting.stages.find((stage) => stage.stage === 'consolidation_procedural').backlog.status,
    'waiting_for_more_evidence',
  );
  assert.equal(waiting.acceptance_ready, true);

  const tenth = source(
    'memory_consolidate',
    'observation-9',
    'observation-9',
    'observation',
  );
  kv.put(`mem:memory-consolidation-backlog:${projectToken}`, tenth, {
    sourceVersionKey: tenth,
    observationId: 'observation-9',
    sessionId: 'session-a',
    normalizedContentHash: tenth.split('|').at(-1),
    concepts: ['shared-concept'],
    importance: 8,
    estimatedChars: 100,
    firstWaitingAt: '2026-08-01T00:00:09.000Z',
    updatedAt: '2026-08-02T00:00:00.000Z',
  });
  const secondPattern = source(
    'consolidation_procedural',
    'pattern-b',
    'pattern-b',
    'memory',
  );
  kv.put('mem:consolidation-procedural-backlog', secondPattern, {
    sourceVersionKey: secondPattern,
    memoryId: 'pattern-b',
    normalizedContentHash: hash('pattern-b'),
    firstWaitingAt: '2026-08-01T00:00:01.000Z',
    updatedAt: '2026-08-02T00:00:00.000Z',
  });

  const runnable = await collectIncrementalExtractionStatus({
    kv,
    contracts,
    runId: 'runnable-run',
  });
  assert.equal(
    runnable.stages.find((stage) => stage.stage === 'memory_consolidate').backlog.status,
    'runnable',
  );
  assert.equal(
    runnable.stages.find((stage) => stage.stage === 'consolidation_procedural').backlog.status,
    'runnable',
  );
  assert.equal(runnable.acceptance_ready, false);
});

test('a preparing adopted baseline stays behind the activation gate', async () => {
  const kv = stateReader({ baseline: false });
  for (const stage of INCREMENTAL_EXTRACTION_STAGES) activate(kv, stage);
  kv.put('mem:extraction-adopted-baseline-manifests', 'baseline-preparing', {
    version: 1,
    id: 'baseline-preparing',
    state: 'preparing',
    updatedAt: '2026-08-02T00:00:00.000Z',
  });

  const status = await collectIncrementalExtractionStatus({
    kv,
    contracts,
    runId: 'formal-run',
  });

  assert.equal(status.adopted_baseline.state, 'preparing');
  assert.equal(status.adopted_baseline.baseline_id, 'baseline-preparing');
  assert.equal(status.acceptance_ready, false);
});

test('detects duplicate compatible-contract contributions without mislabeling identical content as correction', async () => {
  const kv = stateReader();
  for (const stage of INCREMENTAL_EXTRACTION_STAGES) activate(kv, stage);
  const compatibleContracts = structuredClone(contracts);
  compatibleContracts.stages.find((entry) => entry.stage === 'summary').compatible_with = [
    'summary/v0',
    'summary/v1',
  ];
  const sourceVersionKey = source('summary', 'same-stable-source', 'same-content');
  seedTerminal(kv, terminalRecord({
    stage: 'summary',
    version: 'summary/v0',
    sourceVersionKey,
    contributionId: 'old-contract-contribution',
    receiptKey: 'old-contract-receipt',
    effectKey: 'old-contract-effect',
  }));
  seedTerminal(kv, terminalRecord({
    stage: 'summary',
    sourceVersionKey,
    contributionId: 'active-contract-contribution',
    receiptKey: 'active-contract-receipt',
    effectKey: 'active-contract-effect',
  }));

  const status = await collectIncrementalExtractionStatus({
    kv,
    contracts: compatibleContracts,
    runId: 'compatible-duplicate-run',
  });
  assert.equal(status.duplicate_source_contributions, 1);
  assert.equal(status.source_correction_requires_migration, 0);
  assert.equal(status.acceptance_ready, false);
});

test('scopes global aggregate backlog by project and rejects wrong-stage records', async () => {
  const kv = stateReader();
  for (const stage of INCREMENTAL_EXTRACTION_STAGES) activate(kv, stage);
  for (let index = 0; index < 2; index += 1) {
    const key = source(
      'consolidation_procedural',
      `project-b-${index}`,
      `project-b-${index}`,
      'memory',
    );
    kv.put('mem:consolidation-procedural-backlog', key, {
      sourceVersionKey: key,
      memoryId: `project-b-${index}`,
      normalizedContentHash: key.split('|').at(-1),
      project: 'project-b',
      firstWaitingAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-02T00:00:00.000Z',
    });
  }
  const projectA = source(
    'consolidation_procedural',
    'project-a-0',
    'project-a-0',
    'memory',
  );
  kv.put('mem:consolidation-procedural-backlog', projectA, {
    sourceVersionKey: projectA,
    memoryId: 'project-a-0',
    normalizedContentHash: projectA.split('|').at(-1),
    project: 'project-a',
    firstWaitingAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-02T00:00:00.000Z',
  });
  const wrongStage = source('summary', 'wrong-stage');
  kv.put('mem:consolidation-procedural-backlog', wrongStage, {
    sourceVersionKey: wrongStage,
    memoryId: 'wrong-stage',
    normalizedContentHash: wrongStage.split('|').at(-1),
    firstWaitingAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-02T00:00:00.000Z',
  });

  const status = await collectIncrementalExtractionStatus({
    kv,
    contracts,
    runId: 'project-scoped-backlog-run',
    project: 'project-a',
  });
  const procedural = status.stages.find((entry) => (
    entry.stage === 'consolidation_procedural'
  ));
  assert.equal(procedural.backlog.source_count, 1);
  assert.equal(procedural.backlog.status, 'waiting_for_more_evidence');
  assert.equal(procedural.backlog.integrity_errors, 1);
  assert.equal(status.acceptance_ready, false);
});
