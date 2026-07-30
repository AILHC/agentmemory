import fs from 'node:fs/promises';
import path from 'node:path';
import {
  RECOVERY_POLICY_HASH,
  RECOVERY_POLICY_VERSION,
  decideRecovery,
} from './recovery-policy-v1.mjs';
import { reduceRecoveryJournal } from './recovery-journal-reducer-v1.mjs';
import {
  RECOVERY_MIGRATION_SCHEMA_VERSION,
  RECOVERY_MIGRATION_TOOL_VERSION,
  RECOVERY_MIGRATION_AUTHORIZATION_SOURCE_TYPES,
  canonicalRecoveryValue,
  hashRecoveryValue,
  inspectRecoveryMigrationGate,
  validateRecoveryMigrationManifest,
} from './recovery-migration-contract-v1.mjs';
import { adaptLessonOperationEvidence } from './lesson-recovery-adapter-v1.mjs';
import { adaptSummaryOperationEvidence } from './summary-recovery-adapter-v1.mjs';

function verifiedEvidenceRecord(unit, evidenceRecord, stage) {
  const journalOutcome = unit.recovery.outcomes.at(-1);
  if (journalOutcome) {
    return {
      evidence: journalOutcome.evidence,
      budget: journalOutcome.budget,
      effect_verification: journalOutcome.effect_verification,
      attempt_id: journalOutcome.attempt_id,
      operation_id: journalOutcome.operation_id,
      provenance: {
        source_type: 'journal_outcome',
        adapter: 'recovery-journal-outcome/v1',
        outcome_seq: journalOutcome.seq,
      },
    };
  }
  const expectedAdapter = `${stage}/legacy-safe-facts-v1`;
  if (
    evidenceRecord?.adapter !== expectedAdapter
    || !evidenceRecord.safe_facts
    || typeof evidenceRecord.safe_facts !== 'object'
  ) {
    throw new Error(`recovery_migration_verifiable_adapter_required:${unit.unit_id}`);
  }
  const attemptId = unit.attempt_id || evidenceRecord.attempt_id;
  const operationId = unit.active_operation?.operation_id
    || unit.completed_operations.at(-1)?.operation_id
    || evidenceRecord.operation_id
    || `${unit.unit_id}:legacy`;
  if (typeof attemptId !== 'string' || !attemptId) {
    throw new Error(`recovery_migration_adapter_attempt_missing:${unit.unit_id}`);
  }
  const adapter = stage === 'lessons'
    ? adaptLessonOperationEvidence
    : stage === 'summary'
      ? adaptSummaryOperationEvidence
      : null;
  if (!adapter) throw new Error(`recovery_migration_stage_adapter_unsupported:${stage}`);
  if (
    (stage === 'lessons' && 'lessonEvidence' in evidenceRecord.safe_facts)
    || (stage === 'summary' && 'recoveryEvidence' in evidenceRecord.safe_facts)
  ) {
    throw new Error(
      `recovery_migration_caller_authored_structured_evidence_forbidden:${unit.unit_id}`,
    );
  }
  const adapted = adapter({
    result: evidenceRecord.safe_facts,
    unit,
    attemptId,
    operationId,
    budget: evidenceRecord.budget,
  });
  const evidence = adapted.evidence;
  const safeLegacyEvidence = (
    evidence.kind === 'unknown'
    || evidence.kind === 'system_fault'
    || (
      stage === 'lessons'
      && evidence.kind === 'no_effect'
      && evidence.proof?.kind === 'legacy_lessons_zero_effect'
    )
  );
  if (!safeLegacyEvidence) {
    throw new Error(`recovery_migration_adapter_evidence_unsupported:${unit.unit_id}`);
  }
  return {
    evidence,
    budget: adapted.budget,
    effect_verification: adapted.effectVerification,
    attempt_id: attemptId,
    operation_id: operationId,
    provenance: {
      source_type: 'caller_json_preview',
      adapter: expectedAdapter,
      safe_fact_hash: hashRecoveryValue(evidenceRecord.safe_facts),
    },
  };
}

function migrationEntry(unit, evidenceRecord, stage) {
  const verified = verifiedEvidenceRecord(unit, evidenceRecord, stage);
  const evidence = verified.evidence;
  const budget = verified.budget;
  const effectVerification = verified.effect_verification;
  const decision = decideRecovery({
    policyVersion: RECOVERY_POLICY_VERSION,
    evidence,
    budget,
    effectVerification,
  });
  const currentAttemptNumber = unit.recovery.attempts.at(-1)?.attempt_number ?? 0;
  const attemptId = unit.attempt_id
    || verified.attempt_id
    || evidence.proof?.attemptId
    || `xmig_attempt_${hashRecoveryValue({
      unitId: unit.unit_id,
      evidence,
    }).slice(0, 32)}`;
  const entryCore = {
    unit_id: unit.unit_id,
    attempt_id: attemptId,
    current_attempt_number: currentAttemptNumber,
    start_attempt: !unit.attempt_id,
    operation_id: unit.active_operation?.operation_id
      || unit.completed_operations.at(-1)?.operation_id
      || verified.operation_id
      || `${unit.unit_id}:legacy`,
    evidence,
    evidence_hash: hashRecoveryValue(evidence),
    adapter_provenance: verified.provenance,
    decision,
    ...(budget ? { budget } : {}),
    ...(effectVerification ? { effect_verification: effectVerification } : {}),
  };
  return {
    ...entryCore,
    entry_hash: hashRecoveryValue(entryCore),
  };
}

function isUnresolvedFrontierUnit(unit) {
  if (unit.split) return false;
  if (['succeeded', 'skipped'].includes(unit.terminal) && unit.recorded) return false;
  return (
    unit.started
    || unit.prepared
    || unit.committing
    || unit.blocked
    || unit.terminal !== null
    || unit.active_operation !== null
    || unit.recovery.attempts.length > 0
    || unit.recovery.outcomes.length > 0
    || unit.recovery.retry
    || unit.recovery.commit
  );
}

function actionSteps(entry, shared) {
  const common = {
    unit_id: entry.unit_id,
    attempt_id: entry.attempt_id,
    operation_id: entry.operation_id,
    policy_version: RECOVERY_POLICY_VERSION,
    evidence: entry.evidence,
    decision: entry.decision,
    ...(entry.budget ? { budget: entry.budget } : {}),
    ...(entry.effect_verification
      ? { effect_verification: entry.effect_verification }
      : {}),
    migration_id: shared.migration_id,
    manifest_hash: shared.manifest_hash,
    fence_seq: shared.fence_seq,
    entry_hash: entry.entry_hash,
  };
  const steps = [];
  if (entry.start_attempt) {
    steps.push({
      type: 'unit_attempt_started',
      payload: {
        ...common,
        attempt_number: entry.current_attempt_number,
      },
    });
  }
  steps.push({ type: 'unit_outcome_observed', payload: common });
  const action = entry.decision.action;
  if (action === 'skipped') {
    steps.push({
      type: 'unit_resolution',
      payload: { ...common, status: 'skipped' },
    });
    steps.push({
      type: 'unit_recorded',
      payload: { ...common },
    });
  } else if (action === 'isolate') {
    steps.push({ type: 'unit_isolated', payload: common });
  } else if (action === 'reconcile') {
    steps.push({ type: 'unit_reconciliation_requested', payload: common });
  } else if (action === 'resume_commit' || action === 'reconcile_commit') {
    steps.push({ type: 'unit_commit_resumed', payload: common });
  } else if (action === 'replay') {
    steps.push({
      type: 'unit_effect_committed',
      payload: {
        ...common,
        receipt_key: entry.evidence.receiptKey,
        receipt_version: entry.evidence.receiptVersion,
        effect_hash: entry.evidence.effectHash,
      },
    });
    steps.push({
      type: 'unit_resolution',
      payload: { ...common, status: 'succeeded' },
    });
    steps.push({
      type: 'unit_recorded',
      payload: { ...common },
    });
  } else if (action === 'retry') {
    const attemptsUsed = Number(entry.budget?.attemptsUsed || 0) + 1;
    steps.push({
      type: 'unit_retry_scheduled',
      payload: {
        ...common,
        attempts_used: attemptsUsed,
        max_attempts: entry.budget.maxAttempts,
        attempt_number: entry.current_attempt_number + 1,
        retry_at: entry.evidence.retryHint?.notBefore || '1970-01-01T00:00:00.000Z',
      },
    });
  } else if (action === 'block_run') {
    steps.push({
      type: 'run_blocked',
      payload: {
        ...common,
        code: entry.decision.code || 'unsupported_recovery_contract',
      },
    });
  } else {
    throw new Error(`recovery_migration_action_unsupported:${action}`);
  }
  return steps;
}

function withStepMetadata(steps, manifest) {
  let expectedSeq = manifest.journal_seq + 1;
  return steps.map((step, index) => {
    const stepCore = {
      index,
      expected_seq: expectedSeq++,
      type: step.type,
      payload: {
        ...step.payload,
        expected_seq: expectedSeq - 1,
      },
    };
    return { ...stepCore, step_hash: hashRecoveryValue(stepCore) };
  });
}

export function buildRecoveryMigrationManifest({
  runId,
  stage,
  events,
  safeEvidenceByUnit,
  originalContractVersion,
  targetContractVersion,
  originalPolicyVersion,
  targetPolicyVersion,
  upgradeAt,
  authorizedAt,
  authorizationSourceType,
  recoveryPolicyHash = RECOVERY_POLICY_HASH,
  toolVersion = RECOVERY_MIGRATION_TOOL_VERSION,
}) {
  if (toolVersion !== RECOVERY_MIGRATION_TOOL_VERSION) {
    throw new Error('recovery_migration_tool_version_unsupported');
  }
  if (
    targetContractVersion !== RECOVERY_POLICY_VERSION
    || targetPolicyVersion !== RECOVERY_POLICY_VERSION
    || recoveryPolicyHash !== RECOVERY_POLICY_HASH
  ) {
    throw new Error('recovery_migration_contract_unsupported');
  }
  if (
    typeof originalContractVersion !== 'string'
    || !originalContractVersion
    || typeof originalPolicyVersion !== 'string'
    || !originalPolicyVersion
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(
      String(upgradeAt || ''),
    )
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(
      String(authorizedAt || ''),
    )
    || !RECOVERY_MIGRATION_AUTHORIZATION_SOURCE_TYPES.includes(
      authorizationSourceType,
    )
  ) {
    throw new Error('recovery_migration_authorization_metadata_invalid');
  }
  const reduced = reduceRecoveryJournal(events);
  const entries = [...reduced.units.values()]
    .filter(isUnresolvedFrontierUnit)
    .map((unit) => migrationEntry(unit, safeEvidenceByUnit?.[unit.unit_id], stage))
    .sort((left, right) => (
      left.unit_id.localeCompare(right.unit_id, 'en')
      || left.entry_hash.localeCompare(right.entry_hash, 'en')
    ));
  const journalSeq = events.at(-1)?.seq ?? -1;
  const inputSummaryHash = hashRecoveryValue(events);
  const frontierHash = hashRecoveryValue(entries);
  const evidenceProvenanceState = entries.some(
    (entry) => entry.adapter_provenance.source_type === 'caller_json_preview',
  )
    ? 'independent_verification_required'
    : 'journal_verified';
  const migrationId = `xmig_${hashRecoveryValue({
    runId,
    stage,
    journalSeq,
    inputSummaryHash,
    frontierHash,
    originalContractVersion,
    targetContractVersion,
    originalPolicyVersion,
    targetPolicyVersion,
    recoveryPolicyHash,
    toolVersion,
    upgradeAt,
    authorizedAt,
    authorizationSourceType,
  }).slice(0, 32)}`;
  const core = {
    schema_version: RECOVERY_MIGRATION_SCHEMA_VERSION,
    migration_id: migrationId,
    run_id: runId,
    stage,
    original_contract_version: originalContractVersion,
    target_contract_version: targetContractVersion,
    recovery_contract_version: targetContractVersion,
    original_policy_version: originalPolicyVersion,
    target_policy_version: targetPolicyVersion,
    recovery_policy_hash: recoveryPolicyHash,
    new_policy_hash: recoveryPolicyHash,
    tool_version: toolVersion,
    journal_seq: journalSeq,
    fence_expected_journal_seq: journalSeq,
    fence_seq: journalSeq + 1,
    frontier_count: entries.length,
    input_summary_hash: inputSummaryHash,
    preview_summary_hash: inputSummaryHash,
    frontier_hash: frontierHash,
    evidence_provenance_state: evidenceProvenanceState,
    upgrade_at: upgradeAt,
    authorized_at: authorizedAt,
    authorization_source_type: authorizationSourceType,
    entries,
  };
  const manifestHash = hashRecoveryValue(core);
  const shared = {
    migration_id: migrationId,
    manifest_hash: manifestHash,
    fence_seq: journalSeq + 1,
  };
  const rawSteps = [{
    type: 'stage_recovery_migration_started',
    payload: {
      ...shared,
      frontier_count: entries.length,
      frontier_hash: frontierHash,
      input_summary_hash: inputSummaryHash,
      evidence_provenance_state: evidenceProvenanceState,
      original_contract_version: originalContractVersion,
      target_contract_version: targetContractVersion,
      original_policy_version: originalPolicyVersion,
      target_policy_version: targetPolicyVersion,
      new_policy_hash: recoveryPolicyHash,
      tool_version: toolVersion,
      upgrade_at: upgradeAt,
      authorized_at: authorizedAt,
      authorization_source_type: authorizationSourceType,
    },
  }];
  for (const entry of entries) rawSteps.push(...actionSteps(entry, shared));
  rawSteps.push({
    type: 'stage_recovery_migration_completed',
    payload: {
      ...shared,
      frontier_count: entries.length,
      frontier_hash: frontierHash,
      actual_processed_count: entries.length,
      cumulative_entry_hash: hashRecoveryValue(
        entries.map((entry) => entry.entry_hash),
      ),
      cumulative_step_hash: hashRecoveryValue(rawSteps),
    },
  });
  const manifest = {
    ...core,
    manifest_hash: manifestHash,
    steps: [],
  };
  manifest.steps = withStepMetadata(rawSteps, manifest);
  return validateRecoveryMigrationManifest(manifest, journalSeq + 1);
}

function assertOfflineProof(proof) {
  if (
    proof?.oldRunnerAbsent !== true
    || proof?.writerLockAbsent !== true
    || proof?.otherWritersAbsent !== true
  ) {
    throw new Error('recovery_migration_offline_writer_proof_required');
  }
}

function journalOutcomeMatchesEntry(events, entry) {
  const provenance = entry.adapter_provenance;
  const event = events.find((candidate) => (
    candidate.seq === provenance.outcome_seq
    && candidate.type === 'unit_outcome_observed'
  ));
  const payload = event?.payload;
  return (
    payload?.unit_id === entry.unit_id
    && payload?.attempt_id === entry.attempt_id
    && payload?.operation_id === entry.operation_id
    && hashRecoveryValue(payload?.evidence) === entry.evidence_hash
    && hashRecoveryValue(payload?.budget ?? null)
      === hashRecoveryValue(entry.budget ?? null)
    && hashRecoveryValue(payload?.decision) === hashRecoveryValue(entry.decision)
    && (payload?.effect_verification ?? null)
      === (entry.effect_verification ?? null)
  );
}

async function assertFenceEvidenceProvenance({
  manifest,
  events,
  verifyEvidenceProvenance,
}) {
  const externalEntries = [];
  for (const entry of manifest.entries) {
    const provenance = entry.adapter_provenance;
    if (provenance.source_type === 'journal_outcome') {
      if (!journalOutcomeMatchesEntry(events, entry)) {
        throw new Error(
          `recovery_migration_journal_evidence_drifted:${entry.unit_id}`,
        );
      }
      continue;
    }
    externalEntries.push({
      unit_id: entry.unit_id,
      entry_hash: entry.entry_hash,
      adapter: provenance.adapter,
      safe_fact_hash: provenance.safe_fact_hash,
    });
  }
  if (externalEntries.length === 0) return;
  const request = canonicalRecoveryValue({
    run_id: manifest.run_id,
    stage: manifest.stage,
    journal_seq: manifest.journal_seq,
    input_summary_hash: manifest.input_summary_hash,
    units: externalEntries.map((entry) => entry.unit_id),
  });
  const proof = await verifyEvidenceProvenance?.(request);
  if (proof?.source_type !== 'trusted_read_only_collector') {
    throw new Error('recovery_migration_fence_evidence_provenance_unverified');
  }
  const expectedUnits = externalEntries
    .map((entry) => entry.unit_id)
    .sort((left, right) => left.localeCompare(right, 'en'));
  const suppliedUnits = Object.keys(proof.safeEvidenceByUnit || {})
    .sort((left, right) => left.localeCompare(right, 'en'));
  if (JSON.stringify(expectedUnits) !== JSON.stringify(suppliedUnits)) {
    throw new Error('recovery_migration_fence_evidence_provenance_unverified');
  }
  const legacyLessonZeroEffectEntries = manifest.entries.filter((entry) => (
    entry.adapter_provenance.source_type === 'caller_json_preview'
    && entry.evidence?.proof?.kind === 'legacy_lessons_zero_effect'
  ));
  if (legacyLessonZeroEffectEntries.length > 0) {
    const collector = proof.collector_provenance;
    if (
      collector?.schema !== 'legacy-lesson-safe-facts-provenance/v1'
      || !/^[0-9a-f]{64}$/.test(String(collector.snapshot_hash || ''))
      || !/^[0-9a-f]{64}$/.test(String(collector.engine_hash || ''))
      || legacyLessonZeroEffectEntries.some((entry) => {
        const collection = proof.safeEvidenceByUnit?.[entry.unit_id]
          ?.safe_facts?.collection;
        return (
          collection?.schema !== 'legacy-lesson-safe-facts-collection/v1'
          || collection.snapshot_hash !== collector.snapshot_hash
          || collection.engine_hash !== collector.engine_hash
          || !/^[0-9a-f]{64}$/.test(String(collection.state_tree_hash || ''))
          || !/^[0-9a-f]{64}$/.test(
            String(collection.journal_input_summary_hash || ''),
          )
          || !Array.isArray(collection.scope_proofs)
          || collection.scope_proofs.length < 6
        );
      })
    ) {
      throw new Error('recovery_migration_fence_evidence_provenance_unverified');
    }
  }
  let rebuilt;
  try {
    rebuilt = buildRecoveryMigrationManifest({
      runId: manifest.run_id,
      stage: manifest.stage,
      events,
      safeEvidenceByUnit: proof.safeEvidenceByUnit,
      originalContractVersion: manifest.original_contract_version,
      targetContractVersion: manifest.target_contract_version,
      originalPolicyVersion: manifest.original_policy_version,
      targetPolicyVersion: manifest.target_policy_version,
      upgradeAt: manifest.upgrade_at,
      authorizedAt: manifest.authorized_at,
      authorizationSourceType: manifest.authorization_source_type,
      recoveryPolicyHash: manifest.recovery_policy_hash,
      toolVersion: manifest.tool_version,
    });
  } catch {
    throw new Error('recovery_migration_fence_evidence_provenance_unverified');
  }
  if (rebuilt.manifest_hash !== manifest.manifest_hash) {
    throw new Error('recovery_migration_fence_evidence_provenance_unverified');
  }
}

export async function appendRecoveryContractFence({
  journal,
  stage,
  manifest,
  verifyOfflineWritersAbsent,
  verifyEvidenceProvenance,
}) {
  validateRecoveryMigrationManifest(manifest, manifest.journal_seq + 1);
  if (manifest.stage !== stage || manifest.run_id !== journal.runId) {
    throw new Error('recovery_migration_manifest_identity_mismatch');
  }
  const lockExists = await fs.access(journal.lockPath).then(
    () => true,
    (error) => error?.code === 'ENOENT' ? false : Promise.reject(error),
  );
  if (lockExists) throw new Error('recovery_migration_writer_lock_present');
  const proof = await verifyOfflineWritersAbsent?.({
    runId: journal.runId,
    stage,
    expectedSeq: manifest.journal_seq,
  });
  assertOfflineProof(proof);
  await journal.acquireLock();
  try {
    const current = await journal.readStage(stage);
    if (
      (current.at(-1)?.seq ?? -1) !== manifest.journal_seq
      || hashRecoveryValue(current) !== manifest.input_summary_hash
    ) {
      throw new Error('recovery_migration_input_drifted');
    }
    await assertFenceEvidenceProvenance({
      manifest,
      events: current,
      verifyEvidenceProvenance,
    });
    return journal.appendStageExpectedSeq(
      stage,
      manifest.journal_seq,
      'stage_recovery_contract_fenced',
      manifest,
    );
  } finally {
    await journal.releaseLock();
  }
}

export async function resumeRecoveryMigration({ journal, stage }) {
  await journal.acquireLock();
  try {
    let events = await journal.readStage(stage);
    const gate = inspectRecoveryMigrationGate(events);
    if (gate.state === 'open') throw new Error('recovery_migration_fence_missing');
    const legacyPrefix = events.slice(0, gate.manifest.journal_seq + 1);
    if (hashRecoveryValue(legacyPrefix) !== gate.manifest.input_summary_hash) {
      throw new Error('recovery_migration_input_summary_drifted');
    }
    for (let index = gate.completedSteps; index < gate.manifest.steps.length; index += 1) {
      const step = gate.manifest.steps[index];
      await journal.appendStageExpectedSeq(
        stage,
        step.expected_seq,
        step.type,
        step.payload,
      );
      events = [...events, { seq: step.expected_seq + 1, type: step.type, payload: step.payload }];
    }
    const completed = inspectRecoveryMigrationGate(await journal.readStage(stage));
    if (completed.state !== 'migrated') {
      throw new Error('recovery_migration_incomplete');
    }
    reduceRecoveryJournal(await journal.readStage(stage));
    return {
      migration_id: completed.manifest.migration_id,
      manifest_hash: completed.manifest.manifest_hash,
      appended_steps: completed.manifest.steps.length - gate.completedSteps,
      completed_steps: completed.manifest.steps.length,
    };
  } finally {
    await journal.releaseLock();
  }
}

export async function readSafeMigrationInput(inputPath) {
  const absolute = path.resolve(inputPath);
  const parsed = JSON.parse(await fs.readFile(absolute, 'utf8'));
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('recovery_migration_input_invalid');
  }
  return canonicalRecoveryValue(parsed);
}
