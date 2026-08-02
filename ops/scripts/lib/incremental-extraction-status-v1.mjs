import { createHash } from 'node:crypto';

export const INCREMENTAL_EXTRACTION_STATUS_SCHEMA =
  'agentmemory-incremental-extraction-status/v1';

export const INCREMENTAL_EXTRACTION_STAGES = Object.freeze([
  'summary',
  'lessons',
  'memory_consolidate',
  'semantic_rollup',
  'skill_extract',
  'crystal',
  'consolidation_procedural',
  'reflect_insight',
]);

const HASH = /^[0-9a-f]{64}$/;
const TERMINAL_STATES = new Set(['committed', 'no_effect']);
const RECEIPT_TERMINAL_STATES = new Set(['succeeded', 'committed', 'reconciled']);
const WAITING_BACKLOG_STAGES = new Set([
  'memory_consolidate',
  'consolidation_procedural',
  'reflect_insight',
]);

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${stableStringify(value[key])}`
  )).join(',')}}`;
}

function contractToken(version) {
  return `contract_${sha256(version).slice(0, 16)}`;
}

function projectToken(project) {
  return `project_${sha256(project?.trim() || '*').slice(0, 16)}`;
}

function contributionContractScope(stage) {
  return `mem:extraction-contribution-contract:${stage}`;
}

function contributionRecordScope(stage, version) {
  return `mem:extraction-contribution-records:${stage}:${contractToken(version)}`;
}

function contributionHeadScope(stage, version) {
  return `mem:extraction-contribution-heads:${stage}:${contractToken(version)}`;
}

function memoryBacklogScope(project) {
  return `mem:memory-consolidation-backlog:${projectToken(project)}`;
}

function extractionOperationKey({ runId, stage, unitId }) {
  return `xop_${sha256(JSON.stringify([runId, stage, unitId])).slice(0, 32)}`;
}

function parseSourceVersionKey(value) {
  if (typeof value !== 'string') return null;
  const parts = value.split('|');
  if (
    parts.length !== 4
    || !parts[0]
    || !/^[a-z_][a-z0-9_]{0,63}$/.test(parts[1] || '')
    || !parts[2]
    || !HASH.test(parts[3] || '')
  ) return null;
  try {
    return {
      stage: parts[0],
      sourceType: parts[1],
      stableSourceId: decodeURIComponent(parts[2]),
      normalizedContentHash: parts[3],
    };
  } catch {
    return null;
  }
}

function sourceRefs(unit) {
  const selected = [
    unit?.source_version_keys,
    unit?.sourceVersionKeys,
    unit?.source_ids,
    unit?.sourceIds,
    unit?.source_observation_ids,
    unit?.sourceObservationIds,
    unit?.observation_ids,
    unit?.observationIds,
  ].find((value) => Array.isArray(value));
  return selected?.filter((value) => typeof value === 'string' && value) ?? [];
}

function safeCodeValues(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return [];
  const values = [
    payload.reason,
    payload.reason_code,
    payload.cause,
    payload.code,
    payload.error,
    payload.failure?.cause,
    payload.decision?.code,
    payload.decision?.reasonCode,
  ];
  return values.filter((value) => typeof value === 'string');
}

function journalSignals(events = []) {
  const units = new Map();
  const sourceCorrections = new Set();
  const unreconciledEffects = new Set();
  const contributionReconciliations = new Set();
  let contractMigrationRequired = false;
  for (const event of events) {
    if (event?.type === 'unit_planned') {
      units.set(event.payload?.unit_id, event.payload);
    }
    if (event?.type === 'unit_split') {
      for (const child of event.payload?.children ?? []) {
        units.set(child?.unit_id, child);
      }
    }
    const unitId = event?.payload?.unit_id;
    const unitSources = sourceRefs(units.get(unitId));
    const identities = unitSources.length > 0 ? unitSources : [unitId].filter(Boolean);
    for (const code of safeCodeValues(event?.payload)) {
      if (code.includes('contract_migration_required')) {
        contractMigrationRequired = true;
      }
      if (code.includes('source_correction_requires_migration')) {
        for (const identity of identities) sourceCorrections.add(identity);
      }
      if (
        code.includes('contribution_effect_reconciliation_required')
        || code.includes('contribution_effect_unverifiable')
        || code.includes('committed_effect_conflict')
      ) {
        for (const identity of identities) unreconciledEffects.add(identity);
      }
      if (
        code.includes('contribution_reconciliation_required')
        || code.includes('extraction_operation_reconciliation_required')
      ) {
        for (const identity of identities) contributionReconciliations.add(identity);
      }
    }
  }
  return {
    contractMigrationRequired,
    sourceCorrectionCount: sourceCorrections.size,
    unreconciledEffectCount: unreconciledEffects.size,
    contributionReconciliationCount: contributionReconciliations.size,
  };
}

function validTerminalRecord(record) {
  if (!record?.operationReceiptRef?.scope || !record.operationReceiptRef.key) return false;
  if (record.state === 'committed') {
    return Array.isArray(record.effectRefs)
      && record.effectRefs.some((effect) => effect?.scope && effect?.key);
  }
  return Array.isArray(record.effectRefs)
    && record.effectRefs.length === 0
    && record.noEffectProof?.kind === 'strict_legal_empty'
    && record.noEffectProof.receiptKey === record.operationReceiptRef.key
    && typeof record.noEffectProof.reasonCode === 'string'
    && record.noEffectProof.reasonCode.length > 0;
}

function recordMatchesHead(record, head) {
  return head?.sourceVersionKey === record?.sourceVersionKey
    && head?.contributionId === record?.contributionId
    && head?.state === record?.state;
}

async function terminalReferenceState(kv, record) {
  if (!validTerminalRecord(record)) {
    return { reconciliationRequired: 1, unreconciledEffects: record.state === 'committed' ? 1 : 0 };
  }
  const receipt = await kv.get(
    record.operationReceiptRef.scope,
    record.operationReceiptRef.key,
  );
  if (
    !receipt
    || !RECEIPT_TERMINAL_STATES.has(receipt.status)
    || (receipt.stage !== undefined && receipt.stage !== record.stage)
    || (receipt.runId !== undefined && receipt.runId !== record.runId)
    || (receipt.unitId !== undefined && receipt.unitId !== record.unitId)
  ) {
    return { reconciliationRequired: 1, unreconciledEffects: record.state === 'committed' ? 1 : 0 };
  }
  if (record.state === 'no_effect') {
    return { reconciliationRequired: 0, unreconciledEffects: 0 };
  }
  const effects = await Promise.all(record.effectRefs.map((effect) => (
    effect?.scope && effect?.key ? kv.get(effect.scope, effect.key) : Promise.resolve(null)
  )));
  const missing = effects.filter((effect) => effect === null || effect === undefined).length;
  return {
    reconciliationRequired: missing > 0 ? 1 : 0,
    unreconciledEffects: missing,
  };
}

async function claimedRecordState(kv, record) {
  if (!record?.runId || !record?.unitId) return { reconciliationRequired: 1 };
  const key = extractionOperationKey(record);
  const receipt = await kv.get(`mem:extraction-operation-receipt:${key}`, key);
  if (!receipt) return { reconciliationRequired: 0 };
  if (receipt.stage !== record.stage || receipt.runId !== record.runId || receipt.unitId !== record.unitId) {
    return { reconciliationRequired: 1 };
  }
  if (['failed', 'uncertain', 'reconciled'].includes(receipt.status)) {
    return { reconciliationRequired: 1 };
  }
  return { reconciliationRequired: 0 };
}

async function readContributionState({ kv, stage, contract, events }) {
  const active = await kv.get(contributionContractScope(stage), 'active');
  const compatible = [...new Set(contract.compatible_with)];
  const versions = [...new Set([
    ...(typeof active?.version === 'string' && active.version ? [active.version] : []),
    ...compatible,
  ])];
  const records = [];
  const heads = [];
  for (const version of versions) {
    const [versionRecords, versionHeads] = await Promise.all([
      kv.list(contributionRecordScope(stage, version)),
      kv.list(contributionHeadScope(stage, version)),
    ]);
    records.push(...versionRecords.map((record) => ({ version, record })));
    heads.push(...versionHeads.map((head) => ({ version, head })));
  }
  const counts = { claimed: 0, committed: 0, no_effect: 0 };
  let reconciliationRequired = 0;
  let unreconciledEffects = 0;
  const terminalByStableSource = new Map();
  const recordsByStableSource = new Map();
  const headsByVersionAndSource = new Map();
  for (const { version, head } of heads) {
    const parsed = parseSourceVersionKey(head?.sourceVersionKey);
    if (!parsed || parsed.stage !== stage) {
      reconciliationRequired += 1;
      continue;
    }
    const key = `${version}|${head.sourceVersionKey}`;
    if (headsByVersionAndSource.has(key)) reconciliationRequired += 1;
    headsByVersionAndSource.set(key, head);
  }
  const recordKeys = new Set();
  for (const { version, record } of records) {
    const parsed = parseSourceVersionKey(record?.sourceVersionKey);
    const recordKey = `${version}|${record?.sourceVersionKey}`;
    if (
      !parsed
      || parsed.stage !== stage
      || record?.stage !== stage
      || record?.stageContractVersion !== version
      || !['claimed', 'committed', 'no_effect'].includes(record?.state)
      || recordKeys.has(recordKey)
    ) {
      reconciliationRequired += 1;
      continue;
    }
    recordKeys.add(recordKey);
    counts[record.state] += 1;
    const stableKey = `${parsed.sourceType}|${parsed.stableSourceId}`;
    const stableRecords = recordsByStableSource.get(stableKey) ?? [];
    stableRecords.push(record);
    recordsByStableSource.set(stableKey, stableRecords);
    const head = headsByVersionAndSource.get(recordKey);
    if (!recordMatchesHead(record, head)) reconciliationRequired += 1;
    if (TERMINAL_STATES.has(record.state)) {
      const terminal = terminalByStableSource.get(stableKey) ?? [];
      terminal.push(record);
      terminalByStableSource.set(stableKey, terminal);
      const state = await terminalReferenceState(kv, record);
      reconciliationRequired += state.reconciliationRequired;
      unreconciledEffects += state.unreconciledEffects;
    } else {
      const state = await claimedRecordState(kv, record);
      reconciliationRequired += state.reconciliationRequired;
    }
  }
  for (const key of headsByVersionAndSource.keys()) {
    if (!recordKeys.has(key)) reconciliationRequired += 1;
  }
  const duplicateSources = [...terminalByStableSource.values()]
    .reduce((total, values) => total + Math.max(0, values.length - 1), 0);
  const sourceCorrections = [...recordsByStableSource.values()].filter((values) => (
    values.some((record) => TERMINAL_STATES.has(record.state))
    && new Set(values.map((record) => (
      parseSourceVersionKey(record.sourceVersionKey)?.normalizedContentHash
    ))).size > 1
  )).length;
  const signals = journalSignals(events);
  const activeVersion = typeof active?.version === 'string' ? active.version : null;
  const recordsExist = records.length > 0 || heads.length > 0;
  const contractMigrationRequired = signals.contractMigrationRequired
    || Boolean(activeVersion && !compatible.includes(activeVersion));
  if (!activeVersion && recordsExist) reconciliationRequired += 1;
  return {
    active_contract_version: activeVersion,
    compatible_contract_versions: compatible,
    contract_migration_required: contractMigrationRequired,
    contract_migration_reason_code: contractMigrationRequired
      ? 'stage_contract_incompatible'
      : null,
    counts,
    duplicate_source_contributions: duplicateSources,
    source_correction_requires_migration: Math.max(
      sourceCorrections,
      signals.sourceCorrectionCount,
    ),
    contribution_reconciliation_required: reconciliationRequired
      + signals.contributionReconciliationCount,
    unreconciled_effects: unreconciledEffects + signals.unreconciledEffectCount,
  };
}

function earliestWaitingAt(records) {
  return records
    .map((record) => record?.firstWaitingAt)
    .filter((value) => Number.isFinite(Date.parse(value || '')))
    .sort()
    .at(0) || null;
}

function validBacklogRecord(stage, record, project) {
  const parsed = parseSourceVersionKey(record?.sourceVersionKey);
  const common = record
    && parsed?.stage === stage
    && record.normalizedContentHash === parsed.normalizedContentHash
    && typeof record.firstWaitingAt === 'string'
    && Number.isFinite(Date.parse(record.firstWaitingAt))
    && typeof record.updatedAt === 'string'
    && Number.isFinite(Date.parse(record.updatedAt))
    && (
      record.project === undefined
      || (typeof record.project === 'string' && record.project.trim().length > 0)
    );
  if (!common) return false;
  if (stage === 'memory_consolidate') {
    const normalizedProject = project?.trim() || null;
    return parsed.sourceType === 'observation'
      && record.observationId === parsed.stableSourceId
      && typeof record.sessionId === 'string'
      && record.sessionId.length > 0
      && Array.isArray(record.concepts)
      && record.concepts.every((concept) => typeof concept === 'string' && concept)
      && Number.isFinite(record.importance)
      && Number.isSafeInteger(record.estimatedChars)
      && record.estimatedChars >= 0
      && (normalizedProject
        ? record.project === normalizedProject
        : record.project === undefined);
  }
  if (stage === 'consolidation_procedural') {
    return parsed.sourceType === 'memory'
      && record.memoryId === parsed.stableSourceId;
  }
  return ['semantic', 'lesson', 'crystal'].includes(parsed.sourceType)
    && record.sourceType === parsed.sourceType
    && typeof record.sourceId === 'string'
    && record.sourceId.length > 0;
}

function backlogCanRun(stage, records, memoryCharBudget) {
  if (stage === 'memory_consolidate') {
    const groups = new Map();
    for (const record of records) {
      const project = record.project || '';
      for (const concept of record.concepts ?? []) {
        if (typeof concept !== 'string' || !concept) continue;
        const key = `${project}|${concept.toLowerCase()}`;
        const group = groups.get(key) ?? [];
        group.push(record);
        groups.set(key, group);
      }
    }
    return [...groups.values()].some((group) => (
      group.length >= 10
      && group.some((record) => (
        !Number.isFinite(record.estimatedChars)
        || record.estimatedChars <= memoryCharBudget
      ))
    ));
  }
  const minimum = stage === 'consolidation_procedural' ? 2 : 3;
  const byProject = new Map();
  for (const record of records) {
    const key = record.project || '';
    byProject.set(key, (byProject.get(key) ?? 0) + 1);
  }
  return [...byProject.values()].some((count) => count >= minimum);
}

async function readBacklogState({ kv, stage, project, memoryCharBudget }) {
  if (!WAITING_BACKLOG_STAGES.has(stage)) {
    return {
      source_count: 0,
      earliest_waiting_at: null,
      status: 'not_applicable',
      integrity_errors: 0,
    };
  }
  const scope = stage === 'memory_consolidate'
    ? memoryBacklogScope(project)
    : stage === 'consolidation_procedural'
      ? 'mem:consolidation-procedural-backlog'
      : 'mem:reflect-insight-backlog';
  const raw = await kv.list(scope);
  const scoped = stage === 'memory_consolidate' || !project?.trim()
    ? raw
    : raw.filter((record) => (
        typeof record?.project !== 'string'
        || !record.project.trim()
        || record.project === project.trim()
      ));
  const records = scoped.filter((record) => validBacklogRecord(stage, record, project));
  const unique = new Map(records.map((record) => [record.sourceVersionKey, record]));
  const integrityErrors = scoped.length - unique.size;
  const sourceCount = unique.size;
  return {
    source_count: sourceCount,
    earliest_waiting_at: earliestWaitingAt([...unique.values()]),
    status: sourceCount === 0
      ? 'empty'
      : backlogCanRun(stage, [...unique.values()], memoryCharBudget)
        ? 'runnable'
        : 'waiting_for_more_evidence',
    integrity_errors: integrityErrors,
  };
}

function normalizeContracts(contracts) {
  if (
    !contracts
    || contracts.schema_version !== 1
    || !Array.isArray(contracts.stages)
  ) throw new Error('incremental_status_contracts_invalid');
  const byStage = new Map();
  for (const entry of contracts.stages) {
    if (
      !INCREMENTAL_EXTRACTION_STAGES.includes(entry?.stage)
      || byStage.has(entry.stage)
      || !Array.isArray(entry.compatible_with)
      || entry.compatible_with.length === 0
      || entry.compatible_with.some((version) => typeof version !== 'string' || !version)
    ) throw new Error('incremental_status_contracts_invalid');
    byStage.set(entry.stage, entry);
  }
  if (byStage.size !== INCREMENTAL_EXTRACTION_STAGES.length) {
    throw new Error('incremental_status_contracts_incomplete');
  }
  return byStage;
}

function baselineScope(baselineId, stage) {
  return `mem:extraction-adopted-baseline-coverage:baseline_${sha256(baselineId).slice(0, 16)}:${stage}`;
}

function lessonSeedScope(baselineId) {
  return `mem:extraction-adopted-baseline-lesson-seeds:baseline_${sha256(baselineId).slice(0, 16)}`;
}

function setDigest(records, identity) {
  return sha256(stableStringify(records.map(identity).sort((left, right) => (
    stableStringify(left).localeCompare(stableStringify(right), 'en')
  ))));
}

async function adoptedBaselineState(kv, runId) {
  const control = await kv.get('mem:extraction-adopted-baseline-control', 'active');
  if (!control?.activeBaselineId) {
    const preparing = (await kv.list('mem:extraction-adopted-baseline-manifests'))
      .filter((manifest) => manifest?.state === 'preparing')
      .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt), 'en'))[0];
    return {
      state: preparing ? 'preparing' : 'not_configured',
      baseline_id: preparing?.id ?? null,
      retired_current_run: false,
      integrity_errors: preparing ? ['baseline_not_sealed'] : ['baseline_not_configured'],
      acceptance_ready: false,
    };
  }
  const manifest = await kv.get('mem:extraction-adopted-baseline-manifests', control.activeBaselineId);
  if (!manifest || manifest.state !== 'sealed' || manifest.version !== 1) {
    return {
      state: 'invalid',
      baseline_id: control.activeBaselineId,
      retired_current_run: false,
      integrity_errors: ['baseline_control_drift'],
      acceptance_ready: false,
    };
  }
  const integrityErrors = [];
  const coverage = {};
  for (const [stage, expected] of Object.entries(manifest.expectedCoverage ?? {})) {
    const records = (await kv.list(baselineScope(manifest.id, stage)))
      .filter((record) => record?.baselineId === manifest.id && record?.stage === stage);
    const actualDigest = setDigest(records, (record) => [
      record.stage,
      record.stageContractVersion,
      record.sessionId,
      record.normalizedContentHash,
    ]);
    coverage[stage] = {
      expected_count: expected.count,
      actual_count: records.length,
      expected_digest: expected.digest,
      actual_digest: actualDigest,
    };
    if (records.length !== expected.count || actualDigest !== expected.digest) {
      integrityErrors.push(`coverage_mismatch:${stage}`);
    }
  }
  const lessonSeeds = (await kv.list(lessonSeedScope(manifest.id)))
    .filter((record) => record?.baselineId === manifest.id);
  const lessonSeedDigest = setDigest(lessonSeeds, (record) => [
    record.lessonId,
    record.sourceVersionKey,
    record.normalizedContentHash,
  ]);
  if (
    lessonSeeds.length !== manifest.expectedLessonSeed?.count
    || lessonSeedDigest !== manifest.expectedLessonSeed?.digest
  ) integrityErrors.push('lesson_seed_mismatch');
  return {
    state: 'sealed',
    baseline_id: manifest.id,
    source_run_id: manifest.sourceRunId,
    retired_run_ids: manifest.retiredRunIds,
    retired_current_run: manifest.retiredRunIds.includes(runId),
    coverage,
    lesson_seed_count: lessonSeeds.length,
    integrity_errors: integrityErrors,
    acceptance_ready: integrityErrors.length === 0 && !manifest.retiredRunIds.includes(runId),
  };
}

function stageAcceptanceReady(stage) {
  const backlogReady = ['empty', 'not_applicable', 'waiting_for_more_evidence']
    .includes(stage.backlog.status);
  return stage.contributions.claimed === 0
    && stage.contract_migration_required === false
    && stage.duplicate_source_contributions === 0
    && stage.source_correction_requires_migration === 0
    && stage.contribution_reconciliation_required === 0
    && stage.unreconciled_effects === 0
    && stage.backlog.integrity_errors === 0
    && backlogReady;
}

export async function collectIncrementalExtractionStatus({
  kv,
  contracts,
  runId,
  project,
  stageEvents = {},
  snapshotHash = null,
  memoryCharBudget = 64_000,
}) {
  if (!kv?.get || !kv?.list) throw new Error('incremental_status_state_reader_invalid');
  if (typeof runId !== 'string' || !runId) throw new Error('incremental_status_run_id_invalid');
  if (!Number.isSafeInteger(memoryCharBudget) || memoryCharBudget < 1) {
    throw new Error('incremental_status_memory_char_budget_invalid');
  }
  const contractsByStage = normalizeContracts(contracts);
  const stages = [];
  for (const stage of INCREMENTAL_EXTRACTION_STAGES) {
    const [contribution, backlog] = await Promise.all([
      readContributionState({
        kv,
        stage,
        contract: contractsByStage.get(stage),
        events: stageEvents[stage] ?? [],
      }),
      readBacklogState({ kv, stage, project, memoryCharBudget }),
    ]);
    const projected = {
      stage,
      ...contribution,
      contributions: contribution.counts,
      backlog,
    };
    delete projected.counts;
    projected.acceptance_ready = stageAcceptanceReady(projected);
    stages.push(projected);
  }
  const adoptedBaseline = await adoptedBaselineState(kv, runId);
  const contributionCounts = { claimed: 0, committed: 0, no_effect: 0 };
  for (const stage of stages) {
    for (const key of Object.keys(contributionCounts)) {
      contributionCounts[key] += stage.contributions[key];
    }
  }
  const acceptanceReady = stages.every((stage) => stage.acceptance_ready)
    && adoptedBaseline.acceptance_ready;
  return {
    schema: INCREMENTAL_EXTRACTION_STATUS_SCHEMA,
    run_id: runId,
    snapshot_hash: snapshotHash,
    contribution_counts: contributionCounts,
    backlog_source_count: stages.reduce(
      (total, stage) => total + stage.backlog.source_count,
      0,
    ),
    contract_migration_required_stages: stages
      .filter((stage) => stage.contract_migration_required)
      .map((stage) => stage.stage),
    source_correction_requires_migration: stages.reduce(
      (total, stage) => total + stage.source_correction_requires_migration,
      0,
    ),
    duplicate_source_contributions: stages.reduce(
      (total, stage) => total + stage.duplicate_source_contributions,
      0,
    ),
    contribution_reconciliation_required: stages.reduce(
      (total, stage) => total + stage.contribution_reconciliation_required,
      0,
    ),
    unreconciled_effects: stages.reduce(
      (total, stage) => total + stage.unreconciled_effects,
      0,
    ),
    adopted_baseline: adoptedBaseline,
    acceptance_ready: acceptanceReady,
    stages,
  };
}
