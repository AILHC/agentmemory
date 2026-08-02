import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ADOPTED_BASELINE_PREVIEW_SCHEMA,
  adoptedBaselinePreviewHash,
  coverageDigest,
  lessonSeedDigest,
} from './preview-agentmemory-adopted-baseline.mjs';

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--base-url') options.baseUrl = argv[++index];
    else if (argument === '--preview') options.previewPath = argv[++index];
    else if (argument === '--phase') options.phase = argv[++index];
    else if (argument === '--confirm') options.confirm = argv[++index];
    else throw new Error(`unknown argument: ${argument}`);
  }
  if (!options.baseUrl || !/^https?:\/\//.test(options.baseUrl)) {
    throw new Error('--base-url must be an HTTP URL');
  }
  if (!options.previewPath || !path.isAbsolute(options.previewPath)) {
    throw new Error('--preview must be absolute');
  }
  if (!['prepare', 'seal'].includes(options.phase)) throw new Error('--phase must be prepare or seal');
  const expectedConfirm = options.phase === 'prepare'
    ? 'APPLY_BASELINE_RECORDS'
    : 'SEAL_BASELINE';
  if (options.confirm !== expectedConfirm) {
    throw new Error(`--confirm must equal ${expectedConfirm}`);
  }
  return options;
}

function validatePreview(preview) {
  if (
    !preview
    || preview.schema !== ADOPTED_BASELINE_PREVIEW_SCHEMA
    || typeof preview.baseline_id !== 'string'
    || typeof preview.preview_hash !== 'string'
    || preview.preview_hash !== adoptedBaselinePreviewHash(preview)
    || !preview.coverage
    || !preview.lesson_seed
  ) throw new Error('adopted baseline preview is invalid or has drifted');
  return preview;
}

async function request(baseUrl, secret, body) {
  const response = await fetch(`${baseUrl.replace(/\/$/, '')}/agentmemory/full/extraction-baseline`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secret}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(360_000),
  });
  const result = await response.json();
  if (!response.ok || result?.success !== true) {
    throw new Error(result?.error || `HTTP ${response.status}`);
  }
  return result;
}

async function prepare(baseUrl, secret, preview) {
  const expectedCoverage = Object.fromEntries(Object.entries(preview.coverage).map(([stage, entry]) => {
    if (
      !entry?.stage_contract_version
      || entry.count !== entry.records?.length
      || entry.digest !== coverageDigest(entry.records)
    ) throw new Error(`invalid preview coverage: ${stage}`);
    return [stage, {
      stageContractVersion: entry.stage_contract_version,
      count: entry.count,
      digest: entry.digest,
    }];
  }));
  if (
    preview.lesson_seed.count !== preview.lesson_seed.records?.length
    || preview.lesson_seed.digest !== lessonSeedDigest(preview.lesson_seed.records)
  ) throw new Error('invalid preview lesson seed');
  await request(baseUrl, secret, {
    action: 'prepare',
    baselineId: preview.baseline_id,
    sourceRunId: preview.source_run_id,
    retiredRunIds: preview.retired_run_ids,
    decisionRef: preview.decision_ref,
    expectedCoverage,
    expectedLessonSeed: {
      count: preview.lesson_seed.count,
      digest: preview.lesson_seed.digest,
    },
  });
  for (const [stage, entry] of Object.entries(preview.coverage)) {
    for (let offset = 0; offset < entry.records.length; offset += 100) {
      const page = entry.records.slice(offset, offset + 100);
      await request(baseUrl, secret, {
        action: 'append_coverage',
        baselineId: preview.baseline_id,
        stage,
        sessionIds: page.map((record) => record.sessionId),
        expectedBatchDigest: coverageDigest(page),
      });
    }
  }
  for (let offset = 0; offset < preview.lesson_seed.records.length; offset += 100) {
    const page = preview.lesson_seed.records.slice(offset, offset + 100);
    await request(baseUrl, secret, {
      action: 'append_lesson_seed',
      baselineId: preview.baseline_id,
      lessonIds: page.map((record) => record.lessonId),
      expectedBatchDigest: lessonSeedDigest(page),
    });
  }
}

async function seal(baseUrl, secret, preview) {
  await request(baseUrl, secret, {
    action: 'seal',
    baselineId: preview.baseline_id,
  });
  const status = await request(baseUrl, secret, {
    action: 'status',
    baselineId: preview.baseline_id,
  });
  if (status.active?.id !== preview.baseline_id || status.active?.state !== 'sealed') {
    throw new Error('adopted baseline activation verification failed');
  }
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const secret = process.env.AGENTMEMORY_SECRET;
  if (!secret) throw new Error('AGENTMEMORY_SECRET is required');
  const preview = validatePreview(JSON.parse(await fs.readFile(options.previewPath, 'utf8')));
  if (options.phase === 'prepare') await prepare(options.baseUrl, secret, preview);
  else await seal(options.baseUrl, secret, preview);
  process.stdout.write(`${JSON.stringify({
    baseline_id: preview.baseline_id,
    preview_hash: preview.preview_hash,
    phase: options.phase,
    status: 'succeeded',
  })}\n`);
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (path.resolve(fileURLToPath(import.meta.url)) === invoked) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
