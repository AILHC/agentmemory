import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { RunStateJournalV2 } from './run-state-journal-v2.mjs';
import {
  appendRecoveryContractFence,
  buildRecoveryMigrationManifest,
  resumeRecoveryMigration,
} from './recovery-frontier-migration-v1.mjs';
import {
  assertLegacyRecoveryContractCompatible,
  hashRecoveryValue,
  inspectRecoveryMigrationGate,
  validateRecoveryMigrationManifest,
} from './recovery-migration-contract-v1.mjs';
import { reduceRecoveryJournal } from './recovery-journal-reducer-v1.mjs';
import {
  RECOVERY_POLICY_HASH,
  RECOVERY_POLICY_VERSION,
  decideRecovery,
} from './recovery-policy-v1.mjs';
import {
  EFFECT_STATE_RECOVERY_STAGES,
} from './effect-state-recovery-stage-catalog-v1.mjs';
import {
  openIiiStateReadOnlyWorkingCopy,
} from './iii-state-read-only-adapter-v1.mjs';
import {
  createRealLegacyLessonSnapshotFixture,
  readFileTreeBytes,
  REAL_LEGACY_LESSON_UNIT_ID,
} from './iii-state-read-only-test-fixture-v1.mjs';
import {
  createLegacyLessonEvidenceProvenanceVerifier,
} from './legacy-lesson-safe-facts-collector-v1.mjs';
import {
  verifyOfflineStateKvSnapshot,
} from './offline-statekv-snapshot-v1.mjs';
import { main as runMigrationCli } from '../migrate-agentmemory-recovery-frontier.mjs';

const OFFICIAL_ENGINE_PATH = process.env.AGENTMEMORY_TEST_III_BIN;
const realIiiTest = OFFICIAL_ENGINE_PATH ? test : test.skip;

const MIGRATION_METADATA = Object.freeze({
  originalContractVersion: 'run-state-journal-v2/legacy',
  targetContractVersion: RECOVERY_POLICY_VERSION,
  originalPolicyVersion: 'legacy-stage-recovery/v2',
  targetPolicyVersion: RECOVERY_POLICY_VERSION,
  upgradeAt: '2026-07-30T00:00:00.000Z',
  authorizedAt: '2026-07-30T00:00:00.000Z',
  authorizationSourceType: 'change_ticket',
});

function testOnlyTrustedEvidenceVerifier(safeEvidenceByUnit) {
  return async () => ({
    source_type: 'trusted_read_only_collector',
    safeEvidenceByUnit: structuredClone(safeEvidenceByUnit),
    collector_provenance: {
      schema: 'legacy-lesson-safe-facts-provenance/v1',
      snapshot_hash: 'd'.repeat(64),
      engine_hash: 'e'.repeat(64),
    },
  });
}

async function fixture(name, unitIds = ['lesson-b']) {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), `${name}-`));
  const journal = new RunStateJournalV2({ rootDir, runId: 'migration-run' });
  await journal.acquireLock();
  try {
    for (const unitId of unitIds) {
      await journal.appendStage('lessons', 'unit_planned', {
        unit_id: unitId,
        input_hash: `${unitId}-input`,
      });
    }
    await journal.appendStage('lessons', 'stage_plan_completed', {
      unit_count: unitIds.length,
    });
    for (const unitId of unitIds) {
      await journal.appendStage('lessons', 'unit_started', {
        unit_id: unitId,
        attempt_id: `${unitId}-attempt`,
      });
      await journal.appendStage('lessons', 'unit_terminal', {
        unit_id: unitId,
        attempt_id: `${unitId}-attempt`,
        status: 'failed',
        error: 'legacy_safe_code',
      });
    }
  } finally {
    await journal.releaseLock();
  }
  return { rootDir, journal };
}

function zeroEffectEvidence(unitId) {
  const attemptId = `${unitId}-attempt`;
  const receiptKey = `xop_${createHash('sha256')
    .update(JSON.stringify([attemptId, 'lessons', unitId]))
    .digest('hex')
    .slice(0, 32)}`;
  return {
    adapter: 'lessons/legacy-safe-facts-v1',
    attempt_id: attemptId,
    operation_id: `${unitId}:legacy`,
    safe_facts: {
      failure: { cause: 'lesson_no_blocks' },
      expectedLessonRunId: `${unitId}-run`,
      expectedRunInputHash: 'a'.repeat(64),
      expectedReceiptInputHash: 'c'.repeat(64),
      expectedConfigHash: 'b'.repeat(64),
      lessonRun: {
        id: `${unitId}-run`,
        sessionId: unitId,
        status: 'failed',
        inputHash: 'a'.repeat(64),
        configHash: 'b'.repeat(64),
        createdLessonIds: [],
        replacedLessonIds: [],
        finishedAt: '2026-07-30T00:00:00.000Z',
      },
      receipt: {
        key: receiptKey,
        runId: attemptId,
        unitId,
        stage: 'lessons',
        inputHash: 'c'.repeat(64),
        status: 'failed',
        failure: { class: 'unit', cause: 'lesson_no_blocks' },
      },
      lessonChunks: [],
      formalLessonWrites: [],
      collection: {
        schema: 'legacy-lesson-safe-facts-collection/v1',
        snapshot_hash: 'd'.repeat(64),
        state_tree_hash: 'f'.repeat(64),
        engine_hash: 'e'.repeat(64),
        journal_input_summary_hash: '1'.repeat(64),
        scope_proofs: [
          `mem:extraction-operation-receipt:${receiptKey}`,
          'mem:extraction-operation-receipts',
          'mem:lesson-extraction:runs',
          `mem:lesson-extraction:chunks:${unitId}-run`,
          'mem:lessons',
          `mem:lesson-commit:receipts:${unitId}-run`,
        ].map((scope) => ({
          scope,
          exact_count: 0,
          safe_projection_hash: '2'.repeat(64),
        })),
      },
    },
  };
}

function migrationCliArgs({
  command,
  rootDir,
  inputPath,
  snapshotPath,
  confirmations = command === 'fence',
}) {
  return [
    command,
    '--run-root', rootDir,
    '--run-id', 'migration-run',
    '--stage', 'lessons',
    '--safe-evidence', inputPath,
    ...(snapshotPath ? ['--evidence-snapshot', snapshotPath] : []),
    '--original-contract-version', MIGRATION_METADATA.originalContractVersion,
    '--target-contract-version', MIGRATION_METADATA.targetContractVersion,
    '--original-policy-version', MIGRATION_METADATA.originalPolicyVersion,
    '--target-policy-version', MIGRATION_METADATA.targetPolicyVersion,
    '--upgrade-at', MIGRATION_METADATA.upgradeAt,
    '--authorized-at', MIGRATION_METADATA.authorizedAt,
    '--authorization-source-type', MIGRATION_METADATA.authorizationSourceType,
    ...(confirmations
      ? [
        '--confirm-old-runner-absent',
        '--confirm-other-writers-absent',
      ]
      : []),
  ];
}

function injectedEvidenceVerifier(safeEvidenceByUnit, overrides = {}) {
  return (snapshotDir) => {
    overrides.onCreate?.(snapshotDir);
    return async (request) => {
      overrides.onRequest?.(request);
      if (overrides.error) throw overrides.error;
      return {
        source_type: 'trusted_read_only_collector',
        safeEvidenceByUnit: structuredClone(safeEvidenceByUnit),
        collector_provenance: {
          schema: 'legacy-lesson-safe-facts-provenance/v1',
          snapshot_hash: 'd'.repeat(64),
          engine_hash: 'e'.repeat(64),
        },
        private_body: 'collector body sentinel',
        ...overrides.proof,
      };
    };
  };
}

async function journalOnlyFixture(name) {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), `${name}-`));
  const journal = new RunStateJournalV2({ rootDir, runId: 'migration-run' });
  const evidence = {
    kind: 'unknown',
    receiptKey: 'journal-receipt',
    reasonCode: 'response_lost',
  };
  const decision = decideRecovery({
    policyVersion: RECOVERY_POLICY_VERSION,
    evidence,
  });
  await journal.acquireLock();
  try {
    await journal.appendStage('lessons', 'unit_planned', {
      unit_id: 'lesson-j',
    });
    await journal.appendStage('lessons', 'stage_plan_completed', {
      unit_count: 1,
    });
    await journal.appendStage('lessons', 'unit_attempt_started', {
      unit_id: 'lesson-j',
      attempt_id: 'journal-attempt',
      attempt_number: 2,
    });
    await journal.appendStage('lessons', 'unit_operation_started', {
      unit_id: 'lesson-j',
      attempt_id: 'journal-attempt',
      operation_id: 'lesson-j:operation',
    });
    await journal.appendStage('lessons', 'unit_outcome_observed', {
      unit_id: 'lesson-j',
      attempt_id: 'journal-attempt',
      operation_id: 'lesson-j:operation',
      policy_version: RECOVERY_POLICY_VERSION,
      evidence,
      decision,
    });
  } finally {
    await journal.releaseLock();
  }
  return { rootDir, journal };
}

test('preview is deterministic and orders the unresolved frontier by unit identity', async (context) => {
  const { rootDir, journal } = await fixture(
    'agentmemory-migration-preview',
    ['lesson-z', 'lesson-a'],
  );
  context.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  const events = await journal.readStage('lessons');
  const evidence = {
    'lesson-z': zeroEffectEvidence('lesson-z'),
    'lesson-a': zeroEffectEvidence('lesson-a'),
  };
  const first = buildRecoveryMigrationManifest({
    runId: 'migration-run',
    stage: 'lessons',
    events,
    safeEvidenceByUnit: evidence,
    ...MIGRATION_METADATA,
  });
  const second = buildRecoveryMigrationManifest({
    runId: 'migration-run',
    stage: 'lessons',
    events: structuredClone(events),
    safeEvidenceByUnit: structuredClone(evidence),
    ...MIGRATION_METADATA,
  });
  assert.deepEqual(first, second);
  assert.deepEqual(first.entries.map((entry) => entry.unit_id), [
    'lesson-a',
    'lesson-z',
  ]);
  assert.ok(first.entries.every((entry) => entry.decision.action === 'skipped'));
  assert.equal(
    first.evidence_provenance_state,
    'independent_verification_required',
  );
});

test('fence rejects caller JSON evidence without an independent read-only verifier', async (context) => {
  const { rootDir, journal } = await fixture('agentmemory-migration-unverified');
  context.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  const manifest = buildRecoveryMigrationManifest({
    runId: 'migration-run',
    stage: 'lessons',
    events: await journal.readStage('lessons'),
    safeEvidenceByUnit: { 'lesson-b': zeroEffectEvidence('lesson-b') },
    ...MIGRATION_METADATA,
  });
  await assert.rejects(
    () => appendRecoveryContractFence({
      journal,
      stage: 'lessons',
      manifest,
      verifyOfflineWritersAbsent: async () => ({
        oldRunnerAbsent: true,
        writerLockAbsent: true,
        otherWritersAbsent: true,
      }),
    }),
    /recovery_migration_fence_evidence_provenance_unverified/,
  );
  await assert.rejects(
    () => appendRecoveryContractFence({
      journal,
      stage: 'lessons',
      manifest,
      verifyOfflineWritersAbsent: async () => ({
        oldRunnerAbsent: true,
        writerLockAbsent: true,
        otherWritersAbsent: true,
      }),
      verifyEvidenceProvenance: testOnlyTrustedEvidenceVerifier({
        'lesson-b': {
          adapter: 'lessons/legacy-safe-facts-v1',
          attempt_id: 'lesson-b-attempt',
          operation_id: 'lesson-b:legacy',
          safe_facts: { failure: { cause: 'response_lost' } },
        },
      }),
    }),
    /recovery_migration_fence_evidence_provenance_unverified/,
  );
  assert.equal(
    (await journal.readStage('lessons')).some(
      (event) => event.type === 'stage_recovery_contract_fenced',
    ),
    false,
  );
});

test('fence rejects changed collector provenance before writing the fence', async (context) => {
  const { rootDir, journal } = await fixture(
    'agentmemory-migration-collector-provenance-drift',
  );
  context.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  const evidence = { 'lesson-b': zeroEffectEvidence('lesson-b') };
  const manifest = buildRecoveryMigrationManifest({
    runId: 'migration-run',
    stage: 'lessons',
    events: await journal.readStage('lessons'),
    safeEvidenceByUnit: evidence,
    ...MIGRATION_METADATA,
  });
  await assert.rejects(
    () => appendRecoveryContractFence({
      journal,
      stage: 'lessons',
      manifest,
      verifyOfflineWritersAbsent: async () => ({
        oldRunnerAbsent: true,
        writerLockAbsent: true,
        otherWritersAbsent: true,
      }),
      verifyEvidenceProvenance: async () => ({
        source_type: 'trusted_read_only_collector',
        safeEvidenceByUnit: structuredClone(evidence),
        collector_provenance: {
          schema: 'legacy-lesson-safe-facts-provenance/v1',
          snapshot_hash: '0'.repeat(64),
          engine_hash: 'e'.repeat(64),
        },
      }),
    }),
    /recovery_migration_fence_evidence_provenance_unverified/,
  );
  assert.equal(
    (await journal.readStage('lessons')).some(
      (event) => event.type === 'stage_recovery_contract_fenced',
    ),
    false,
  );
});

test('preview without a snapshot preserves the existing manifest-only output and never appends', async (context) => {
  const { rootDir, journal } = await fixture('agentmemory-migration-cli-preview-compatible');
  context.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  const inputPath = path.join(rootDir, 'caller-evidence.json');
  const evidence = { 'lesson-b': zeroEffectEvidence('lesson-b') };
  await fs.writeFile(inputPath, JSON.stringify({
    safeEvidenceByUnit: evidence,
  }));
  let output = '';
  assert.equal(
    await runMigrationCli(migrationCliArgs({
      command: 'preview',
      rootDir,
      inputPath,
    }), {
      writeOutput: (value) => {
        output += value;
      },
    }),
    0,
  );
  const parsed = JSON.parse(output);
  assert.equal(parsed.evidence_provenance_state, 'independent_verification_required');
  assert.equal('evidence_verification' in parsed, false);
  assert.equal(
    (await journal.readStage('lessons')).some(
      (event) => event.type === 'stage_recovery_contract_fenced',
    ),
    false,
  );
});

test('snapshot preview independently verifies exact collector facts with a bounded body-free conclusion', async (context) => {
  const { rootDir, journal } = await fixture('agentmemory-migration-cli-preview-verified');
  context.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  const inputPath = path.join(rootDir, 'caller-evidence.json');
  const snapshotPath = path.join(rootDir, 'evidence-snapshot');
  const evidence = { 'lesson-b': zeroEffectEvidence('lesson-b') };
  await fs.writeFile(inputPath, JSON.stringify({
    safeEvidenceByUnit: evidence,
    private_body: 'caller body sentinel',
  }));
  let createdSnapshotPath;
  let verifierRequest;
  let output = '';
  await runMigrationCli(migrationCliArgs({
    command: 'preview',
    rootDir,
    inputPath,
    snapshotPath,
  }), {
    createEvidenceVerifier: injectedEvidenceVerifier(evidence, {
      onCreate: (value) => {
        createdSnapshotPath = value;
      },
      onRequest: (value) => {
        verifierRequest = value;
      },
    }),
    writeOutput: (value) => {
      output += value;
    },
  });
  const parsed = JSON.parse(output);
  assert.equal(createdSnapshotPath, snapshotPath);
  assert.deepEqual(verifierRequest.units, ['lesson-b']);
  assert.equal(verifierRequest.run_id, 'migration-run');
  assert.deepEqual(parsed.evidence_verification, {
    schema: 'recovery-migration-preview-evidence-verification/v1',
    state: 'independently_verified',
    source_type: 'trusted_read_only_collector',
    verified_unit_count: 1,
    verified_units_hash: hashRecoveryValue(['lesson-b']),
    manifest_hash: parsed.manifest_hash,
    snapshot_hash: 'd'.repeat(64),
    engine_hash: 'e'.repeat(64),
  });
  assert.equal(output.includes('caller body sentinel'), false);
  assert.equal(output.includes('collector body sentinel'), false);
  assert.equal(
    (await journal.readStage('lessons')).some(
      (event) => event.type === 'stage_recovery_contract_fenced',
    ),
    false,
  );
});

test('snapshot preview verifies the exact Journal binding even when the frontier is empty', async (context) => {
  const { rootDir } = await fixture(
    'agentmemory-migration-cli-preview-empty-verified',
    [],
  );
  context.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  const inputPath = path.join(rootDir, 'caller-evidence.json');
  const snapshotPath = path.join(rootDir, 'evidence-snapshot');
  await fs.writeFile(inputPath, JSON.stringify({ safeEvidenceByUnit: {} }));
  let verifierRequest;
  let output = '';
  await runMigrationCli(migrationCliArgs({
    command: 'preview',
    rootDir,
    inputPath,
    snapshotPath,
  }), {
    createEvidenceVerifier: injectedEvidenceVerifier({}, {
      onRequest: (value) => {
        verifierRequest = value;
      },
    }),
    writeOutput: (value) => {
      output += value;
    },
  });
  const parsed = JSON.parse(output);
  assert.deepEqual(verifierRequest.units, []);
  assert.equal(parsed.frontier_count, 0);
  assert.equal(parsed.evidence_verification.state, 'independently_verified');
  assert.equal(parsed.evidence_verification.verified_unit_count, 0);
});

test('snapshot preview rejects collector mismatch and verifier failure without appending', async (context) => {
  const { rootDir, journal } = await fixture('agentmemory-migration-cli-preview-mismatch');
  context.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  const inputPath = path.join(rootDir, 'caller-evidence.json');
  const snapshotPath = path.join(rootDir, 'evidence-snapshot');
  const evidence = { 'lesson-b': zeroEffectEvidence('lesson-b') };
  await fs.writeFile(inputPath, JSON.stringify({ safeEvidenceByUnit: evidence }));
  const mismatch = structuredClone(evidence);
  mismatch['lesson-b'].safe_facts.failure.cause = 'response_lost';
  await assert.rejects(
    () => runMigrationCli(migrationCliArgs({
      command: 'preview',
      rootDir,
      inputPath,
      snapshotPath,
    }), {
      createEvidenceVerifier: injectedEvidenceVerifier(mismatch),
      writeOutput: () => {},
    }),
    /recovery_migration_cli_preview_evidence_mismatch/,
  );
  await assert.rejects(
    () => runMigrationCli(migrationCliArgs({
      command: 'preview',
      rootDir,
      inputPath,
      snapshotPath,
    }), {
      createEvidenceVerifier: injectedEvidenceVerifier(evidence, {
        error: new Error('offline_snapshot_content_drifted'),
      }),
      writeOutput: () => {},
    }),
    /offline_snapshot_content_drifted/,
  );
  assert.equal(
    (await journal.readStage('lessons')).some(
      (event) => event.type === 'stage_recovery_contract_fenced',
    ),
    false,
  );
});

test('fence requires a snapshot for external entries and passes its verifier into the append gate', async (context) => {
  const { rootDir, journal } = await fixture('agentmemory-migration-cli-fence-verified');
  context.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  const inputPath = path.join(rootDir, 'caller-evidence.json');
  const snapshotPath = path.join(rootDir, 'evidence-snapshot');
  const evidence = { 'lesson-b': zeroEffectEvidence('lesson-b') };
  await fs.writeFile(inputPath, JSON.stringify({ safeEvidenceByUnit: evidence }));
  await assert.rejects(
    () => runMigrationCli(migrationCliArgs({
      command: 'fence',
      rootDir,
      inputPath,
    }), {
      writeOutput: () => {},
    }),
    /--evidence-snapshot is required for external evidence/,
  );
  assert.equal(
    (await journal.readStage('lessons')).some(
      (event) => event.type === 'stage_recovery_contract_fenced',
    ),
    false,
  );
  let request;
  let output = '';
  await runMigrationCli(migrationCliArgs({
    command: 'fence',
    rootDir,
    inputPath,
    snapshotPath,
  }), {
    createEvidenceVerifier: injectedEvidenceVerifier(evidence, {
      onRequest: (value) => {
        request = value;
      },
    }),
    writeOutput: (value) => {
      output += value;
    },
  });
  assert.deepEqual(request.units, ['lesson-b']);
  assert.equal(JSON.parse(output).fence_seq, 4);
  assert.equal(
    (await journal.readStage('lessons')).at(-1).type,
    'stage_recovery_contract_fenced',
  );
  let migrateOutput = '';
  await runMigrationCli([
    'migrate',
    '--run-root', rootDir,
    '--run-id', 'migration-run',
    '--stage', 'lessons',
  ], {
    createEvidenceVerifier: () => {
      throw new Error('migrate must not create an evidence verifier');
    },
    writeOutput: (value) => {
      migrateOutput += value;
    },
  });
  assert.equal(JSON.parse(migrateOutput).completed_steps > 0, true);
  assert.equal(
    inspectRecoveryMigrationGate(await journal.readStage('lessons')).state,
    'migrated',
  );
});

test('fence rejects collector mismatch or snapshot drift before appending', async (context) => {
  for (const mode of ['mismatch', 'snapshot-drift']) {
    const { rootDir, journal } = await fixture(
      `agentmemory-migration-cli-fence-${mode}`,
    );
    context.after(() => fs.rm(rootDir, { recursive: true, force: true }));
    const inputPath = path.join(rootDir, 'caller-evidence.json');
    const snapshotPath = path.join(rootDir, 'evidence-snapshot');
    const evidence = { 'lesson-b': zeroEffectEvidence('lesson-b') };
    await fs.writeFile(inputPath, JSON.stringify({
      safeEvidenceByUnit: evidence,
    }));
    const mismatch = structuredClone(evidence);
    mismatch['lesson-b'].safe_facts.expectedConfigHash = '0'.repeat(64);
    await assert.rejects(
      () => runMigrationCli(migrationCliArgs({
        command: 'fence',
        rootDir,
        inputPath,
        snapshotPath,
      }), {
        createEvidenceVerifier: injectedEvidenceVerifier(
          mode === 'mismatch' ? mismatch : evidence,
          mode === 'snapshot-drift'
            ? { error: new Error('offline_snapshot_content_drifted') }
            : {},
        ),
        writeOutput: () => {},
      }),
      mode === 'mismatch'
        ? /recovery_migration_fence_evidence_provenance_unverified/
        : /offline_snapshot_content_drifted/,
    );
    assert.equal(
      (await journal.readStage('lessons')).some(
        (event) => event.type === 'stage_recovery_contract_fenced',
      ),
      false,
    );
  }
});

test('journal-only fence remains available without an evidence snapshot', async (context) => {
  const { rootDir, journal } = await journalOnlyFixture(
    'agentmemory-migration-cli-journal-only',
  );
  context.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  const inputPath = path.join(rootDir, 'caller-evidence.json');
  await fs.writeFile(inputPath, JSON.stringify({ safeEvidenceByUnit: {} }));
  let verifierCreated = false;
  await runMigrationCli(migrationCliArgs({
    command: 'fence',
    rootDir,
    inputPath,
  }), {
    createEvidenceVerifier: () => {
      verifierCreated = true;
      throw new Error('journal-only fence must not create a verifier');
    },
    writeOutput: () => {},
  });
  assert.equal(verifierCreated, false);
  assert.equal(
    (await journal.readStage('lessons')).at(-1).type,
    'stage_recovery_contract_fenced',
  );
});

test('evidence snapshot arguments fail closed for relative, duplicate, migrate, and preview writer-confirmation use', async (context) => {
  const { rootDir } = await fixture('agentmemory-migration-cli-arguments');
  context.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  const inputPath = path.join(rootDir, 'caller-evidence.json');
  const snapshotPath = path.join(rootDir, 'evidence-snapshot');
  await fs.writeFile(inputPath, JSON.stringify({ safeEvidenceByUnit: {} }));
  await assert.rejects(
    () => runMigrationCli(migrationCliArgs({
      command: 'preview',
      rootDir,
      inputPath,
      snapshotPath: 'relative-snapshot',
    }), { writeOutput: () => {} }),
    /--evidence-snapshot must be absolute/,
  );
  await assert.rejects(
    () => runMigrationCli([
      ...migrationCliArgs({
        command: 'preview',
        rootDir,
        inputPath,
        snapshotPath,
      }),
      '--evidence-snapshot', snapshotPath,
    ], { writeOutput: () => {} }),
    /--evidence-snapshot may be provided only once/,
  );
  await assert.rejects(
    () => runMigrationCli([
      'migrate',
      '--run-root', rootDir,
      '--run-id', 'migration-run',
      '--stage', 'lessons',
      '--evidence-snapshot', snapshotPath,
    ], { writeOutput: () => {} }),
    /--evidence-snapshot is not valid for migrate/,
  );
  await assert.rejects(
    () => runMigrationCli([
      ...migrationCliArgs({
        command: 'preview',
        rootDir,
        inputPath,
        confirmations: false,
      }),
      '--confirm-old-runner-absent',
    ], { writeOutput: () => {} }),
    /writer confirmations are valid only for fence/,
  );
});

test('fence independently revalidates Journal outcome evidence without an external verifier', async (context) => {
  const rootDir = await fs.mkdtemp(path.join(
    os.tmpdir(),
    'agentmemory-migration-journal-evidence-',
  ));
  context.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  const journal = new RunStateJournalV2({ rootDir, runId: 'migration-run' });
  const evidence = {
    kind: 'unknown',
    receiptKey: 'journal-receipt',
    reasonCode: 'response_lost',
  };
  const decision = decideRecovery({
    policyVersion: RECOVERY_POLICY_VERSION,
    evidence,
  });
  await journal.acquireLock();
  try {
    await journal.appendStage('lessons', 'unit_planned', {
      unit_id: 'lesson-j',
    });
    await journal.appendStage('lessons', 'stage_plan_completed', {
      unit_count: 1,
    });
    await journal.appendStage('lessons', 'unit_attempt_started', {
      unit_id: 'lesson-j',
      attempt_id: 'journal-attempt',
      attempt_number: 2,
    });
    await journal.appendStage('lessons', 'unit_operation_started', {
      unit_id: 'lesson-j',
      attempt_id: 'journal-attempt',
      operation_id: 'lesson-j:operation',
    });
    await journal.appendStage('lessons', 'unit_outcome_observed', {
      unit_id: 'lesson-j',
      attempt_id: 'journal-attempt',
      operation_id: 'lesson-j:operation',
      policy_version: RECOVERY_POLICY_VERSION,
      evidence,
      decision,
    });
  } finally {
    await journal.releaseLock();
  }
  const manifest = buildRecoveryMigrationManifest({
    runId: 'migration-run',
    stage: 'lessons',
    events: await journal.readStage('lessons'),
    safeEvidenceByUnit: {},
    ...MIGRATION_METADATA,
  });
  assert.equal(manifest.evidence_provenance_state, 'journal_verified');
  await appendRecoveryContractFence({
    journal,
    stage: 'lessons',
    manifest,
    verifyOfflineWritersAbsent: async () => ({
      oldRunnerAbsent: true,
      writerLockAbsent: true,
      otherWritersAbsent: true,
    }),
  });
  assert.equal(
    (await journal.readStage('lessons')).at(-1).type,
    'stage_recovery_contract_fenced',
  );
});

test('fence uses the formal writer lock and refuses stale preview input', async (context) => {
  const { rootDir, journal } = await fixture('agentmemory-migration-cas');
  context.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  const events = await journal.readStage('lessons');
  const manifest = buildRecoveryMigrationManifest({
    runId: 'migration-run',
    stage: 'lessons',
    events,
    safeEvidenceByUnit: { 'lesson-b': zeroEffectEvidence('lesson-b') },
    ...MIGRATION_METADATA,
  });
  await journal.acquireLock();
  await journal.appendStage('lessons', 'run_attention_required', {
    unit_ids: ['lesson-b'],
  });
  await journal.releaseLock();
  await assert.rejects(
    () => appendRecoveryContractFence({
      journal,
      stage: 'lessons',
      manifest,
      verifyOfflineWritersAbsent: async () => ({
        oldRunnerAbsent: true,
        writerLockAbsent: true,
        otherWritersAbsent: true,
      }),
      verifyEvidenceProvenance: testOnlyTrustedEvidenceVerifier({
        'lesson-b': zeroEffectEvidence('lesson-b'),
      }),
    }),
    /recovery_migration_input_drifted/,
  );
});

test('legacy runner rejects the fence and migration resumes an interrupted manifest append', async (context) => {
  const { rootDir, journal } = await fixture('agentmemory-migration-resume');
  context.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  const manifest = buildRecoveryMigrationManifest({
    runId: 'migration-run',
    stage: 'lessons',
    events: await journal.readStage('lessons'),
    safeEvidenceByUnit: { 'lesson-b': zeroEffectEvidence('lesson-b') },
    ...MIGRATION_METADATA,
  });
  await appendRecoveryContractFence({
    journal,
    stage: 'lessons',
    manifest,
    verifyOfflineWritersAbsent: async () => ({
      oldRunnerAbsent: true,
      writerLockAbsent: true,
      otherWritersAbsent: true,
    }),
    verifyEvidenceProvenance: testOnlyTrustedEvidenceVerifier({
      'lesson-b': zeroEffectEvidence('lesson-b'),
    }),
  });
  let events = await journal.readStage('lessons');
  assert.throws(
    () => assertLegacyRecoveryContractCompatible(events),
    /legacy_runner_recovery_contract_fenced/,
  );
  await journal.acquireLock();
  try {
    for (const step of manifest.steps.slice(0, 2)) {
      await journal.appendStageExpectedSeq(
        'lessons',
        step.expected_seq,
        step.type,
        step.payload,
      );
    }
  } finally {
    await journal.releaseLock();
  }
  const resumed = await resumeRecoveryMigration({ journal, stage: 'lessons' });
  assert.equal(resumed.appended_steps, manifest.steps.length - 2);
  assert.equal((await resumeRecoveryMigration({ journal, stage: 'lessons' })).appended_steps, 0);
  events = await journal.readStage('lessons');
  assert.equal(inspectRecoveryMigrationGate(events).state, 'migrated');
  const reduced = reduceRecoveryJournal(events);
  assert.equal(reduced.units.get('lesson-b').terminal, 'skipped');
  assert.equal(reduced.run.acceptance_ready, false);
  assert.equal(reduced.completed, false);
  assert.equal(events.filter((event) => event.type === 'unit_resolution').length, 1);
});

test('migration reenters after every manifest append boundary', async (context) => {
  const roots = [];
  context.after(async () => {
    await Promise.all(roots.map((rootDir) =>
      fs.rm(rootDir, { recursive: true, force: true })));
  });
  let stepCount;
  for (let completedSteps = 0; completedSteps <= (stepCount ?? 0); completedSteps += 1) {
    const { rootDir, journal } = await fixture(
      `agentmemory-migration-every-boundary-${completedSteps}`,
    );
    roots.push(rootDir);
    const manifest = buildRecoveryMigrationManifest({
      runId: 'migration-run',
      stage: 'lessons',
      events: await journal.readStage('lessons'),
      safeEvidenceByUnit: { 'lesson-b': zeroEffectEvidence('lesson-b') },
      ...MIGRATION_METADATA,
    });
    stepCount ??= manifest.steps.length;
    assert.equal(manifest.steps.length, stepCount);
    await appendRecoveryContractFence({
      journal,
      stage: 'lessons',
      manifest,
      verifyOfflineWritersAbsent: async () => ({
        oldRunnerAbsent: true,
        writerLockAbsent: true,
        otherWritersAbsent: true,
      }),
      verifyEvidenceProvenance: testOnlyTrustedEvidenceVerifier({
        'lesson-b': zeroEffectEvidence('lesson-b'),
      }),
    });
    await journal.acquireLock();
    try {
      for (const step of manifest.steps.slice(0, completedSteps)) {
        await journal.appendStageExpectedSeq(
          'lessons',
          step.expected_seq,
          step.type,
          step.payload,
        );
      }
    } finally {
      await journal.releaseLock();
    }

    const resumed = await resumeRecoveryMigration({ journal, stage: 'lessons' });
    assert.equal(resumed.appended_steps, manifest.steps.length - completedSteps);
    assert.equal((await resumeRecoveryMigration({
      journal,
      stage: 'lessons',
    })).appended_steps, 0);
    assert.equal(
      inspectRecoveryMigrationGate(await journal.readStage('lessons')).state,
      'migrated',
    );
  }
});

realIiiTest('migration appends recovery events without rewriting legacy events receipts or business records', async (context) => {
  const rootDir = await fs.mkdtemp(path.join(
    os.tmpdir(),
    'agentmemory-migration-real-read-only-',
  ));
  context.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  const fixtureState = await createRealLegacyLessonSnapshotFixture({
    root: rootDir,
    enginePath: OFFICIAL_ENGINE_PATH,
  });
  const legacyJournalBytes = await fs.readFile(fixtureState.journalPath);
  const sourceStateBytes = await readFileTreeBytes(fixtureState.stateDir);
  const snapshotStateBytes = await readFileTreeBytes(path.join(
    fixtureState.snapshotDir,
    'state',
  ));
  const beforeSnapshot = await verifyOfflineStateKvSnapshot({
    snapshotDir: fixtureState.snapshotDir,
  });
  const verifier = createLegacyLessonEvidenceProvenanceVerifier({
    snapshotDir: fixtureState.snapshotDir,
    openReadOnlyWorkingCopy: openIiiStateReadOnlyWorkingCopy,
  });
  const evidenceProof = await verifier(fixtureState.request);
  const scopeProofs = new Map(
    evidenceProof.safeEvidenceByUnit[REAL_LEGACY_LESSON_UNIT_ID]
      .safe_facts.collection.scope_proofs
      .map((proof) => [proof.scope, proof]),
  );
  assert.equal(scopeProofs.get(fixtureState.scopes.receipt)?.exact_count, 1);
  assert.equal(
    scopeProofs.get(fixtureState.scopes.businessRecords)?.exact_count,
    1,
  );
  assert.deepEqual(
    await readFileTreeBytes(fixtureState.stateDir),
    sourceStateBytes,
  );
  assert.deepEqual(
    await readFileTreeBytes(path.join(fixtureState.snapshotDir, 'state')),
    snapshotStateBytes,
  );

  const inputPath = path.join(rootDir, 'caller-evidence.json');
  await fs.writeFile(inputPath, JSON.stringify({
    safeEvidenceByUnit: evidenceProof.safeEvidenceByUnit,
  }));
  let fenceOutput = '';
  await runMigrationCli(migrationCliArgs({
    command: 'fence',
    rootDir,
    inputPath,
    snapshotPath: fixtureState.snapshotDir,
  }), {
    writeOutput: (value) => {
      fenceOutput += value;
    },
  });
  let migrateOutput = '';
  await runMigrationCli([
    'migrate',
    '--run-root', rootDir,
    '--run-id', 'migration-run',
    '--stage', 'lessons',
  ], {
    writeOutput: (value) => {
      migrateOutput += value;
    },
  });

  const migratedJournalBytes = await fs.readFile(fixtureState.journalPath);
  assert.equal(migratedJournalBytes.length > legacyJournalBytes.length, true);
  assert.deepEqual(
    migratedJournalBytes.subarray(0, legacyJournalBytes.length),
    legacyJournalBytes,
  );
  assert.deepEqual(
    await readFileTreeBytes(fixtureState.stateDir),
    sourceStateBytes,
  );
  assert.deepEqual(
    await readFileTreeBytes(path.join(fixtureState.snapshotDir, 'state')),
    snapshotStateBytes,
  );
  const afterSnapshot = await verifyOfflineStateKvSnapshot({
    snapshotDir: fixtureState.snapshotDir,
  });
  assert.equal(afterSnapshot.snapshot_hash, beforeSnapshot.snapshot_hash);
  assert.equal(afterSnapshot.state_tree_hash, beforeSnapshot.state_tree_hash);
  assert.deepEqual(
    (await fs.readdir(rootDir, { withFileTypes: true }))
      .filter((entry) => (
        entry.isDirectory()
        && entry.name.startsWith('.iii-state-read-only-runtime-')
      ))
      .map((entry) => entry.name),
    [],
  );

  const migratedJournal = new RunStateJournalV2({
    rootDir,
    runId: 'migration-run',
  });
  assert.equal(
    inspectRecoveryMigrationGate(
      await migratedJournal.readStage('lessons'),
    ).state,
    'migrated',
  );
  assert.equal(
    JSON.parse(fenceOutput).fence_seq,
    fixtureState.request.journal_seq + 1,
  );
  assert.equal(JSON.parse(migrateOutput).completed_steps > 0, true);
});

test('migration implementation uses only declared append journal capabilities', async (context) => {
  const { rootDir, journal } = await fixture('agentmemory-migration-append-only');
  context.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  const legacyEvents = await journal.readStage('lessons');
  const allowedJournalCapabilities = new Set([
    'runId',
    'lockPath',
    'acquireLock',
    'releaseLock',
    'readStage',
    'appendStageExpectedSeq',
  ]);
  const accessedJournalCapabilities = new Set();
  const migrationJournal = new Proxy(journal, {
    get(target, property) {
      assert.equal(
        allowedJournalCapabilities.has(property),
        true,
        `migration accessed undeclared journal capability: ${String(property)}`,
      );
      accessedJournalCapabilities.add(property);
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const manifest = buildRecoveryMigrationManifest({
    runId: 'migration-run',
    stage: 'lessons',
    events: legacyEvents,
    safeEvidenceByUnit: { 'lesson-b': zeroEffectEvidence('lesson-b') },
    ...MIGRATION_METADATA,
  });

  await appendRecoveryContractFence({
    journal: migrationJournal,
    stage: 'lessons',
    manifest,
    verifyOfflineWritersAbsent: async () => ({
      oldRunnerAbsent: true,
      writerLockAbsent: true,
      otherWritersAbsent: true,
    }),
    verifyEvidenceProvenance: testOnlyTrustedEvidenceVerifier({
      'lesson-b': zeroEffectEvidence('lesson-b'),
    }),
  });
  await resumeRecoveryMigration({ journal: migrationJournal, stage: 'lessons' });

  assert.deepEqual(
    (await journal.readStage('lessons')).slice(0, legacyEvents.length),
    legacyEvents,
  );
  assert.deepEqual(
    [...accessedJournalCapabilities].sort(),
    [...allowedJournalCapabilities].sort(),
  );
});

test('all eight legacy stage evidence adapters fail closed on unproved effects', () => {
  for (const stage of EFFECT_STATE_RECOVERY_STAGES) {
    const unitId = `${stage}-unit`;
    const attemptId = `${stage}-attempt`;
    const manifest = buildRecoveryMigrationManifest({
      runId: 'migration-run',
      stage,
      events: [
        {
          seq: 0,
          type: 'unit_planned',
          payload: { unit_id: unitId, input_hash: 'a'.repeat(64) },
        },
        {
          seq: 1,
          type: 'stage_plan_completed',
          payload: { unit_count: 1 },
        },
        {
          seq: 2,
          type: 'unit_started',
          payload: { unit_id: unitId, attempt_id: attemptId },
        },
        {
          seq: 3,
          type: 'unit_terminal',
          payload: {
            unit_id: unitId,
            attempt_id: attemptId,
            status: 'failed',
          },
        },
      ],
      safeEvidenceByUnit: {
        [unitId]: {
          adapter: `${stage}/legacy-safe-facts-v1`,
          attempt_id: attemptId,
          operation_id: `${unitId}:legacy`,
          safe_facts: { failure: { cause: 'response_lost' } },
        },
      },
      ...MIGRATION_METADATA,
    });
    assert.equal(manifest.entries[0].evidence.kind, 'unknown', stage);
    assert.equal(manifest.entries[0].decision.action, 'reconcile', stage);
    assert.equal(
      manifest.steps.some((step) => (
        step.type === 'unit_resolution'
        && step.payload.unit_id === unitId
      )),
      false,
      stage,
    );
  }
});

test('lesson_no_blocks migration requires and preserves a closed zero-effect proof', async (context) => {
  const { rootDir, journal } = await fixture(
    'agentmemory-migration-lesson-no-blocks-proof',
  );
  context.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  const evidence = zeroEffectEvidence('lesson-b');
  const unsafeEvidence = structuredClone(evidence);
  unsafeEvidence.safe_facts.formalLessonWrites.push({
    sourceRunId: 'lesson-b-run',
  });
  const unsafeManifest = buildRecoveryMigrationManifest({
    runId: 'migration-run',
    stage: 'lessons',
    events: await journal.readStage('lessons'),
    safeEvidenceByUnit: { 'lesson-b': unsafeEvidence },
    ...MIGRATION_METADATA,
  });
  assert.equal(unsafeManifest.entries[0].decision.action, 'reconcile');
  assert.equal(
    unsafeManifest.steps.some((step) => step.type === 'unit_resolution'),
    false,
  );

  const manifest = buildRecoveryMigrationManifest({
    runId: 'migration-run',
    stage: 'lessons',
    events: await journal.readStage('lessons'),
    safeEvidenceByUnit: { 'lesson-b': evidence },
    ...MIGRATION_METADATA,
  });
  assert.deepEqual(manifest.entries[0].evidence.proof, {
    kind: 'legacy_lessons_zero_effect',
    lessonRunId: 'lesson-b-run',
    receiptKey: evidence.safe_facts.receipt.key,
    inputHash: 'a'.repeat(64),
    configHash: 'b'.repeat(64),
    createdLessonCount: 0,
    replacedLessonCount: 0,
    chunkLessonCount: 0,
    finishedAt: '2026-07-30T00:00:00.000Z',
  });
  assert.equal(manifest.entries[0].decision.action, 'skipped');
  await appendRecoveryContractFence({
    journal,
    stage: 'lessons',
    manifest,
    verifyOfflineWritersAbsent: async () => ({
      oldRunnerAbsent: true,
      writerLockAbsent: true,
      otherWritersAbsent: true,
    }),
    verifyEvidenceProvenance: testOnlyTrustedEvidenceVerifier({
      'lesson-b': evidence,
    }),
  });
  await resumeRecoveryMigration({ journal, stage: 'lessons' });
  const migratedEvents = await journal.readStage('lessons');
  assert.equal(
    reduceRecoveryJournal(migratedEvents).units.get('lesson-b').terminal,
    'skipped',
  );
  assert.equal(
    migratedEvents.filter((event) => event.type === 'unit_resolution').length,
    1,
  );
});

test('preview rejects caller-authored evidence and derives unknown evidence through the adapter', async (context) => {
  const { rootDir, journal } = await fixture('agentmemory-migration-proof');
  context.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  const events = await journal.readStage('lessons');
  assert.throws(
    () => buildRecoveryMigrationManifest({
      runId: 'migration-run',
      stage: 'lessons',
      events,
      safeEvidenceByUnit: {
        'lesson-b': {
          evidence: {
            kind: 'no_effect',
            observation: 'business_empty',
            reasonCode: 'lesson_no_blocks',
          },
        },
      },
      ...MIGRATION_METADATA,
    }),
    /recovery_migration_verifiable_adapter_required/,
  );
  assert.throws(
    () => buildRecoveryMigrationManifest({
      runId: 'migration-run',
      stage: 'lessons',
      events,
      safeEvidenceByUnit: {
        'lesson-b': {
          adapter: 'lessons/legacy-safe-facts-v1',
          attempt_id: 'lesson-b-attempt',
          operation_id: 'lesson-b:legacy',
          safe_facts: {
            lessonEvidence: {
              kind: 'no_effect',
              observation: 'business_empty',
              reasonCode: 'lesson_no_blocks',
              proof: {
                kind: 'legacy_lessons_zero_effect',
                lessonRunId: 'forged',
                receiptKey: 'forged',
                inputHash: 'a'.repeat(64),
                configHash: 'b'.repeat(64),
                createdLessonCount: 0,
                replacedLessonCount: 0,
                chunkLessonCount: 0,
                finishedAt: '2026-07-30T00:00:00.000Z',
              },
            },
          },
        },
      },
      ...MIGRATION_METADATA,
    }),
    /recovery_migration_caller_authored_structured_evidence_forbidden/,
  );
  const manifest = buildRecoveryMigrationManifest({
    runId: 'migration-run',
    stage: 'lessons',
    events,
    safeEvidenceByUnit: {
      'lesson-b': {
        adapter: 'lessons/legacy-safe-facts-v1',
        attempt_id: 'lesson-b-attempt',
        operation_id: 'lesson-b:legacy',
        safe_facts: { failure: { cause: 'response_lost' } },
      },
    },
    ...MIGRATION_METADATA,
  });
  assert.equal(manifest.entries[0].decision.action, 'reconcile');
  assert.equal(
    manifest.steps.some((step) => (
      step.type === 'unit_resolution' && step.payload.status === 'skipped'
    )),
    false,
  );
});

test('preview excludes never-started units, includes retry and committing facts, and derives retry attempt from the journal', () => {
  const retryEvidence = {
    kind: 'no_effect',
    observation: 'execution_error',
    reasonCode: 'provider_unavailable',
    proof: {
      kind: 'request_not_dispatched',
      attemptId: 'retry-attempt',
      journalSeq: 3,
    },
  };
  const retryBudget = { attemptsUsed: 1, maxAttempts: 5 };
  const retryDecision = decideRecovery({
    policyVersion: RECOVERY_POLICY_VERSION,
    evidence: retryEvidence,
    budget: retryBudget,
  });
  const committingEvidence = {
    kind: 'committing',
    commitPlanRef: 'lesson-commit-plans:commit-c',
    effectHash: 'd'.repeat(64),
  };
  const committingDecision = decideRecovery({
    policyVersion: RECOVERY_POLICY_VERSION,
    evidence: committingEvidence,
  });
  const events = [
    { seq: 0, type: 'unit_planned', payload: { unit_id: 'planned-a' } },
    { seq: 1, type: 'unit_planned', payload: { unit_id: 'retry-b' } },
    { seq: 2, type: 'unit_planned', payload: { unit_id: 'commit-c' } },
    { seq: 3, type: 'stage_plan_completed', payload: { unit_count: 3 } },
    {
      seq: 4,
      type: 'unit_attempt_started',
      payload: {
        unit_id: 'retry-b',
        attempt_id: 'retry-attempt',
        attempt_number: 7,
      },
    },
    {
      seq: 5,
      type: 'unit_operation_started',
      payload: {
        unit_id: 'retry-b',
        attempt_id: 'retry-attempt',
        operation_id: 'retry-b:operation',
      },
    },
    {
      seq: 6,
      type: 'unit_outcome_observed',
      payload: {
        unit_id: 'retry-b',
        attempt_id: 'retry-attempt',
        operation_id: 'retry-b:operation',
        policy_version: RECOVERY_POLICY_VERSION,
        evidence: retryEvidence,
        budget: retryBudget,
        decision: retryDecision,
      },
    },
    {
      seq: 7,
      type: 'unit_retry_scheduled',
      payload: {
        unit_id: 'retry-b',
        attempt_id: 'retry-attempt',
        operation_id: 'retry-b:operation',
        policy_version: RECOVERY_POLICY_VERSION,
        evidence: retryEvidence,
        budget: retryBudget,
        decision: retryDecision,
        attempts_used: 2,
        max_attempts: 5,
        attempt_number: 8,
        retry_at: '2026-07-30T00:01:00.000Z',
      },
    },
    {
      seq: 8,
      type: 'unit_attempt_started',
      payload: {
        unit_id: 'commit-c',
        attempt_id: 'commit-attempt',
        attempt_number: 3,
      },
    },
    {
      seq: 9,
      type: 'unit_operation_started',
      payload: {
        unit_id: 'commit-c',
        attempt_id: 'commit-attempt',
        operation_id: 'commit-c:operation',
      },
    },
    {
      seq: 10,
      type: 'unit_outcome_observed',
      payload: {
        unit_id: 'commit-c',
        attempt_id: 'commit-attempt',
        operation_id: 'commit-c:operation',
        policy_version: RECOVERY_POLICY_VERSION,
        evidence: committingEvidence,
        decision: committingDecision,
      },
    },
    {
      seq: 11,
      type: 'unit_commit_resumed',
      payload: {
        unit_id: 'commit-c',
        attempt_id: 'commit-attempt',
        operation_id: 'commit-c:operation',
        policy_version: RECOVERY_POLICY_VERSION,
        evidence: committingEvidence,
        decision: committingDecision,
      },
    },
  ];
  const manifest = buildRecoveryMigrationManifest({
    runId: 'migration-run',
    stage: 'lessons',
    events,
    safeEvidenceByUnit: {},
    ...MIGRATION_METADATA,
  });
  assert.deepEqual(manifest.entries.map((entry) => entry.unit_id), [
    'commit-c',
    'retry-b',
  ]);
  const retryEntry = manifest.entries.find((entry) => entry.unit_id === 'retry-b');
  assert.equal(retryEntry.current_attempt_number, 7);
  const retryStep = manifest.steps.find((step) => (
    step.type === 'unit_retry_scheduled'
    && step.payload.unit_id === 'retry-b'
  ));
  assert.equal(retryStep.payload.attempts_used, 2);
  assert.equal(retryStep.payload.attempt_number, 8);
});

test('migration repairs a legacy prepare identity before appending recovery evidence', () => {
  const events = [
    { seq: 0, type: 'unit_planned', payload: { unit_id: 'lesson-p' } },
    { seq: 1, type: 'stage_plan_completed', payload: { unit_count: 1 } },
    {
      seq: 2,
      type: 'unit_prepare_started',
      payload: { unit_id: 'lesson-p', attempt_id: 'prepare-attempt' },
    },
    {
      seq: 3,
      type: 'unit_prepared',
      payload: { unit_id: 'lesson-p', attempt_id: 'prepare-attempt' },
    },
  ];
  const manifest = buildRecoveryMigrationManifest({
    runId: 'migration-run',
    stage: 'lessons',
    events,
    safeEvidenceByUnit: {
      'lesson-p': {
        adapter: 'lessons/legacy-safe-facts-v1',
        attempt_id: 'prepare-attempt',
        operation_id: 'lesson-p:legacy',
        safe_facts: { failure: { cause: 'response_lost' } },
      },
    },
    ...MIGRATION_METADATA,
  });
  const attemptStep = manifest.steps.find((step) => (
    step.type === 'unit_attempt_started'
  ));
  assert.equal(attemptStep.payload.attempt_id, 'prepare-attempt');
  const migrated = [
    ...events,
    {
      seq: manifest.fence_seq,
      type: 'stage_recovery_contract_fenced',
      payload: manifest,
    },
    ...manifest.steps.map((step) => ({
      seq: step.expected_seq + 1,
      type: step.type,
      payload: step.payload,
    })),
  ];
  assert.equal(
    reduceRecoveryJournal(migrated).units.get('lesson-p').recovery.state,
    'reconciling',
  );
});

test('preview rejects recovery contract versions and hashes unsupported by the runner', async (context) => {
  const { rootDir, journal } = await fixture('agentmemory-migration-contract');
  context.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  const input = {
    runId: 'migration-run',
    stage: 'lessons',
    events: await journal.readStage('lessons'),
    safeEvidenceByUnit: { 'lesson-b': zeroEffectEvidence('lesson-b') },
    ...MIGRATION_METADATA,
  };
  assert.throws(
    () => buildRecoveryMigrationManifest({
      ...input,
      targetContractVersion: `${RECOVERY_POLICY_VERSION}-future`,
    }),
    /recovery_migration_contract_unsupported/,
  );
  assert.throws(
    () => buildRecoveryMigrationManifest({
      ...input,
      recoveryPolicyHash: `${
        RECOVERY_POLICY_HASH[0] === '0' ? '1' : '0'
      }${RECOVERY_POLICY_HASH.slice(1)}`,
    }),
    /recovery_migration_contract_unsupported/,
  );
});

test('manifest validation rejects target-contract and completion-count tampering', async (context) => {
  const { rootDir, journal } = await fixture('agentmemory-migration-tamper');
  context.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  const manifest = buildRecoveryMigrationManifest({
    runId: 'migration-run',
    stage: 'lessons',
    events: await journal.readStage('lessons'),
    safeEvidenceByUnit: { 'lesson-b': zeroEffectEvidence('lesson-b') },
    ...MIGRATION_METADATA,
  });
  const future = structuredClone(manifest);
  future.target_contract_version = `${RECOVERY_POLICY_VERSION}-future`;
  assert.throws(
    () => validateRecoveryMigrationManifest(future),
    /recovery_migration_manifest_invalid/,
  );

  const countTampered = structuredClone(manifest);
  const completed = countTampered.steps.at(-1);
  completed.payload.actual_processed_count += 1;
  const { step_hash: _stepHash, ...stepCore } = completed;
  completed.step_hash = hashRecoveryValue(stepCore);
  assert.throws(
    () => validateRecoveryMigrationManifest(countTampered),
    /recovery_migration_completed_count_or_hash_mismatch/,
  );
});
