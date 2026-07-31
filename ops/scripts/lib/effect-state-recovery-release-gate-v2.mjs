import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  PINNED_III_ENGINE_SHA256,
  PINNED_III_ENGINE_VERSION,
} from './iii-state-read-only-adapter-v1.mjs';
import {
  EFFECT_STATE_RECOVERY_STAGES,
} from './effect-state-recovery-stage-catalog-v1.mjs';

export {
  EFFECT_STATE_RECOVERY_STAGES,
} from './effect-state-recovery-stage-catalog-v1.mjs';

const execFileAsync = promisify(execFile);
const PROOF_SCHEMA = 'effect-state-recovery-release-proof/v2';
const EVIDENCE_RUNNERS = Object.freeze([
  'node',
  'node-subprocess',
  'vitest',
  'vitest-real-iii',
]);

function obligation(id, layer, appliesTo) {
  return Object.freeze({
    id,
    layer,
    applies_to: Object.freeze([...appliesTo]),
  });
}

const allStages = EFFECT_STATE_RECOVERY_STAGES;
const protocolObligations = [
  'not_dispatched_can_retry',
  'unknown_response_requires_receipt_query',
  'running_receipt_prevents_redispatch',
  'succeeded_receipt_replays_without_effect',
  'exact_absence_authorizes_one_fresh_retry',
  'absence_retry_is_bounded',
  'input_hash_drift_fails_before_effect',
  'receipt_identity_tamper_fails_closed',
  'duplicate_request_has_single_effect',
  'duplicate_response_is_idempotent',
  'out_of_order_response_is_rejected',
  'late_original_and_fresh_retry_have_single_effect',
  'receipt_ahead_of_journal_catches_up',
  'unknown_error_fails_closed',
].map((risk) => obligation(`protocol::${risk}`, 'shared_protocol', allStages));

const storageObligations = [
  'append_failure_preserves_last_durable_state',
  'sync_uncertainty_fails_closed',
  'torn_tail_only_repair',
  'checksum_or_sequence_corruption_rejected',
  'writer_identity_conflict_rejected',
].map((risk) => obligation(`storage::${risk}`, 'shared_storage', allStages));

const stageObligations = EFFECT_STATE_RECOVERY_STAGES.flatMap((stage) => [
  obligation(
    `stage::${stage}::complete_persisted_fact_rebuilds_receipt`,
    'stage_contract',
    [stage],
  ),
  obligation(
    `stage::${stage}::missing_conflicting_or_partial_fact_fails_closed`,
    'stage_contract',
    [stage],
  ),
]);

const runtimeObligations = EFFECT_STATE_RECOVERY_STAGES.map((stage) =>
  obligation(
    `runtime::${stage}::post_effect_response_loss_recovers`,
    'real_iii',
    [stage],
  ));

const stateMachineObligations = [
  'idempotent_recovery_action',
  'committed_state_is_monotonic',
  'unknown_never_becomes_retry_without_closed_proof',
  'no_effect_requires_closed_proof',
  'independent_units_continue_after_permanent_failure',
  'dependent_units_block_after_upstream_isolation',
  'reducer_and_safe_projection_are_deterministic',
  'retry_budget_survives_restart',
  'fixed_seed_crash_positions_match_baseline_or_block',
].map((risk) =>
  obligation(`state_machine::${risk}`, 'state_machine', allStages));

const integrationFamilies = Object.freeze([
  Object.freeze({
    id: 'summary_custom',
    stages: Object.freeze(['summary']),
  }),
  Object.freeze({
    id: 'lessons_custom',
    stages: Object.freeze(['lessons']),
  }),
  Object.freeze({
    id: 'two_phase_prepare_commit',
    stages: Object.freeze(['memory_consolidate', 'skill_extract']),
  }),
  Object.freeze({
    id: 'generic_single',
    stages: Object.freeze([
      'semantic_rollup',
      'crystal',
      'consolidation_procedural',
      'reflect_insight',
    ]),
  }),
]);

const integrationObligations = integrationFamilies.flatMap((family) => [
  obligation(
    `integration::${family.id}::receipt_protocol_conformance`,
    'integration_family',
    family.stages,
  ),
  obligation(
    `integration::${family.id}::provider_boundaries_fail_closed`,
    'integration_family',
    family.stages,
  ),
  obligation(
    `integration::${family.id}::persisted_progress_resumes_without_duplicate_effect`,
    'integration_family',
    family.stages,
  ),
]);

const migrationObligations = [
  ...[
    'legacy_fence_makes_old_runner_refuse',
    'new_runner_blocks_business_until_migration_complete',
    'migration_reenters_after_each_append_boundary',
    'migration_input_drift_rejects_append',
    'only_unresolved_frontier_is_migrated',
    'legacy_events_receipts_and_business_records_are_not_rewritten',
    'per_stage_legacy_evidence_adapter_fails_closed',
    'new_reducer_reads_migrated_history',
    'preview_is_deterministic_for_same_input',
  ].map((risk) => obligation(`migration::${risk}`, 'migration', allStages)),
  obligation(
    'migration::lesson_no_blocks_requires_zero_effect_proof',
    'migration',
    ['lessons'],
  ),
];

const lessonsConcurrencyObligations = [
  'manual_mutations_are_serialized_with_extraction',
  'generation_registry_survives_interruption',
  'run_binding_or_watermark_prevents_generation_reuse',
  'candidate_upsert_and_source_removal_replay_as_one_mutation',
  'mutation_or_registry_identity_conflict_fails_closed',
].map((risk) =>
  obligation(`lessons_concurrency::${risk}`, 'lessons_concurrency', [
    'lessons',
  ]));

const projectionObligations = [
  obligation(
    'projection::safe_state_redacts_sensitive_payloads',
    'safe_projection',
    allStages,
  ),
  obligation(
    'projection::status_counts_equal_reducer_output',
    'safe_projection',
    allStages,
  ),
];

const runtimeBoundaryObligations = [
  obligation(
    'runtime_boundary::runner_restart_at_each_journal_boundary',
    'subprocess_runtime',
    allStages,
  ),
  obligation(
    'runtime_boundary::statekv_ack_is_not_durability_proof',
    'real_iii',
    allStages,
  ),
  obligation(
    'runtime_boundary::runtime_exit_at_each_statekv_ack_boundary_recovers_or_requires_exact_reconciliation',
    'real_iii',
    ['lessons'],
  ),
  obligation(
    'runtime_boundary::committed_receipt_missing_formal_watermark_resumes_or_conflicts',
    'real_iii',
    ['lessons'],
  ),
];

export const EFFECT_STATE_RECOVERY_REQUIRED_OBLIGATIONS = Object.freeze([
  ...protocolObligations,
  ...storageObligations,
  ...stateMachineObligations,
  ...integrationObligations,
  ...stageObligations,
  ...runtimeObligations,
  ...migrationObligations,
  ...lessonsConcurrencyObligations,
  ...projectionObligations,
  ...runtimeBoundaryObligations,
]);

function obligationCatalogDigest(obligations) {
  return createHash('sha256')
    .update(
      obligations
        .map(({ id, layer, applies_to: appliesTo }) =>
          `${id}|${layer}|${appliesTo.join(',')}`)
        .join('\n'),
    )
    .digest('hex');
}

export const EFFECT_STATE_RECOVERY_REQUIRED_CATALOG_SHA256 =
  obligationCatalogDigest(EFFECT_STATE_RECOVERY_REQUIRED_OBLIGATIONS);

function mappingEntry(scenario, obligationIds) {
  return Object.freeze({
    scenario,
    obligation_ids: Object.freeze([...obligationIds]),
  });
}

const stageIds = (suffix) =>
  EFFECT_STATE_RECOVERY_STAGES.map((stage) => `stage::${stage}::${suffix}`);
const runtimeIds = (suffix) =>
  EFFECT_STATE_RECOVERY_STAGES.map((stage) => `runtime::${stage}::${suffix}`);
const integrationIds = (suffix) =>
  integrationFamilies.map((family) => `integration::${family.id}::${suffix}`);

export const EFFECT_STATE_RECOVERY_V1_CANONICAL_RISKS = Object.freeze([
  'exit_before_formal_effect',
  'exit_after_formal_effect_before_receipt',
  'exit_after_receipt_before_journal',
  'partial_commit',
  'request_not_dispatched',
  'unknown_response',
  'duplicate_request',
  'duplicate_response',
  'out_of_order_response',
  'unknown_error_code',
  'disk_full',
  'journal_append_failure',
  'journal_sync_failure',
  'manifest_corruption',
  'identity_conflict',
  'fixed_seed_fault_positions',
]);

export const EFFECT_STATE_RECOVERY_V1_CANONICAL_RISKS_SHA256 =
  createHash('sha256')
    .update(EFFECT_STATE_RECOVERY_V1_CANONICAL_RISKS.join('\n'))
    .digest('hex');

export const EFFECT_STATE_RECOVERY_V1_RISK_MAPPING = Object.freeze([
  mappingEntry('exit_before_formal_effect', [
    'protocol::not_dispatched_can_retry',
    ...integrationIds('provider_boundaries_fail_closed'),
  ]),
  mappingEntry('exit_after_formal_effect_before_receipt', [
    ...runtimeIds('post_effect_response_loss_recovers'),
  ]),
  mappingEntry('exit_after_receipt_before_journal', [
    'protocol::receipt_ahead_of_journal_catches_up',
    'runtime_boundary::runner_restart_at_each_journal_boundary',
  ]),
  mappingEntry('partial_commit', [
    ...stageIds('missing_conflicting_or_partial_fact_fails_closed'),
    ...integrationIds('persisted_progress_resumes_without_duplicate_effect'),
  ]),
  mappingEntry('request_not_dispatched', [
    'protocol::not_dispatched_can_retry',
  ]),
  mappingEntry('unknown_response', [
    'protocol::unknown_response_requires_receipt_query',
    'protocol::running_receipt_prevents_redispatch',
    'protocol::succeeded_receipt_replays_without_effect',
  ]),
  mappingEntry('duplicate_request', [
    'protocol::duplicate_request_has_single_effect',
  ]),
  mappingEntry('duplicate_response', [
    'protocol::duplicate_response_is_idempotent',
  ]),
  mappingEntry('out_of_order_response', [
    'protocol::out_of_order_response_is_rejected',
  ]),
  mappingEntry('unknown_error_code', [
    'protocol::unknown_error_fails_closed',
    ...integrationIds('provider_boundaries_fail_closed'),
  ]),
  mappingEntry('disk_full', [
    'storage::append_failure_preserves_last_durable_state',
  ]),
  mappingEntry('journal_append_failure', [
    'storage::append_failure_preserves_last_durable_state',
  ]),
  mappingEntry('journal_sync_failure', [
    'storage::sync_uncertainty_fails_closed',
  ]),
  mappingEntry('manifest_corruption', [
    'storage::checksum_or_sequence_corruption_rejected',
  ]),
  mappingEntry('identity_conflict', [
    'protocol::receipt_identity_tamper_fails_closed',
    ...stageIds('missing_conflicting_or_partial_fact_fails_closed'),
  ]),
  mappingEntry('fixed_seed_fault_positions', [
    'state_machine::fixed_seed_crash_positions_match_baseline_or_block',
  ]),
]);

export function assertCanonicalV1RiskMapping(mapping) {
  if (!Array.isArray(mapping)) {
    throw new Error('effect_state_recovery_release_gate_v1_risk_mapping_invalid');
  }
  const requiredIds = new Set(
    EFFECT_STATE_RECOVERY_REQUIRED_OBLIGATIONS.map(({ id }) => id),
  );
  const scenarios = [];
  for (const entry of mapping) {
    if (
      !isObject(entry)
      || typeof entry.scenario !== 'string'
      || entry.scenario.length === 0
      || !Array.isArray(entry.obligation_ids)
      || entry.obligation_ids.length === 0
      || entry.obligation_ids.some((id) =>
        typeof id !== 'string' || !requiredIds.has(id))
      || new Set(entry.obligation_ids).size !== entry.obligation_ids.length
    ) {
      throw new Error('effect_state_recovery_release_gate_v1_risk_mapping_invalid');
    }
    scenarios.push(entry.scenario);
  }
  if (
    new Set(scenarios).size !== scenarios.length
    || !sameMembers(scenarios, EFFECT_STATE_RECOVERY_V1_CANONICAL_RISKS)
  ) {
    throw new Error('effect_state_recovery_release_gate_v1_risk_mapping_invalid');
  }
}

assertCanonicalV1RiskMapping(EFFECT_STATE_RECOVERY_V1_RISK_MAPPING);

export const EFFECT_STATE_RECOVERY_V1_RISK_MAPPING_SHA256 =
  createHash('sha256')
    .update(
      EFFECT_STATE_RECOVERY_V1_RISK_MAPPING
        .map(({ scenario, obligation_ids: obligationIds }) =>
          `${scenario}|${obligationIds.join(',')}`)
        .join('\n'),
    )
    .digest('hex');

const realIiiEightStageObligationIds = EFFECT_STATE_RECOVERY_STAGES.flatMap(
  (stage) => [
    `stage::${stage}::complete_persisted_fact_rebuilds_receipt`,
    `runtime::${stage}::post_effect_response_loss_recovers`,
  ],
);

function trustedObligationCase(obligationId, ...expectedTestTitles) {
  return Object.freeze({
    obligation_id: obligationId,
    expected_test_titles: Object.freeze(expectedTestTitles),
  });
}

function trustedEvidence(id, testPath, runner, ...obligationCases) {
  return Object.freeze({
    id,
    test_path: testPath,
    runner,
    obligation_cases: Object.freeze(obligationCases),
  });
}

export const EFFECT_STATE_RECOVERY_TRUSTED_EVIDENCE = Object.freeze([
  trustedEvidence(
    'real-iii-eight-stage-after-effect-ack',
    'test/effect-state-recovery-iii-runtime-e2e.test.ts',
    'vitest-real-iii',
    ...realIiiEightStageObligationIds.map((obligationId) => {
        const stage = obligationId.split('::')[1];
        return trustedObligationCase(
          obligationId,
          `recovers after III acknowledged the ${stage} formal business effect`,
        );
      }),
  ),
  trustedEvidence(
    'shared-recoverable-stage-kernel',
    'ops/scripts/lib/recoverable-stage-v2.test.mjs',
    'node',
    trustedObligationCase(
      'protocol::not_dispatched_can_retry',
      'unit_started without operation_started remains a fresh inner dispatch boundary',
    ),
    trustedObligationCase(
      'state_machine::idempotent_recovery_action',
      'single-phase recovery reuses one attempt and only repeats idempotent boundaries',
      'two-phase recovery persists prepare and commit identities at every boundary',
    ),
    trustedObligationCase(
      'state_machine::independent_units_continue_after_permanent_failure',
      'single-phase drains independent work and blocks only actual dependents',
      'two-phase prepare failure drains independent work and blocks only dependents',
      'two-phase commit failure drains independent work and blocks only dependents',
    ),
    trustedObligationCase(
      'state_machine::dependent_units_block_after_upstream_isolation',
      'single-phase drains independent work and blocks only actual dependents',
      'two-phase prepare failure drains independent work and blocks only dependents',
      'two-phase commit failure drains independent work and blocks only dependents',
    ),
    trustedObligationCase(
      'state_machine::fixed_seed_crash_positions_match_baseline_or_block',
      'fixed-seed crash positions match the baseline or fail closed across both recovery modes',
    ),
  ),
  trustedEvidence(
    'remaining-stage-recovery-kernel',
    'ops/scripts/lib/full-extraction-stage-adapters-v2.test.mjs',
    'node',
    ...[
      'receipt_protocol_conformance',
      'provider_boundaries_fail_closed',
      'persisted_progress_resumes_without_duplicate_effect',
    ].flatMap((suffix) => [
      trustedObligationCase(
        `integration::two_phase_prepare_commit::${suffix}`,
        `integration::two_phase_prepare_commit::${suffix}`,
      ),
      trustedObligationCase(
        `integration::generic_single::${suffix}`,
        `integration::generic_single::${suffix}`,
      ),
    ]),
  ),
  trustedEvidence(
    'subprocess-runner-journal-boundaries',
    'ops/scripts/lib/effect-state-recovery-subprocess-v1.test.mjs',
    'node-subprocess',
    trustedObligationCase(
      'runtime_boundary::runner_restart_at_each_journal_boundary',
      'runtime_boundary::runner_restart_at_each_journal_boundary',
    ),
  ),
  trustedEvidence(
    'shared-production-runner-recovery',
    'ops/scripts/run-agentmemory-full-extraction-v2.test.mjs',
    'node',
    trustedObligationCase(
      'protocol::unknown_response_requires_receipt_query',
      'v2 summary keeps an uncontracted 5xx pending and re-verifies the same receipt',
    ),
    trustedObligationCase(
      'protocol::receipt_ahead_of_journal_catches_up',
      'v2 Lessons resumes every committed recovery boundary without repeating Provider work',
    ),
    trustedObligationCase(
      'integration::summary_custom::receipt_protocol_conformance',
      'v2 summary recovery waits when no durable result is visible',
      'v2 summary retries the same identity after exact missing-receipt proof',
      'v2 summary keeps an uncontracted 5xx pending and re-verifies the same receipt',
      'v2 summary waits on a persisted reconciliation failure without redispatching',
    ),
    trustedObligationCase(
      'integration::summary_custom::provider_boundaries_fail_closed',
      'v2 summary does not retry a provider failure without persisted no-effect evidence',
    ),
    trustedObligationCase(
      'integration::summary_custom::persisted_progress_resumes_without_duplicate_effect',
      'v2 summary recovery reconciles one durable chunk before advancing the next chunk',
      'v2 resumes a partial summary plan without duplicating planned units',
    ),
    trustedObligationCase(
      'integration::lessons_custom::receipt_protocol_conformance',
      'v2 lessons recovers every durable boundary with one stable remote operation',
      'v2 lessons waits on reconciliation-required receipts without sealing',
      'v2 lessons retries the same identity after exact missing-receipt proof',
    ),
    trustedObligationCase(
      'integration::lessons_custom::provider_boundaries_fail_closed',
      'v2 lessons keeps safe transient failures pending but seals deterministic failures',
    ),
    trustedObligationCase(
      'integration::lessons_custom::persisted_progress_resumes_without_duplicate_effect',
      'v2 Lessons resumes every committed recovery boundary without repeating Provider work',
    ),
    trustedObligationCase(
      'migration::new_runner_blocks_business_until_migration_complete',
      'new runner refuses business APIs while a fenced migration is incomplete',
    ),
  ),
  trustedEvidence(
    'shared-operation-receipts',
    'test/extraction-operation-receipts.test.ts',
    'vitest',
    trustedObligationCase(
      'protocol::running_receipt_prevents_redispatch',
      'does not re-execute an operation left running across a server crash',
    ),
    trustedObligationCase(
      'protocol::succeeded_receipt_replays_without_effect',
      'returns the cached safe response when the original client lost the response',
    ),
    trustedObligationCase(
      'protocol::exact_absence_authorizes_one_fresh_retry',
      'serializes a delayed original request with an absence-authorized fresh retry',
    ),
    trustedObligationCase(
      'protocol::absence_retry_is_bounded',
      'serializes a delayed original request with an absence-authorized fresh retry',
    ),
    trustedObligationCase(
      'protocol::input_hash_drift_fails_before_effect',
      'rejects service input drift after receipt absence before any effect runs',
    ),
    trustedObligationCase(
      'protocol::duplicate_request_has_single_effect',
      'serializes concurrent calls and executes the same successful operation once',
    ),
    trustedObligationCase(
      'protocol::duplicate_response_is_idempotent',
      'materializes a succeeded receipt only from an explicitly verified missing result',
    ),
    trustedObligationCase(
      'protocol::late_original_and_fresh_retry_have_single_effect',
      'serializes a delayed original request with an absence-authorized fresh retry',
    ),
    trustedObligationCase(
      'state_machine::committed_state_is_monotonic',
      'does not downgrade an uncertain succeeded-receipt write into a retryable failure',
    ),
    trustedObligationCase(
      'protocol::receipt_identity_tamper_fails_closed',
      'fails closed when a persisted receipt identity is tampered',
    ),
    trustedObligationCase(
      'protocol::out_of_order_response_is_rejected',
      'rejects an out-of-order verified response after the receipt is terminal',
    ),
  ),
  trustedEvidence(
    'shared-recovery-policy',
    'ops/scripts/lib/recovery-policy-v1.test.mjs',
    'node',
    trustedObligationCase(
      'protocol::unknown_error_fails_closed',
      'unknown structures and policy versions fail closed',
    ),
    trustedObligationCase(
      'state_machine::no_effect_requires_closed_proof',
      'missing or contradictory no-effect proof always becomes unknown',
    ),
  ),
  trustedEvidence(
    'shared-journal-storage',
    'ops/scripts/lib/run-state-journal-v2.test.mjs',
    'node',
    trustedObligationCase(
      'storage::append_failure_preserves_last_durable_state',
      'v2 journal append failure preserves the exact prior durable prefix',
    ),
    trustedObligationCase(
      'storage::torn_tail_only_repair',
      'v2 journal uses independent zero-based sequences and only repairs a torn final line',
    ),
    trustedObligationCase(
      'storage::checksum_or_sequence_corruption_rejected',
      'v2 journal rejects complete checksum and sequence corruption',
    ),
    trustedObligationCase(
      'storage::writer_identity_conflict_rejected',
      'v2 journal rejects append after the persisted writer identity changes',
    ),
  ),
  trustedEvidence(
    'shared-real-journal-sync-failure',
    'test/lesson-runner-runtime-e2e.test.ts',
    'vitest',
    trustedObligationCase(
      'storage::sync_uncertainty_fails_closed',
      'keeps Journal V2 conservative after a real temporary-file sync failure',
    ),
  ),
  trustedEvidence(
    'shared-journal-reducer',
    'ops/scripts/lib/recovery-journal-reducer-v1.test.mjs',
    'node',
    trustedObligationCase(
      'state_machine::unknown_never_becomes_retry_without_closed_proof',
      'unknown outcome remains coordinating and cannot become retry',
    ),
    trustedObligationCase(
      'state_machine::retry_budget_survives_restart',
      'retry budget and deadline survive reduction until the next immutable attempt',
    ),
  ),
  trustedEvidence(
    'summary-stage-fails-closed',
    'ops/scripts/lib/summary-recovery-adapter-v1.test.mjs',
    'node',
    trustedObligationCase(
      'stage::summary::missing_conflicting_or_partial_fact_fails_closed',
      'Summary adapter rejects the legacy result reference namespace',
      'unproved skipped and infeasible results fail conservatively to coordination',
      'arbitrary response proof fields are not accepted as persisted facts',
      'a mismatched Summary operation identity becomes a run-blocking system fault',
    ),
  ),
  trustedEvidence(
    'lessons-stage-fails-closed',
    'test/lesson-commit-recovery.test.ts',
    'vitest',
    trustedObligationCase(
      'stage::lessons::missing_conflicting_or_partial_fact_fails_closed',
      'classifies receipt corruption, partial effects and formal facts strictly',
    ),
  ),
  trustedEvidence(
    'memory-consolidate-production-endpoint-contracts',
    'test/full-extraction-api.test.ts',
    'vitest',
    trustedObligationCase(
      'integration::two_phase_prepare_commit::receipt_protocol_conformance',
      'replays a v2 memory prepare response with its proposal handle',
      'hard-stops a recovered memory prepare when the receipt is missing',
      'replays a v2 memory commit with an identity distinct from prepare',
    ),
    trustedObligationCase(
      'integration::two_phase_prepare_commit::provider_boundaries_fail_closed',
      'persists and replays a provider failure through the real memory prepare endpoint',
    ),
  ),
  trustedEvidence(
    'memory-consolidate-stage-fails-closed',
    'test/consolidate.test.ts',
    'vitest',
    trustedObligationCase(
      'stage::memory_consolidate::missing_conflicting_or_partial_fact_fails_closed',
      'commits a prepared proposal idempotently with deterministic memory and audit ids',
    ),
    trustedObligationCase(
      'integration::two_phase_prepare_commit::persisted_progress_resumes_without_duplicate_effect',
      're-enters after the intent commit write without duplicating effects',
      're-enters after the parent commit write without duplicating effects',
      're-enters after the memory commit write without duplicating effects',
      're-enters after the audit commit write without duplicating effects',
      're-enters after the proposal commit write without duplicating effects',
    ),
  ),
  trustedEvidence(
    'semantic-rollup-stage-fails-closed',
    'test/semantic-rollup.test.ts',
    'vitest',
    trustedObligationCase(
      'stage::semantic_rollup::missing_conflicting_or_partial_fact_fails_closed',
      'returns closed structured hard failures for formal recovery identity faults',
      'returns a structured hard failure when a committed semantic item conflicts',
      'freezes the provider result in the outer receipt and re-verifies a committed plan item by item',
    ),
    trustedObligationCase(
      'integration::generic_single::receipt_protocol_conformance',
      'freezes the provider result in the outer receipt and re-verifies a committed plan item by item',
      'returns closed structured hard failures for formal recovery identity faults',
    ),
    trustedObligationCase(
      'integration::generic_single::provider_boundaries_fail_closed',
      'leaves a provider-failed recovery receipt running without semantic effects',
    ),
    trustedObligationCase(
      'integration::generic_single::persisted_progress_resumes_without_duplicate_effect',
      'resumes a frozen semantic result collection after a partial write without another provider call',
    ),
  ),
  trustedEvidence(
    'skill-extract-stage-fails-closed',
    'test/skill-extract.test.ts',
    'vitest',
    trustedObligationCase(
      'stage::skill_extract::missing_conflicting_or_partial_fact_fails_closed',
      'ordered prepare and commit reinforces a shared skill once per source session',
    ),
    trustedObligationCase(
      'integration::two_phase_prepare_commit::receipt_protocol_conformance',
      'ordered prepare and commit reinforces a shared skill once per source session',
      'rejects a fresh prepare when source drift changes the absence-bound input hash',
    ),
    trustedObligationCase(
      'integration::two_phase_prepare_commit::provider_boundaries_fail_closed',
      'persists and replays a provider failure without creating skill effects',
    ),
    trustedObligationCase(
      'integration::two_phase_prepare_commit::persisted_progress_resumes_without_duplicate_effect',
      're-enters after the commit intent write without another provider call or reinforcement',
      're-enters after the stable effect hash write without another provider call or reinforcement',
      're-enters after the procedural effect write without another provider call or reinforcement',
      're-enters after the audit effect write without another provider call or reinforcement',
      're-enters after the committed proposal write without another provider call or reinforcement',
    ),
  ),
  trustedEvidence(
    'crystal-stage-fails-closed',
    'test/crystallize.test.ts',
    'vitest',
    trustedObligationCase(
      'stage::crystal::missing_conflicting_or_partial_fact_fails_closed',
      'replays one pinned full-stage operation without repeating provider work',
      'fails closed when a committed crystal conflicts with the frozen plan',
      're-verifies a committed plan and fills missing crystal, lesson, and action effects',
    ),
    trustedObligationCase(
      'integration::generic_single::receipt_protocol_conformance',
      'replays one pinned full-stage operation without repeating provider work',
      'fails closed when a committed crystal conflicts with the frozen plan',
    ),
    trustedObligationCase(
      'integration::generic_single::provider_boundaries_fail_closed',
      'leaves a provider-failed crystal receipt running without formal effects',
    ),
    trustedObligationCase(
      'integration::generic_single::persisted_progress_resumes_without_duplicate_effect',
      'resumes a frozen crystal after a lesson commit failure',
      'persists the frozen recovery plan before effects and resumes without a second provider call',
    ),
  ),
  trustedEvidence(
    'procedural-stage-fails-closed',
    'test/consolidation-pipeline.test.ts',
    'vitest',
    trustedObligationCase(
      'stage::consolidation_procedural::missing_conflicting_or_partial_fact_fails_closed',
      'recovers a frozen procedural commit without another model call or duplicate reinforcement',
      'rejects a committed procedural receipt when a formal effect is missing',
    ),
    trustedObligationCase(
      'integration::generic_single::receipt_protocol_conformance',
      'recovers a frozen procedural commit without another model call or duplicate reinforcement',
      'rejects a committed procedural receipt when a formal effect is missing',
    ),
    trustedObligationCase(
      'integration::generic_single::provider_boundaries_fail_closed',
      'leaves a provider-failed procedural receipt running without formal effects',
    ),
    trustedObligationCase(
      'integration::generic_single::persisted_progress_resumes_without_duplicate_effect',
      'recovers a frozen procedural commit without another model call or duplicate reinforcement',
    ),
  ),
  trustedEvidence(
    'reflect-stage-fails-closed',
    'test/reflect.test.ts',
    'vitest',
    trustedObligationCase(
      'stage::reflect_insight::missing_conflicting_or_partial_fact_fails_closed',
      'recovers a full insight commit without re-calling the model or double-reinforcing',
      'rejects a committed reflect receipt when a formal insight is missing',
    ),
    trustedObligationCase(
      'integration::generic_single::receipt_protocol_conformance',
      'recovers a full insight commit without re-calling the model or double-reinforcing',
      'rejects a committed reflect receipt when a formal insight is missing',
    ),
    trustedObligationCase(
      'integration::generic_single::provider_boundaries_fail_closed',
      'leaves a provider-failed reflect receipt running without insight effects',
    ),
    trustedObligationCase(
      'integration::generic_single::persisted_progress_resumes_without_duplicate_effect',
      'recovers a full insight commit without re-calling the model or double-reinforcing',
    ),
  ),
  trustedEvidence(
    'migration-frontier-contract',
    'ops/scripts/lib/recovery-frontier-migration-v1.test.mjs',
    'node',
    trustedObligationCase(
      'migration::legacy_fence_makes_old_runner_refuse',
      'legacy runner rejects the fence and migration resumes an interrupted manifest append',
    ),
    trustedObligationCase(
      'migration::migration_input_drift_rejects_append',
      'fence uses the formal writer lock and refuses stale preview input',
    ),
    trustedObligationCase(
      'migration::only_unresolved_frontier_is_migrated',
      'preview excludes never-started units, includes retry and committing facts, and derives retry attempt from the journal',
    ),
    trustedObligationCase(
      'migration::new_reducer_reads_migrated_history',
      'legacy runner rejects the fence and migration resumes an interrupted manifest append',
    ),
    trustedObligationCase(
      'migration::preview_is_deterministic_for_same_input',
      'preview is deterministic and orders the unresolved frontier by unit identity',
    ),
    trustedObligationCase(
      'migration::migration_reenters_after_each_append_boundary',
      'migration reenters after every manifest append boundary',
    ),
    trustedObligationCase(
      'migration::legacy_events_receipts_and_business_records_are_not_rewritten',
      'migration appends recovery events without rewriting legacy events receipts or business records',
    ),
    trustedObligationCase(
      'migration::per_stage_legacy_evidence_adapter_fails_closed',
      'all eight legacy stage evidence adapters fail closed on unproved effects',
    ),
    trustedObligationCase(
      'migration::lesson_no_blocks_requires_zero_effect_proof',
      'lesson_no_blocks migration requires and preserves a closed zero-effect proof',
    ),
  ),
  trustedEvidence(
    'lessons-generation-concurrency',
    'test/lesson-extraction-recovery.test.ts',
    'vitest',
    trustedObligationCase(
      'lessons_concurrency::generation_registry_survives_interruption',
      'keeps the allocated generation across registry and run-binding response losses',
    ),
    trustedObligationCase(
      'lessons_concurrency::mutation_or_registry_identity_conflict_fails_closed',
      'fails closed on mutation and registry identity conflicts',
    ),
    trustedObligationCase(
      'lessons_concurrency::run_binding_or_watermark_prevents_generation_reuse',
      'serializes run binding with watermark commits so a generation is never reused',
      'rejects an old watermark commit after the generation was bound to another run',
    ),
  ),
  trustedEvidence(
    'lessons-mutation-concurrency',
    'test/lesson-commit.test.ts',
    'vitest',
    trustedObligationCase(
      'lessons_concurrency::manual_mutations_are_serialized_with_extraction',
      'preserves the extraction watermark when manual, strengthen, decay and heuristic replacement share a lesson',
    ),
    trustedObligationCase(
      'lessons_concurrency::candidate_upsert_and_source_removal_replay_as_one_mutation',
      'upserts a same-lesson candidate before removing its heuristic source',
    ),
  ),
  trustedEvidence(
    'real-iii-statekv-durability-boundaries',
    'test/lesson-runner-iii-runtime-e2e.test.ts',
    'vitest-real-iii',
    trustedObligationCase(
      'runtime_boundary::statekv_ack_is_not_durability_proof',
      'proves a StateKV acknowledgement is not durability proof',
    ),
    trustedObligationCase(
      'runtime_boundary::runtime_exit_at_each_statekv_ack_boundary_recovers_or_requires_exact_reconciliation',
      'recovers or requests exact reconciliation at every observed StateKV write acknowledgement boundary',
    ),
    trustedObligationCase(
      'runtime_boundary::committed_receipt_missing_formal_watermark_resumes_or_conflicts',
      'resumes a committed receipt with a missing formal watermark without repeating provider or effects',
    ),
  ),
  trustedEvidence(
    'safe-recovery-status-projection',
    'ops/scripts/lib/recovery-status-projection-v1.test.mjs',
    'node',
    trustedObligationCase(
      'projection::safe_state_redacts_sensitive_payloads',
      'safe status and monitor never expose restricted payloads or raw provider errors',
    ),
    trustedObligationCase(
      'projection::status_counts_equal_reducer_output',
      'safe status counts are the exact projection from the unique reducer',
    ),
    trustedObligationCase(
      'state_machine::reducer_and_safe_projection_are_deterministic',
      'reducer and safe projection are deterministic for identical journal input',
    ),
  ),
]);

async function hashFile(filePath) {
  const hash = createHash('sha256');
  const input = fs.createReadStream(filePath);
  for await (const chunk of input) hash.update(chunk);
  return hash.digest('hex');
}

async function assertRegularNonLink(filePath, code) {
  let stat;
  try {
    stat = await fsp.lstat(filePath);
  } catch {
    throw new Error(code);
  }
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(code);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readUniqueStrings(value, code) {
  if (
    !Array.isArray(value)
    || value.some((item) => typeof item !== 'string' || item.length === 0)
    || new Set(value).size !== value.length
  ) {
    throw new Error(code);
  }
  return value;
}

function sameMembers(left, right) {
  return left.length === right.length
    && left.every((item) => right.includes(item));
}

function sameObligation(left, right) {
  return (
    isObject(left)
    && left.id === right.id
    && left.layer === right.layer
    && sameMembers(
      readUniqueStrings(
        left.applies_to,
        'effect_state_recovery_release_gate_proof_requirements_mismatch',
      ),
      right.applies_to,
    )
  );
}

function readObligationCases(value, code) {
  if (!Array.isArray(value) || value.length === 0) throw new Error(code);
  const cases = [];
  const obligationIds = new Set();
  for (const entry of value) {
    if (
      !isObject(entry)
      || typeof entry.obligation_id !== 'string'
      || entry.obligation_id.length === 0
      || obligationIds.has(entry.obligation_id)
    ) {
      throw new Error(code);
    }
    obligationIds.add(entry.obligation_id);
    const expectedTestTitles = readUniqueStrings(
      entry.expected_test_titles,
      code,
    );
    if (expectedTestTitles.length === 0) throw new Error(code);
    cases.push({
      obligation_id: entry.obligation_id,
      expected_test_titles: expectedTestTitles,
    });
  }
  return cases;
}

function sameObligationCases(left, right) {
  if (left.length !== right.length) return false;
  const rightById = new Map(
    right.map((entry) => [entry.obligation_id, entry.expected_test_titles]),
  );
  return left.every((entry) => {
    const expectedTitles = rightById.get(entry.obligation_id);
    return expectedTitles
      && sameMembers(entry.expected_test_titles, expectedTitles);
  });
}

function requiredObligationsById() {
  return new Map(
    EFFECT_STATE_RECOVERY_REQUIRED_OBLIGATIONS.map((item) => [item.id, item]),
  );
}

function assertRunnerCanProveObligations(runner, obligationIds, code) {
  const requiredById = requiredObligationsById();
  for (const obligationId of obligationIds) {
    const required = requiredById.get(obligationId);
    if (
      !required
      || (required.layer === 'real_iii' && runner !== 'vitest-real-iii')
      || (
        required.layer === 'subprocess_runtime'
        && runner !== 'node-subprocess'
      )
    ) {
      throw new Error(code);
    }
  }
}

function trustedEvidenceById(catalog) {
  const requiredById = requiredObligationsById();
  const entries = new Map();
  for (const evidence of catalog) {
    if (
      !isObject(evidence)
      || typeof evidence.id !== 'string'
      || evidence.id.length === 0
      || entries.has(evidence.id)
      || typeof evidence.test_path !== 'string'
      || evidence.test_path.length === 0
      || path.isAbsolute(evidence.test_path)
      || !EVIDENCE_RUNNERS.includes(evidence.runner)
    ) {
      throw new Error('effect_state_recovery_release_gate_trusted_evidence_invalid');
    }
    const obligationCases = readObligationCases(
      evidence.obligation_cases,
      'effect_state_recovery_release_gate_trusted_evidence_invalid',
    );
    const obligationIds = obligationCases.map((entry) => entry.obligation_id);
    if (
      obligationIds.length === 0
      || obligationIds.some((id) => !requiredById.has(id))
    ) {
      throw new Error('effect_state_recovery_release_gate_trusted_evidence_invalid');
    }
    assertRunnerCanProveObligations(
      evidence.runner,
      obligationIds,
      'effect_state_recovery_release_gate_trusted_evidence_invalid',
    );
    entries.set(evidence.id, evidence);
  }
  return entries;
}

function assertManifestRequirements(requirements) {
  if (!isObject(requirements)) {
    throw new Error('effect_state_recovery_release_gate_proof_requirements_mismatch');
  }
  const stages = readUniqueStrings(
    requirements.stages,
    'effect_state_recovery_release_gate_proof_requirements_mismatch',
  );
  if (!sameMembers(stages, EFFECT_STATE_RECOVERY_STAGES)) {
    throw new Error('effect_state_recovery_release_gate_proof_requirements_mismatch');
  }
  if (
    requirements.legacy_v1_risk_mapping_sha256
      !== EFFECT_STATE_RECOVERY_V1_RISK_MAPPING_SHA256
    || requirements.legacy_v1_risk_catalog_sha256
      !== EFFECT_STATE_RECOVERY_V1_CANONICAL_RISKS_SHA256
  ) {
    throw new Error('effect_state_recovery_release_gate_proof_requirements_mismatch');
  }
  if (
    !Array.isArray(requirements.obligations)
    || requirements.obligations.length
      !== EFFECT_STATE_RECOVERY_REQUIRED_OBLIGATIONS.length
  ) {
    throw new Error('effect_state_recovery_release_gate_proof_requirements_mismatch');
  }
  const declaredById = new Map();
  for (const declared of requirements.obligations) {
    if (
      !isObject(declared)
      || typeof declared.id !== 'string'
      || declaredById.has(declared.id)
    ) {
      throw new Error('effect_state_recovery_release_gate_proof_requirements_mismatch');
    }
    declaredById.set(declared.id, declared);
  }
  for (const required of EFFECT_STATE_RECOVERY_REQUIRED_OBLIGATIONS) {
    const declared = declaredById.get(required.id);
    if (!declared || !sameObligation(declared, required)) {
      throw new Error('effect_state_recovery_release_gate_proof_requirements_mismatch');
    }
  }
}

function assertWithinRepository(repositoryRoot, candidate) {
  const relative = path.relative(repositoryRoot, candidate);
  if (
    relative === ''
    || relative.startsWith(`..${path.sep}`)
    || relative === '..'
    || path.isAbsolute(relative)
  ) {
    throw new Error('effect_state_recovery_release_gate_proof_evidence_invalid');
  }
}

async function validateProofEvidence(
  manifest,
  repositoryRoot,
  trustedEvidenceCatalog,
) {
  if (!Array.isArray(manifest.evidence) || manifest.evidence.length === 0) {
    throw new Error('effect_state_recovery_release_gate_proof_evidence_invalid');
  }

  const trustedById = trustedEvidenceById(trustedEvidenceCatalog);
  const evidenceIds = new Set();
  const coveredObligationIds = new Set();
  const testEntries = [];
  const repositoryRealPath = await fsp.realpath(repositoryRoot);

  for (const evidence of manifest.evidence) {
    if (
      !isObject(evidence)
      || typeof evidence.id !== 'string'
      || evidence.id.length === 0
      || evidenceIds.has(evidence.id)
      || typeof evidence.test_path !== 'string'
      || evidence.test_path.length === 0
      || path.isAbsolute(evidence.test_path)
      || !EVIDENCE_RUNNERS.includes(evidence.runner)
    ) {
      throw new Error('effect_state_recovery_release_gate_proof_evidence_invalid');
    }
    evidenceIds.add(evidence.id);
    const trustedEvidence = trustedById.get(evidence.id);
    if (
      !trustedEvidence
      || evidence.test_path !== trustedEvidence.test_path
      || evidence.runner !== trustedEvidence.runner
    ) {
      throw new Error('effect_state_recovery_release_gate_proof_evidence_invalid');
    }

    const obligationCases = readObligationCases(
      evidence.obligation_cases,
      'effect_state_recovery_release_gate_proof_evidence_invalid',
    );
    const trustedObligationCases = readObligationCases(
      trustedEvidence.obligation_cases,
      'effect_state_recovery_release_gate_proof_evidence_invalid',
    );
    if (!sameObligationCases(obligationCases, trustedObligationCases)) {
      throw new Error('effect_state_recovery_release_gate_proof_evidence_invalid');
    }
    const obligationIds = obligationCases.map((entry) => entry.obligation_id);
    const expectedTestTitles = [
      ...new Set(
        obligationCases.flatMap((entry) => entry.expected_test_titles),
      ),
    ];
    assertRunnerCanProveObligations(
      evidence.runner,
      obligationIds,
      'effect_state_recovery_release_gate_proof_evidence_invalid',
    );
    for (const obligationId of obligationIds) {
      coveredObligationIds.add(obligationId);
    }

    const testPath = path.resolve(repositoryRoot, evidence.test_path);
    assertWithinRepository(repositoryRoot, testPath);
    await assertRegularNonLink(
      testPath,
      'effect_state_recovery_release_gate_evidence_test_missing',
    );
    const testRealPath = await fsp.realpath(testPath);
    assertWithinRepository(repositoryRealPath, testRealPath);
    testEntries.push({
      runner: evidence.runner,
      testPath,
      expectedTestTitles,
    });
  }

  if (!sameMembers([...evidenceIds], [...trustedById.keys()])) {
    throw new Error('effect_state_recovery_release_gate_proof_evidence_invalid');
  }

  const uniqueTestEntries = new Map();
  for (const entry of testEntries) {
    const key = `${entry.runner}:${entry.testPath}`;
    const existing = uniqueTestEntries.get(key);
    uniqueTestEntries.set(key, existing
      ? {
          ...existing,
          expectedTestTitles: [
            ...new Set([
              ...existing.expectedTestTitles,
              ...entry.expectedTestTitles,
            ]),
          ],
        }
      : entry);
  }
  return {
    coveredObligationIds,
    testEntries: [...uniqueTestEntries.values()],
  };
}

export function assertEvidenceExecutionResult({
  runner,
  expectedTestTitles,
  nodeTapOutput,
  vitestReport,
}) {
  if (!EVIDENCE_RUNNERS.includes(runner)) {
    throw new Error('effect_state_recovery_release_gate_evidence_runner_invalid');
  }
  const expected = readUniqueStrings(
    expectedTestTitles,
    'effect_state_recovery_release_gate_evidence_result_invalid',
  );
  if (expected.length === 0) {
    throw new Error('effect_state_recovery_release_gate_evidence_result_invalid');
  }

  if (runner === 'node' || runner === 'node-subprocess') {
    const observedTitles = new Map();
    for (const rawLine of String(nodeTapOutput || '').split(/\r?\n/u)) {
      const line = rawLine.trim();
      const match =
        /^(not )?ok \d+ - (.+?)(?: # (SKIP|TODO).*)?$/u.exec(line);
      if (!match) continue;
      const title = match[2];
      const observations = observedTitles.get(title) || [];
      observations.push({ passed: !match[1] && !match[3] });
      observedTitles.set(title, observations);
    }
    for (const title of expected) {
      const observations = observedTitles.get(title) || [];
      if (observations.length !== 1 || !observations[0].passed) {
        throw new Error(
          'effect_state_recovery_release_gate_evidence_result_invalid',
        );
      }
    }
    return;
  }

  if (!isObject(vitestReport) || !Array.isArray(vitestReport.testResults)) {
    throw new Error('effect_state_recovery_release_gate_evidence_result_invalid');
  }
  const assertions = vitestReport.testResults.flatMap((result) =>
    Array.isArray(result?.assertionResults) ? result.assertionResults : []);
  for (const title of expected) {
    const matching = assertions.filter((assertion) => assertion?.title === title);
    if (
      matching.length !== 1
      || matching[0].status !== 'passed'
    ) {
      throw new Error('effect_state_recovery_release_gate_evidence_result_invalid');
    }
  }
}

function validateCoverage(manifest, coveredObligationIds) {
  if (
    !isObject(manifest.coverage)
    || !isObject(manifest.coverage.obligations)
  ) {
    throw new Error('effect_state_recovery_release_gate_proof_coverage_invalid');
  }
  const coverage = manifest.coverage.obligations;
  const covered = readUniqueStrings(
    coverage.covered_ids,
    'effect_state_recovery_release_gate_proof_coverage_invalid',
  );
  const missing = readUniqueStrings(
    coverage.missing_ids,
    'effect_state_recovery_release_gate_proof_coverage_invalid',
  );
  const requiredIds =
    EFFECT_STATE_RECOVERY_REQUIRED_OBLIGATIONS.map(({ id }) => id);
  const expectedCovered = requiredIds.filter((id) =>
    coveredObligationIds.has(id));
  const expectedMissing = requiredIds.filter((id) =>
    !coveredObligationIds.has(id));
  if (
    coverage.required_catalog_sha256
      !== EFFECT_STATE_RECOVERY_REQUIRED_CATALOG_SHA256
    || coverage.required_count !== requiredIds.length
    || !sameMembers(covered, expectedCovered)
    || !sameMembers(missing, expectedMissing)
  ) {
    throw new Error('effect_state_recovery_release_gate_proof_coverage_invalid');
  }
  return expectedMissing.length > 0;
}

async function readReleaseProof({
  proofPath,
  repositoryRoot,
  trustedEvidenceCatalog,
}) {
  let manifest;
  try {
    manifest = JSON.parse(await fsp.readFile(proofPath, 'utf8'));
  } catch {
    throw new Error('effect_state_recovery_release_gate_proof_json_invalid');
  }
  if (!isObject(manifest) || manifest.schema_version !== PROOF_SCHEMA) {
    throw new Error('effect_state_recovery_release_gate_proof_schema_invalid');
  }
  if (typeof manifest.complete !== 'boolean') {
    throw new Error('effect_state_recovery_release_gate_proof_schema_invalid');
  }

  assertManifestRequirements(manifest.requirements);
  const {
    coveredObligationIds,
    testEntries,
  } = await validateProofEvidence(
    manifest,
    repositoryRoot,
    trustedEvidenceCatalog,
  );
  const hasMissing = validateCoverage(manifest, coveredObligationIds);
  if (!manifest.complete || hasMissing) {
    throw new Error('effect_state_recovery_release_gate_proof_incomplete');
  }

  return { manifest, testEntries };
}

function assertVersionOutput(output, expectedVersion) {
  const normalized = String(output || '').trim().toLowerCase();
  const expected = expectedVersion.toLowerCase();
  if (
    normalized !== expected
    && normalized !== `iii ${expected}`
    && normalized !== `iii-engine ${expected}`
  ) {
    throw new Error('effect_state_recovery_release_gate_iii_version_mismatch');
  }
}

async function readEngineVersion(enginePath) {
  let result;
  try {
    result = await execFileAsync(enginePath, ['--version'], {
      encoding: 'utf8',
      timeout: 10_000,
      windowsHide: true,
    });
  } catch {
    throw new Error('effect_state_recovery_release_gate_iii_version_unavailable');
  }
  return `${result.stdout || ''}${result.stderr || ''}`;
}

export async function assertEffectStateRecoveryReleaseInputs({
  enginePath,
  proofPath,
  repositoryRoot,
  expectedEngineHash = PINNED_III_ENGINE_SHA256,
  expectedEngineVersion = PINNED_III_ENGINE_VERSION,
  readVersion = readEngineVersion,
  trustedEvidenceCatalog = EFFECT_STATE_RECOVERY_TRUSTED_EVIDENCE,
}) {
  if (!enginePath || !path.isAbsolute(enginePath)) {
    throw new Error('effect_state_recovery_release_gate_iii_path_required');
  }
  if (!proofPath || !path.isAbsolute(proofPath)) {
    throw new Error('effect_state_recovery_release_gate_proof_path_invalid');
  }
  if (!repositoryRoot || !path.isAbsolute(repositoryRoot)) {
    throw new Error('effect_state_recovery_release_gate_repository_root_invalid');
  }

  await assertRegularNonLink(
    enginePath,
    'effect_state_recovery_release_gate_iii_file_invalid',
  );
  await assertRegularNonLink(
    proofPath,
    'effect_state_recovery_release_gate_proof_file_missing',
  );
  const { testEntries } = await readReleaseProof({
    proofPath,
    repositoryRoot,
    trustedEvidenceCatalog,
  });

  if (await hashFile(enginePath) !== expectedEngineHash) {
    throw new Error('effect_state_recovery_release_gate_iii_hash_mismatch');
  }
  assertVersionOutput(await readVersion(enginePath), expectedEngineVersion);

  return {
    enginePath,
    engineSha256: expectedEngineHash,
    engineVersion: expectedEngineVersion,
    proofPath,
    testEntries,
  };
}
