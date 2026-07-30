import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RunStateJournalV2 } from './lib/run-state-journal-v2.mjs';
import {
  appendRecoveryContractFence,
  buildRecoveryMigrationManifest,
  readSafeMigrationInput,
  resumeRecoveryMigration,
} from './lib/recovery-frontier-migration-v1.mjs';
import {
  hashRecoveryValue,
} from './lib/recovery-migration-contract-v1.mjs';
import {
  createLegacyLessonEvidenceProvenanceVerifier,
} from './lib/legacy-lesson-safe-facts-collector-v1.mjs';
import {
  openIiiStateReadOnlyWorkingCopy,
} from './lib/iii-state-read-only-adapter-v1.mjs';

function takeValue(argv, index, argument) {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${argument} requires a value`);
  }
  return value;
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (['preview', 'fence', 'migrate'].includes(argument) && !options.command) {
      options.command = argument;
    } else if (argument === '--run-root') options.runRoot = argv[++index];
    else if (argument === '--run-id') options.runId = argv[++index];
    else if (argument === '--stage') options.stage = argv[++index];
    else if (argument === '--safe-evidence') options.safeEvidence = argv[++index];
    else if (argument === '--evidence-snapshot') {
      if (options.evidenceSnapshot) {
        throw new Error('--evidence-snapshot may be provided only once');
      }
      options.evidenceSnapshot = takeValue(argv, index, argument);
      index += 1;
    }
    else if (argument === '--original-contract-version') {
      options.originalContractVersion = argv[++index];
    } else if (argument === '--target-contract-version') {
      options.targetContractVersion = argv[++index];
    } else if (argument === '--original-policy-version') {
      options.originalPolicyVersion = argv[++index];
    } else if (argument === '--target-policy-version') {
      options.targetPolicyVersion = argv[++index];
    } else if (argument === '--upgrade-at') options.upgradeAt = argv[++index];
    else if (argument === '--authorized-at') options.authorizedAt = argv[++index];
    else if (argument === '--authorization-source-type') {
      options.authorizationSourceType = argv[++index];
    }
    else if (argument === '--confirm-old-runner-absent') options.oldRunnerAbsent = true;
    else if (argument === '--confirm-other-writers-absent') options.otherWritersAbsent = true;
    else throw new Error(`unknown argument: ${argument}`);
  }
  if (!['preview', 'fence', 'migrate'].includes(options.command)) {
    throw new Error('command is required: preview, fence, or migrate');
  }
  if (!options.runRoot || !path.isAbsolute(options.runRoot)) {
    throw new Error('--run-root must be absolute');
  }
  if (!/^[A-Za-z0-9._-]+$/.test(options.runId || '')) {
    throw new Error('--run-id is invalid');
  }
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(options.stage || '')) {
    throw new Error('--stage is invalid');
  }
  if (options.command !== 'migrate' && !options.safeEvidence) {
    throw new Error('--safe-evidence is required');
  }
  if (
    options.evidenceSnapshot
    && !path.isAbsolute(options.evidenceSnapshot)
  ) {
    throw new Error('--evidence-snapshot must be absolute');
  }
  if (options.command === 'migrate' && options.evidenceSnapshot) {
    throw new Error('--evidence-snapshot is not valid for migrate');
  }
  if (
    options.command !== 'fence'
    && (options.oldRunnerAbsent || options.otherWritersAbsent)
  ) {
    throw new Error('writer confirmations are valid only for fence');
  }
  if (options.command !== 'migrate') {
    for (const [flag, value] of [
      ['--original-contract-version', options.originalContractVersion],
      ['--target-contract-version', options.targetContractVersion],
      ['--original-policy-version', options.originalPolicyVersion],
      ['--target-policy-version', options.targetPolicyVersion],
      ['--upgrade-at', options.upgradeAt],
      ['--authorized-at', options.authorizedAt],
      ['--authorization-source-type', options.authorizationSourceType],
    ]) {
      if (!value) throw new Error(`${flag} is required`);
    }
  }
  return options;
}

function manifestInput(options, events, safeEvidenceByUnit) {
  return {
    runId: options.runId,
    stage: options.stage,
    events,
    safeEvidenceByUnit,
    originalContractVersion: options.originalContractVersion,
    targetContractVersion: options.targetContractVersion,
    originalPolicyVersion: options.originalPolicyVersion,
    targetPolicyVersion: options.targetPolicyVersion,
    upgradeAt: options.upgradeAt,
    authorizedAt: options.authorizedAt,
    authorizationSourceType: options.authorizationSourceType,
  };
}

async function preview(options, journal) {
  const evidence = await readSafeMigrationInput(options.safeEvidence);
  const events = await journal.readStage(options.stage);
  return {
    evidence,
    events,
    manifest: buildRecoveryMigrationManifest(manifestInput(
      options,
      events,
      evidence.safeEvidenceByUnit,
    )),
  };
}

function externalUnits(manifest) {
  return manifest.entries
    .filter((entry) => (
      entry.adapter_provenance.source_type === 'caller_json_preview'
    ))
    .map((entry) => entry.unit_id)
    .sort((left, right) => left.localeCompare(right, 'en'));
}

function defaultCreateEvidenceVerifier(snapshotDir) {
  return createLegacyLessonEvidenceProvenanceVerifier({
    snapshotDir,
    openReadOnlyWorkingCopy: openIiiStateReadOnlyWorkingCopy,
  });
}

async function verifyPreviewEvidence({
  options,
  events,
  manifest,
  verifyEvidenceProvenance,
}) {
  const units = externalUnits(manifest);
  if (units.length === 0) {
    return {
      schema: 'recovery-migration-preview-evidence-verification/v1',
      state: 'not_required',
      verified_unit_count: 0,
      verified_units_hash: hashRecoveryValue([]),
      manifest_hash: manifest.manifest_hash,
    };
  }
  const request = {
    run_id: manifest.run_id,
    stage: manifest.stage,
    journal_seq: manifest.journal_seq,
    input_summary_hash: manifest.input_summary_hash,
    units,
  };
  const proof = await verifyEvidenceProvenance(request);
  const suppliedUnits = Object.keys(proof?.safeEvidenceByUnit || {})
    .sort((left, right) => left.localeCompare(right, 'en'));
  if (
    proof?.source_type !== 'trusted_read_only_collector'
    || JSON.stringify(suppliedUnits) !== JSON.stringify(units)
  ) {
    throw new Error('recovery_migration_cli_preview_evidence_unverified');
  }
  let rebuilt;
  try {
    rebuilt = buildRecoveryMigrationManifest(manifestInput(
      options,
      events,
      proof.safeEvidenceByUnit,
    ));
  } catch {
    throw new Error('recovery_migration_cli_preview_evidence_unverified');
  }
  if (rebuilt.manifest_hash !== manifest.manifest_hash) {
    throw new Error('recovery_migration_cli_preview_evidence_mismatch');
  }
  const collector = proof.collector_provenance;
  if (
    collector?.schema !== 'legacy-lesson-safe-facts-provenance/v1'
    || !/^[0-9a-f]{64}$/.test(String(collector.snapshot_hash || ''))
    || !/^[0-9a-f]{64}$/.test(String(collector.engine_hash || ''))
  ) {
    throw new Error('recovery_migration_cli_preview_evidence_unverified');
  }
  return {
    schema: 'recovery-migration-preview-evidence-verification/v1',
    state: 'independently_verified',
    source_type: proof.source_type,
    verified_unit_count: units.length,
    verified_units_hash: hashRecoveryValue(units),
    manifest_hash: manifest.manifest_hash,
    snapshot_hash: collector.snapshot_hash,
    engine_hash: collector.engine_hash,
  };
}

export async function main(
  argv = process.argv.slice(2),
  {
    createJournal = (options) => new RunStateJournalV2({
      rootDir: path.resolve(options.runRoot),
      runId: options.runId,
    }),
    createEvidenceVerifier = defaultCreateEvidenceVerifier,
    writeOutput = (value) => process.stdout.write(value),
  } = {},
) {
  const options = parseArgs(argv);
  const journal = createJournal(options);
  if (options.command === 'preview') {
    const result = await preview(options, journal);
    let output = result.manifest;
    if (options.evidenceSnapshot) {
      const verifyEvidenceProvenance = createEvidenceVerifier(
        path.resolve(options.evidenceSnapshot),
      );
      output = {
        ...result.manifest,
        evidence_verification: await verifyPreviewEvidence({
          options,
          events: result.events,
          manifest: result.manifest,
          verifyEvidenceProvenance,
        }),
      };
    }
    writeOutput(`${JSON.stringify(output, null, 2)}\n`);
    return 0;
  }
  if (options.command === 'fence') {
    const result = await preview(options, journal);
    const units = externalUnits(result.manifest);
    if (units.length > 0 && !options.evidenceSnapshot) {
      throw new Error('--evidence-snapshot is required for external evidence');
    }
    const verifyEvidenceProvenance = options.evidenceSnapshot
      ? createEvidenceVerifier(path.resolve(options.evidenceSnapshot))
      : undefined;
    await appendRecoveryContractFence({
      journal,
      stage: options.stage,
      manifest: result.manifest,
      verifyOfflineWritersAbsent: async () => ({
        oldRunnerAbsent: options.oldRunnerAbsent === true,
        writerLockAbsent: true,
        otherWritersAbsent: options.otherWritersAbsent === true,
      }),
      verifyEvidenceProvenance,
    });
    writeOutput(`${JSON.stringify({
      migration_id: result.manifest.migration_id,
      manifest_hash: result.manifest.manifest_hash,
      fence_seq: result.manifest.journal_seq + 1,
    })}\n`);
    return 0;
  }
  writeOutput(`${JSON.stringify(await resumeRecoveryMigration({
    journal,
    stage: options.stage,
  }))}\n`);
  return 0;
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (path.resolve(fileURLToPath(import.meta.url)) === invoked) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    },
  );
}
