import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  assertEffectStateRecoveryReleaseInputs,
  assertEvidenceExecutionResult,
  assertCanonicalV1RiskMapping,
  EFFECT_STATE_RECOVERY_REQUIRED_CATALOG_SHA256,
  EFFECT_STATE_RECOVERY_REQUIRED_OBLIGATIONS,
  EFFECT_STATE_RECOVERY_STAGES,
  EFFECT_STATE_RECOVERY_TRUSTED_EVIDENCE,
  EFFECT_STATE_RECOVERY_V1_CANONICAL_RISKS,
  EFFECT_STATE_RECOVERY_V1_CANONICAL_RISKS_SHA256,
  EFFECT_STATE_RECOVERY_V1_RISK_MAPPING,
  EFFECT_STATE_RECOVERY_V1_RISK_MAPPING_SHA256,
} from './effect-state-recovery-release-gate-v2.mjs';

const requiredIds =
  EFFECT_STATE_RECOVERY_REQUIRED_OBLIGATIONS.map(({ id }) => id);

function obligationCases(obligationIds, prefix) {
  return obligationIds.map((obligationId) => ({
    obligation_id: obligationId,
    expected_test_titles: [`${prefix}: ${obligationId}`],
  }));
}

function evidenceTitles(evidence) {
  return [
    ...new Set(evidence.obligation_cases.flatMap(
      ({ expected_test_titles: expectedTestTitles }) => expectedTestTitles,
    )),
  ];
}

function completeCatalog(testPath = 'test/trusted-complete.test.ts') {
  const realIiiIds = EFFECT_STATE_RECOVERY_REQUIRED_OBLIGATIONS
    .filter(({ layer }) => layer === 'real_iii')
    .map(({ id }) => id);
  const subprocessIds = EFFECT_STATE_RECOVERY_REQUIRED_OBLIGATIONS
    .filter(({ layer }) => layer === 'subprocess_runtime')
    .map(({ id }) => id);
  const regularIds = requiredIds.filter((id) =>
    !realIiiIds.includes(id) && !subprocessIds.includes(id));
  return [
    {
      id: 'trusted-complete-obligations',
      test_path: testPath,
      runner: 'vitest',
      obligation_cases: obligationCases(regularIds, 'complete obligation'),
    },
    {
      id: 'trusted-complete-subprocess-obligations',
      test_path: 'test/trusted-complete-subprocess.test.mjs',
      runner: 'node-subprocess',
      obligation_cases: obligationCases(
        subprocessIds,
        'complete subprocess obligation',
      ),
    },
    {
      id: 'trusted-complete-real-iii-obligations',
      test_path: 'test/trusted-complete-real-iii.test.ts',
      runner: 'vitest-real-iii',
      obligation_cases: obligationCases(
        realIiiIds,
        'complete real III obligation',
      ),
    },
  ];
}

function manifestForCatalog(catalog, complete) {
  const coveredIds = [
    ...new Set(catalog.flatMap((evidence) =>
      evidence.obligation_cases.map(({ obligation_id: obligationId }) =>
        obligationId))),
  ];
  return {
    schema_version: 'effect-state-recovery-release-proof/v2',
    complete,
    requirements: {
      stages: [...EFFECT_STATE_RECOVERY_STAGES],
      legacy_v1_risk_mapping_sha256:
        EFFECT_STATE_RECOVERY_V1_RISK_MAPPING_SHA256,
      legacy_v1_risk_catalog_sha256:
        EFFECT_STATE_RECOVERY_V1_CANONICAL_RISKS_SHA256,
      obligations: EFFECT_STATE_RECOVERY_REQUIRED_OBLIGATIONS.map((item) => ({
        id: item.id,
        layer: item.layer,
        applies_to: [...item.applies_to],
      })),
    },
    coverage: {
      obligations: {
        required_catalog_sha256:
          EFFECT_STATE_RECOVERY_REQUIRED_CATALOG_SHA256,
        required_count: requiredIds.length,
        covered_ids: coveredIds,
        missing_ids: requiredIds.filter((id) => !coveredIds.includes(id)),
      },
    },
    evidence: catalog.map((evidence) => ({
      id: evidence.id,
      test_path: evidence.test_path,
      runner: evidence.runner,
      obligation_cases: evidence.obligation_cases.map((obligationCase) => ({
        obligation_id: obligationCase.obligation_id,
        expected_test_titles: [...obligationCase.expected_test_titles],
      })),
    })),
  };
}

async function fixture({
  catalog = completeCatalog(),
  complete = true,
} = {}) {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'effect-recovery-release-gate-'),
  );
  const enginePath = path.join(root, 'iii-engine');
  const proofPath = path.join(root, 'proof.json');
  const engine = Buffer.from('pinned-test-engine');
  await fs.writeFile(enginePath, engine);
  for (const evidence of catalog) {
    const testPath = path.join(root, evidence.test_path);
    await fs.mkdir(path.dirname(testPath), { recursive: true });
    await fs.writeFile(testPath, 'export {};\n');
  }
  await fs.writeFile(
    proofPath,
    JSON.stringify(manifestForCatalog(catalog, complete)),
  );
  return {
    catalog,
    root,
    enginePath,
    proofPath,
    engineHash: createHash('sha256').update(engine).digest('hex'),
  };
}

test('risk obligations inherit shared evidence without an eight-stage cross product', () => {
  const shared = EFFECT_STATE_RECOVERY_REQUIRED_OBLIGATIONS.filter(
    ({ layer }) => layer === 'shared_protocol' || layer === 'shared_storage',
  );
  assert.equal(EFFECT_STATE_RECOVERY_REQUIRED_OBLIGATIONS.length, 85);
  assert.equal(shared.length, 19);
  assert.deepEqual(EFFECT_STATE_RECOVERY_STAGES, [
    'summary',
    'lessons',
    'memory_consolidate',
    'semantic_rollup',
    'skill_extract',
    'crystal',
    'consolidation_procedural',
    'reflect_insight',
  ]);
  for (const item of shared) {
    assert.deepEqual(item.applies_to, EFFECT_STATE_RECOVERY_STAGES);
  }
  assert.equal(requiredIds.filter((id) =>
    id.startsWith('integration::')).length, 12);
  assert.equal(requiredIds.filter((id) =>
    id.startsWith('migration::')).length, 10);
  assert.equal(requiredIds.filter((id) =>
    id.startsWith('lessons_concurrency::')).length, 5);
  assert.equal(requiredIds.filter((id) =>
    id.startsWith('projection::')).length, 2);
  assert.equal(requiredIds.filter((id) =>
    id.startsWith('runtime_boundary::')).length, 4);
  assert.deepEqual(
    EFFECT_STATE_RECOVERY_REQUIRED_OBLIGATIONS.find(({ id }) =>
      id === 'migration::lesson_no_blocks_requires_zero_effect_proof')
      ?.applies_to,
    ['lessons'],
  );
});

test('release gate fails closed when the III path is absent', async () => {
  const { catalog, proofPath, root } = await fixture();
  await assert.rejects(
    () => assertEffectStateRecoveryReleaseInputs({
      enginePath: '',
      proofPath,
      repositoryRoot: root,
      trustedEvidenceCatalog: catalog,
    }),
    /effect_state_recovery_release_gate_iii_path_required/,
  );
});

test('release gate rejects an unpinned III binary before executing it', async () => {
  const {
    catalog,
    enginePath,
    proofPath,
    root,
  } = await fixture();
  let versionReads = 0;
  await assert.rejects(
    () => assertEffectStateRecoveryReleaseInputs({
      enginePath,
      proofPath,
      repositoryRoot: root,
      trustedEvidenceCatalog: catalog,
      readVersion: async () => {
        versionReads += 1;
        return '0.11.2';
      },
    }),
    /effect_state_recovery_release_gate_iii_hash_mismatch/,
  );
  assert.equal(versionReads, 0);
});

test('release gate requires every declared evidence test file', async () => {
  const {
    catalog,
    enginePath,
    engineHash,
    proofPath,
    root,
  } = await fixture();
  await fs.rm(path.join(root, catalog[0].test_path));
  await assert.rejects(
    () => assertEffectStateRecoveryReleaseInputs({
      enginePath,
      proofPath,
      repositoryRoot: root,
      trustedEvidenceCatalog: catalog,
      expectedEngineHash: engineHash,
      readVersion: async () => '0.11.2',
    }),
    /effect_state_recovery_release_gate_evidence_test_missing/,
  );
});

test('release gate rejects complete=false before reading the III binary', async () => {
  const {
    enginePath,
    proofPath,
    root,
  } = await fixture({
    catalog: EFFECT_STATE_RECOVERY_TRUSTED_EVIDENCE,
    complete: false,
  });
  let versionReads = 0;
  await assert.rejects(
    () => assertEffectStateRecoveryReleaseInputs({
      enginePath,
      proofPath,
      repositoryRoot: root,
      readVersion: async () => {
        versionReads += 1;
        return '0.11.2';
      },
    }),
    /effect_state_recovery_release_gate_proof_incomplete/,
  );
  assert.equal(versionReads, 0);
});

test('release gate rejects weakened applicability', async () => {
  const {
    catalog,
    enginePath,
    proofPath,
    root,
  } = await fixture();
  const manifest = manifestForCatalog(catalog, true);
  manifest.requirements.obligations[0].applies_to = ['summary'];
  await fs.writeFile(proofPath, JSON.stringify(manifest));
  await assert.rejects(
    () => assertEffectStateRecoveryReleaseInputs({
      enginePath,
      proofPath,
      repositoryRoot: root,
      trustedEvidenceCatalog: catalog,
    }),
    /effect_state_recovery_release_gate_proof_requirements_mismatch/,
  );
});

test('release gate rejects a changed v1 risk mapping', async () => {
  const {
    catalog,
    enginePath,
    proofPath,
    root,
  } = await fixture();
  const manifest = manifestForCatalog(catalog, true);
  manifest.requirements.legacy_v1_risk_mapping_sha256 = '0'.repeat(64);
  await fs.writeFile(proofPath, JSON.stringify(manifest));
  await assert.rejects(
    () => assertEffectStateRecoveryReleaseInputs({
      enginePath,
      proofPath,
      repositoryRoot: root,
      trustedEvidenceCatalog: catalog,
    }),
    /effect_state_recovery_release_gate_proof_requirements_mismatch/,
  );
});

test('v1 risk mapping must preserve the fixed canonical scenario set', () => {
  assert.deepEqual(EFFECT_STATE_RECOVERY_V1_CANONICAL_RISKS, [
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
  assert.doesNotThrow(() =>
    assertCanonicalV1RiskMapping(EFFECT_STATE_RECOVERY_V1_RISK_MAPPING));
  assert.throws(
    () => assertCanonicalV1RiskMapping(
      EFFECT_STATE_RECOVERY_V1_RISK_MAPPING.slice(1),
    ),
    /effect_state_recovery_release_gate_v1_risk_mapping_invalid/,
  );
});

test('release gate rejects complete=true with missing obligations', async () => {
  const catalog = EFFECT_STATE_RECOVERY_TRUSTED_EVIDENCE.map((evidence, index) => ({
    ...evidence,
    obligation_cases: index === 0
      ? evidence.obligation_cases.slice(1)
      : evidence.obligation_cases,
  }));
  const {
    enginePath,
    proofPath,
    root,
  } = await fixture({
    catalog,
    complete: true,
  });
  await assert.rejects(
    () => assertEffectStateRecoveryReleaseInputs({
      enginePath,
      proofPath,
      repositoryRoot: root,
      trustedEvidenceCatalog: catalog,
    }),
    /effect_state_recovery_release_gate_proof_incomplete/,
  );
});

test('release gate requires real III evidence for real III obligations', async () => {
  const catalog = completeCatalog();
  catalog[2] = {
    ...catalog[2],
    runner: 'vitest',
  };
  const {
    enginePath,
    proofPath,
    root,
  } = await fixture({ catalog });
  await assert.rejects(
    () => assertEffectStateRecoveryReleaseInputs({
      enginePath,
      proofPath,
      repositoryRoot: root,
      trustedEvidenceCatalog: catalog,
    }),
    /effect_state_recovery_release_gate_trusted_evidence_invalid/,
  );
});

test('release gate requires subprocess evidence for process-boundary obligations', async () => {
  const catalog = completeCatalog();
  catalog[1] = {
    ...catalog[1],
    runner: 'node',
  };
  const {
    enginePath,
    proofPath,
    root,
  } = await fixture({ catalog });
  await assert.rejects(
    () => assertEffectStateRecoveryReleaseInputs({
      enginePath,
      proofPath,
      repositoryRoot: root,
      trustedEvidenceCatalog: catalog,
    }),
    /effect_state_recovery_release_gate_trusted_evidence_invalid/,
  );
});

test('conjunctive evidence requires every trusted file for a shared obligation', async () => {
  const catalog = completeCatalog();
  catalog.push({
    id: 'conjunctive-obligation-claim',
    test_path: 'test/conjunctive-obligation-claim.test.ts',
    runner: catalog[0].runner,
    obligation_cases: [{
      ...catalog[0].obligation_cases[0],
      expected_test_titles: [
        ...catalog[0].obligation_cases[0].expected_test_titles,
      ],
    }],
  });
  const {
    enginePath,
    engineHash,
    proofPath,
    root,
  } = await fixture({ catalog });
  await assert.doesNotReject(
    () => assertEffectStateRecoveryReleaseInputs({
      enginePath,
      proofPath,
      repositoryRoot: root,
      trustedEvidenceCatalog: catalog,
      expectedEngineHash: engineHash,
      expectedEngineVersion: 'test-version',
      readVersion: async () => 'iii-engine test-version\n',
    }),
  );

  const manifest = manifestForCatalog(catalog, true);
  manifest.evidence = manifest.evidence.filter(
    ({ id }) => id !== 'conjunctive-obligation-claim',
  );
  await fs.writeFile(proofPath, JSON.stringify(manifest));
  await assert.rejects(
    () => assertEffectStateRecoveryReleaseInputs({
      enginePath,
      proofPath,
      repositoryRoot: root,
      trustedEvidenceCatalog: catalog,
    }),
    /effect_state_recovery_release_gate_proof_evidence_invalid/,
  );
});

test('release gate rejects claims exceeding trusted evidence', async () => {
  const {
    enginePath,
    proofPath,
    root,
  } = await fixture({
    catalog: EFFECT_STATE_RECOVERY_TRUSTED_EVIDENCE,
    complete: false,
  });
  const manifest = manifestForCatalog(
    EFFECT_STATE_RECOVERY_TRUSTED_EVIDENCE,
    false,
  );
  manifest.evidence[0].obligation_cases.push({
    obligation_id: 'protocol::unknown_error_fails_closed',
    expected_test_titles: ['untrusted claim'],
  });
  await fs.writeFile(proofPath, JSON.stringify(manifest));
  await assert.rejects(
    () => assertEffectStateRecoveryReleaseInputs({
      enginePath,
      proofPath,
      repositoryRoot: root,
    }),
    /effect_state_recovery_release_gate_proof_evidence_invalid/,
  );
});

test('release gate rejects a test title reassigned to another obligation', async () => {
  const {
    enginePath,
    proofPath,
    root,
  } = await fixture({
    catalog: EFFECT_STATE_RECOVERY_TRUSTED_EVIDENCE,
    complete: false,
  });
  const manifest = manifestForCatalog(
    EFFECT_STATE_RECOVERY_TRUSTED_EVIDENCE,
    false,
  );
  const obligationCases = manifest.evidence[0].obligation_cases;
  obligationCases[0].expected_test_titles = [
    ...obligationCases[2].expected_test_titles,
  ];
  await fs.writeFile(proofPath, JSON.stringify(manifest));
  await assert.rejects(
    () => assertEffectStateRecoveryReleaseInputs({
      enginePath,
      proofPath,
      repositoryRoot: root,
    }),
    /effect_state_recovery_release_gate_proof_evidence_invalid/,
  );
});

test('release gate rejects an arbitrary passing test path', async () => {
  const {
    catalog,
    enginePath,
    proofPath,
    root,
  } = await fixture();
  const arbitraryPath = 'test/arbitrary-passing.test.ts';
  await fs.writeFile(path.join(root, arbitraryPath), 'export {};\n');
  const manifest = manifestForCatalog(catalog, true);
  manifest.evidence[0].test_path = arbitraryPath;
  await fs.writeFile(proofPath, JSON.stringify(manifest));
  await assert.rejects(
    () => assertEffectStateRecoveryReleaseInputs({
      enginePath,
      proofPath,
      repositoryRoot: root,
      trustedEvidenceCatalog: catalog,
    }),
    /effect_state_recovery_release_gate_proof_evidence_invalid/,
  );
});

test('release gate rejects tampered obligation coverage', async () => {
  const {
    catalog,
    enginePath,
    proofPath,
    root,
  } = await fixture();
  const manifest = manifestForCatalog(catalog, true);
  manifest.coverage.obligations.covered_ids.pop();
  manifest.coverage.obligations.missing_ids.push(requiredIds.at(-1));
  await fs.writeFile(proofPath, JSON.stringify(manifest));
  await assert.rejects(
    () => assertEffectStateRecoveryReleaseInputs({
      enginePath,
      proofPath,
      repositoryRoot: root,
      trustedEvidenceCatalog: catalog,
    }),
    /effect_state_recovery_release_gate_proof_coverage_invalid/,
  );
});

test('release gate returns the trusted runner for each complete obligation proof', async () => {
  const catalog = completeCatalog();
  const {
    root,
    enginePath,
    proofPath,
    engineHash,
  } = await fixture({ catalog });
  const result = await assertEffectStateRecoveryReleaseInputs({
    enginePath,
    proofPath,
    repositoryRoot: root,
    trustedEvidenceCatalog: catalog,
    expectedEngineHash: engineHash,
    expectedEngineVersion: 'test-version',
    readVersion: async () => 'iii-engine test-version\n',
  });
  assert.deepEqual(result.testEntries, catalog.map((evidence) => ({
    runner: evidence.runner,
    testPath: path.join(root, evidence.test_path),
    expectedTestTitles: evidenceTitles(evidence),
  })));
});

test('evidence result validation rejects skipped or missing named cases', () => {
  assert.doesNotThrow(() => assertEvidenceExecutionResult({
    runner: 'node',
    expectedTestTitles: ['case one'],
    nodeTapOutput: 'TAP version 13\nok 1 - case one\n',
  }));
  assert.throws(
    () => assertEvidenceExecutionResult({
      runner: 'node',
      expectedTestTitles: ['case one'],
      nodeTapOutput: 'TAP version 13\nok 1 - case one # SKIP disabled\n',
    }),
    /effect_state_recovery_release_gate_evidence_result_invalid/,
  );
  assert.throws(
    () => assertEvidenceExecutionResult({
      runner: 'node-subprocess',
      expectedTestTitles: ['case one'],
      nodeTapOutput: [
        'TAP version 13',
        'ok 1 - case one',
        'ok 2 - case one # SKIP disabled',
      ].join('\n'),
    }),
    /effect_state_recovery_release_gate_evidence_result_invalid/,
  );
  assert.throws(
    () => assertEvidenceExecutionResult({
      runner: 'node',
      expectedTestTitles: ['case one'],
      nodeTapOutput: [
        'TAP version 13',
        'not ok 1 - case one',
        'ok 2 - case one',
      ].join('\n'),
    }),
    /effect_state_recovery_release_gate_evidence_result_invalid/,
  );

  const report = {
    testResults: [{
      assertionResults: [{
        title: 'real case',
        status: 'passed',
      }],
    }],
  };
  assert.doesNotThrow(() => assertEvidenceExecutionResult({
    runner: 'vitest-real-iii',
    expectedTestTitles: ['real case'],
    vitestReport: report,
  }));
  report.testResults[0].assertionResults[0].status = 'pending';
  assert.throws(
    () => assertEvidenceExecutionResult({
      runner: 'vitest-real-iii',
      expectedTestTitles: ['real case'],
      vitestReport: report,
    }),
    /effect_state_recovery_release_gate_evidence_result_invalid/,
  );
});

test('release gate accepts complete trusted obligations and the pinned binary', async () => {
  const {
    catalog,
    root,
    enginePath,
    proofPath,
    engineHash,
  } = await fixture();
  assert.deepEqual(
    await assertEffectStateRecoveryReleaseInputs({
      enginePath,
      proofPath,
      repositoryRoot: root,
      trustedEvidenceCatalog: catalog,
      expectedEngineHash: engineHash,
      expectedEngineVersion: 'test-version',
      readVersion: async () => 'iii-engine test-version\n',
    }),
    {
      enginePath,
      engineSha256: engineHash,
      engineVersion: 'test-version',
      proofPath,
      testEntries: catalog.map((evidence) => ({
        runner: evidence.runner,
        testPath: path.join(root, evidence.test_path),
        expectedTestTitles: evidenceTitles(evidence),
      })),
    },
  );
});
