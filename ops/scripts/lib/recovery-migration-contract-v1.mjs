import { createHash } from 'node:crypto';
import {
  RECOVERY_POLICY_VERSION,
  isRecoveryPolicyReadCompatible,
} from './recovery-policy-v1.mjs';

export const RECOVERY_MIGRATION_SCHEMA_VERSION = 1;
export const RECOVERY_MIGRATION_TOOL_VERSION = '1.0.0';
export const RECOVERY_MIGRATION_AUTHORIZATION_SOURCE_TYPES = Object.freeze([
  'user_approval',
  'change_ticket',
  'incident_authorization',
]);

const CONTRACT_VERSION = /^[a-z0-9][a-z0-9_.:/-]{0,127}$/;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function canonicalRecoveryValue(value) {
  if (Array.isArray(value)) return value.map(canonicalRecoveryValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort((left, right) => left.localeCompare(right, 'en'))
        .map((key) => [key, canonicalRecoveryValue(value[key])]),
    );
  }
  return value;
}

export function hashRecoveryValue(value) {
  return createHash('sha256')
    .update(JSON.stringify(canonicalRecoveryValue(value)))
    .digest('hex');
}

function assertHash(name, value) {
  if (!/^[0-9a-f]{64}$/.test(String(value || ''))) {
    throw new Error(`recovery_migration_${name}_invalid`);
  }
}

function manifestCore(manifest) {
  const { manifest_hash: _manifestHash, steps: _steps, ...core } = manifest;
  return core;
}

export function validateRecoveryMigrationManifest(manifest, fenceSeq = null) {
  if (
    !manifest
    || manifest.schema_version !== RECOVERY_MIGRATION_SCHEMA_VERSION
    || !/^xmig_[0-9a-f]{32}$/.test(String(manifest.migration_id || ''))
    || typeof manifest.run_id !== 'string'
    || !manifest.run_id
    || typeof manifest.stage !== 'string'
    || !manifest.stage
    || !CONTRACT_VERSION.test(String(manifest.original_contract_version || ''))
    || manifest.target_contract_version !== RECOVERY_POLICY_VERSION
    || manifest.recovery_contract_version !== RECOVERY_POLICY_VERSION
    || !CONTRACT_VERSION.test(String(manifest.original_policy_version || ''))
    || manifest.target_policy_version !== RECOVERY_POLICY_VERSION
    || manifest.recovery_policy_hash !== manifest.new_policy_hash
    || !isRecoveryPolicyReadCompatible(
      manifest.target_policy_version,
      manifest.recovery_policy_hash,
    )
    || manifest.tool_version !== RECOVERY_MIGRATION_TOOL_VERSION
    || !Number.isSafeInteger(manifest.journal_seq)
    || manifest.journal_seq < -1
    || manifest.fence_expected_journal_seq !== manifest.journal_seq
    || manifest.fence_seq !== manifest.journal_seq + 1
    || !ISO_TIMESTAMP.test(String(manifest.upgrade_at || ''))
    || !ISO_TIMESTAMP.test(String(manifest.authorized_at || ''))
    || !RECOVERY_MIGRATION_AUTHORIZATION_SOURCE_TYPES.includes(
      manifest.authorization_source_type,
    )
    || !Number.isSafeInteger(manifest.frontier_count)
    || manifest.frontier_count < 0
    || manifest.preview_summary_hash !== manifest.input_summary_hash
    || !Array.isArray(manifest.entries)
    || manifest.entries.length !== manifest.frontier_count
    || !Array.isArray(manifest.steps)
    || manifest.steps.length < 2
  ) {
    throw new Error('recovery_migration_manifest_invalid');
  }
  if (fenceSeq !== null && manifest.journal_seq !== fenceSeq - 1) {
    throw new Error('recovery_migration_fence_seq_invalid');
  }
  assertHash('input_summary_hash', manifest.input_summary_hash);
  assertHash('frontier_hash', manifest.frontier_hash);
  assertHash('manifest_hash', manifest.manifest_hash);
  if (hashRecoveryValue(manifest.entries) !== manifest.frontier_hash) {
    throw new Error('recovery_migration_frontier_hash_mismatch');
  }
  if (hashRecoveryValue(manifestCore(manifest)) !== manifest.manifest_hash) {
    throw new Error('recovery_migration_manifest_hash_mismatch');
  }
  const sortedEntries = [...manifest.entries].sort((left, right) => (
    String(left.unit_id).localeCompare(String(right.unit_id), 'en')
    || String(left.entry_hash).localeCompare(String(right.entry_hash), 'en')
  ));
  if (JSON.stringify(sortedEntries) !== JSON.stringify(manifest.entries)) {
    throw new Error('recovery_migration_frontier_order_invalid');
  }
  for (const entry of manifest.entries) {
    assertHash('entry_hash', entry.entry_hash);
    const provenance = entry.adapter_provenance;
    const journalProvenance = (
      provenance?.source_type === 'journal_outcome'
      && provenance.adapter === 'recovery-journal-outcome/v1'
      && Number.isSafeInteger(provenance.outcome_seq)
      && provenance.outcome_seq >= 0
    );
    const callerPreviewProvenance = (
      provenance?.source_type === 'caller_json_preview'
      && typeof provenance.adapter === 'string'
      && /^[a-z][a-z0-9_-]*\/legacy-safe-facts-v1$/.test(provenance.adapter)
      && /^[0-9a-f]{64}$/.test(String(provenance.safe_fact_hash || ''))
    );
    if (!journalProvenance && !callerPreviewProvenance) {
      throw new Error('recovery_migration_entry_provenance_invalid');
    }
    const { entry_hash: _entryHash, ...entryCore } = entry;
    if (hashRecoveryValue(entryCore) !== entry.entry_hash) {
      throw new Error('recovery_migration_entry_hash_mismatch');
    }
  }
  const expectedProvenanceState = manifest.entries.some(
    (entry) => entry.adapter_provenance.source_type === 'caller_json_preview',
  )
    ? 'independent_verification_required'
    : 'journal_verified';
  if (manifest.evidence_provenance_state !== expectedProvenanceState) {
    throw new Error('recovery_migration_evidence_provenance_state_invalid');
  }
  let expectedSeq = manifest.journal_seq + 1;
  for (let index = 0; index < manifest.steps.length; index += 1) {
    const step = manifest.steps[index];
    if (
      step.index !== index
      || step.expected_seq !== expectedSeq
      || typeof step.type !== 'string'
      || !step.type
      || !step.payload
      || step.payload.migration_id !== manifest.migration_id
      || step.payload.manifest_hash !== manifest.manifest_hash
      || step.payload.fence_seq !== manifest.journal_seq + 1
      || step.payload.expected_seq !== expectedSeq
    ) {
      throw new Error('recovery_migration_step_invalid');
    }
    const { step_hash: _stepHash, ...stepCore } = step;
    assertHash('step_hash', step.step_hash);
    if (hashRecoveryValue(stepCore) !== step.step_hash) {
      throw new Error('recovery_migration_step_hash_mismatch');
    }
    expectedSeq += 1;
  }
  if (
    manifest.steps[0].type !== 'stage_recovery_migration_started'
    || manifest.steps.at(-1).type !== 'stage_recovery_migration_completed'
  ) {
    throw new Error('recovery_migration_boundary_steps_invalid');
  }
  const started = manifest.steps[0].payload;
  if (
    started.original_contract_version !== manifest.original_contract_version
    || started.target_contract_version !== manifest.target_contract_version
    || started.original_policy_version !== manifest.original_policy_version
    || started.target_policy_version !== manifest.target_policy_version
    || started.new_policy_hash !== manifest.new_policy_hash
    || started.tool_version !== manifest.tool_version
    || started.upgrade_at !== manifest.upgrade_at
    || started.authorized_at !== manifest.authorized_at
    || started.authorization_source_type !== manifest.authorization_source_type
    || started.input_summary_hash !== manifest.input_summary_hash
    || started.evidence_provenance_state !== manifest.evidence_provenance_state
  ) {
    throw new Error('recovery_migration_started_metadata_mismatch');
  }
  const completed = manifest.steps.at(-1).payload;
  if (
    completed.actual_processed_count !== manifest.frontier_count
    || completed.cumulative_entry_hash !== hashRecoveryValue(
      manifest.entries.map((entry) => entry.entry_hash),
    )
  ) {
    throw new Error('recovery_migration_completed_count_or_hash_mismatch');
  }
  return manifest;
}

export function inspectRecoveryMigrationGate(events) {
  const fences = events.filter((event) => event.type === 'stage_recovery_contract_fenced');
  if (fences.length === 0) return { state: 'open', manifest: null, completedSteps: 0 };
  if (fences.length !== 1) throw new Error('recovery_migration_duplicate_fence');
  const fence = fences[0];
  const manifest = validateRecoveryMigrationManifest(fence.payload, fence.seq);
  const legacyPrefix = events.slice(0, manifest.journal_seq + 1);
  if (hashRecoveryValue(legacyPrefix) !== manifest.input_summary_hash) {
    throw new Error('recovery_migration_input_summary_mismatch');
  }
  const suffix = events.slice(fence.seq + 1);
  const migrationPrefix = suffix.slice(0, manifest.steps.length);
  for (let index = 0; index < migrationPrefix.length; index += 1) {
    const actual = migrationPrefix[index];
    const expected = manifest.steps[index];
    if (
      actual.seq !== expected.expected_seq + 1
      || actual.type !== expected.type
      || JSON.stringify(canonicalRecoveryValue(actual.payload))
        !== JSON.stringify(canonicalRecoveryValue(expected.payload))
    ) {
      throw new Error(`recovery_migration_step_mismatch_at_${index}`);
    }
  }
  return {
    state: migrationPrefix.length === manifest.steps.length ? 'migrated' : 'fenced',
    manifest,
    completedSteps: migrationPrefix.length,
  };
}

export function recoveryMigrationStepForEvent(event, gate) {
  if (!gate?.manifest || !Number.isSafeInteger(event?.seq)) return null;
  const fenceSeq = gate.manifest.journal_seq + 1;
  const index = event.seq - fenceSeq - 1;
  if (!Number.isSafeInteger(index) || index < 0 || index >= gate.manifest.steps.length) {
    return null;
  }
  const expected = gate.manifest.steps[index];
  if (
    event.type !== expected.type
    || event.seq !== expected.expected_seq + 1
    || JSON.stringify(canonicalRecoveryValue(event.payload))
      !== JSON.stringify(canonicalRecoveryValue(expected.payload))
  ) {
    return null;
  }
  return expected;
}

export function isAuthenticatedLegacyRecordedTerminal(unit, gate) {
  return (
    gate?.state === 'migrated'
    && unit?.recorded === true
    && Number.isSafeInteger(unit.recorded_seq)
    && unit.recorded_seq <= gate.manifest.journal_seq
    && Number.isSafeInteger(unit.terminal_seq)
    && unit.terminal_seq <= gate.manifest.journal_seq
    && ['succeeded', 'skipped'].includes(unit.terminal)
  );
}

export function isSupersededLegacyVerifierBlock(event, units, gate) {
  const payload = event?.payload;
  const migrationLastSeq = gate?.manifest
    ? gate.manifest.fence_seq + gate.manifest.steps.length
    : -1;
  const unit = units?.get(payload?.blocked_unit_id);
  return (
    event?.type === 'run_blocked'
    && gate?.state === 'migrated'
    && event.seq > migrationLastSeq
    && payload?.code === 'receipt_integrity_error'
    && payload?.stage === gate.manifest.stage
    && payload?.reason === 'recovered_terminal_verifier_required'
    && isAuthenticatedLegacyRecordedTerminal(unit, gate)
  );
}

export function assertRecoveryMigrationPrivileges(events, gate) {
  const tagged = events.filter((event) => (
    typeof event.payload?.migration_id === 'string'
  ));
  if (gate.state === 'open') {
    if (tagged.length > 0) throw new Error('recovery_migration_privilege_without_fence');
    return;
  }
  const fenceSeq = gate.manifest.journal_seq + 1;
  for (const event of tagged) {
    if (event.seq < fenceSeq) {
      throw new Error('recovery_migration_privilege_before_fence');
    }
    if (
      event.seq === fenceSeq
      && event.type === 'stage_recovery_contract_fenced'
      && event.payload === gate.manifest
    ) {
      continue;
    }
    if (!recoveryMigrationStepForEvent(event, gate)) {
      throw new Error('recovery_migration_privilege_outside_manifest');
    }
  }
}

export function assertLegacyRecoveryContractCompatible(events) {
  const fence = events.find((event) => event.type === 'stage_recovery_contract_fenced');
  if (fence) {
    throw new Error(
      `legacy_runner_recovery_contract_fenced_at_seq_${fence.seq}:upgrade_required`,
    );
  }
}
