import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EFFECT_STATE_RECOVERY_REQUIRED_CATALOG_SHA256,
  EFFECT_STATE_RECOVERY_REQUIRED_OBLIGATIONS,
  EFFECT_STATE_RECOVERY_STAGES,
  EFFECT_STATE_RECOVERY_TRUSTED_EVIDENCE,
  EFFECT_STATE_RECOVERY_V1_CANONICAL_RISKS_SHA256,
  EFFECT_STATE_RECOVERY_V1_RISK_MAPPING_SHA256,
} from './lib/effect-state-recovery-release-gate-v2.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, '..', '..');
const defaultProofPath = path.join(
  root,
  'ops',
  'effect-state-recovery-release-proof-v2.json',
);

export function buildEffectStateRecoveryReleaseProof() {
  const requiredIds =
    EFFECT_STATE_RECOVERY_REQUIRED_OBLIGATIONS.map(({ id }) => id);
  const coveredIds = [
    ...new Set(
      EFFECT_STATE_RECOVERY_TRUSTED_EVIDENCE.flatMap(
        ({ obligation_cases: obligationCases }) =>
          obligationCases.map(({ obligation_id: obligationId }) => obligationId),
      ),
    ),
  ];
  const missingIds = requiredIds.filter((id) => !coveredIds.includes(id));
  return {
    schema_version: 'effect-state-recovery-release-proof/v2',
    complete: missingIds.length === 0,
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
        missing_ids: missingIds,
      },
    },
    evidence: EFFECT_STATE_RECOVERY_TRUSTED_EVIDENCE.map((evidence) => ({
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

export async function main(proofPath = defaultProofPath) {
  const proof = buildEffectStateRecoveryReleaseProof();
  await fsp.writeFile(proofPath, `${JSON.stringify(proof, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'w',
  });
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (path.resolve(fileURLToPath(import.meta.url)) === invoked) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
