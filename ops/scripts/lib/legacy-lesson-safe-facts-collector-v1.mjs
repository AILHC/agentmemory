import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  verifyOfflineStateKvSnapshot,
} from './offline-statekv-snapshot-v1.mjs';
import {
  canonicalRecoveryValue,
  hashRecoveryValue,
} from './recovery-migration-contract-v1.mjs';
import { reduceRecoveryJournal } from './recovery-journal-reducer-v1.mjs';

export const LEGACY_LESSON_SAFE_FACTS_ADAPTER = 'lessons/legacy-safe-facts-v1';
export const TRUSTED_READ_ONLY_COLLECTOR_SOURCE = 'trusted_read_only_collector';

const HASH = /^[0-9a-f]{64}$/;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/;
const SCOPES = Object.freeze({
  legacyReceipts: 'mem:extraction-operation-receipts',
  receipt: (key) => `mem:extraction-operation-receipt:${key}`,
  runs: 'mem:lesson-extraction:runs',
  chunks: (runId) => `mem:lesson-extraction:chunks:${runId}`,
  lessons: 'mem:lessons',
  commitReceipts: (runId) => `mem:lesson-commit:receipts:${runId}`,
});

function operationReceiptKey(attemptId, unitId) {
  return `xop_${createHash('sha256')
    .update(JSON.stringify([attemptId, 'lessons', unitId]))
    .digest('hex')
    .slice(0, 32)}`;
}

function journalChecksum(event) {
  return createHash('sha256').update(JSON.stringify({
    seq: event.seq,
    at: event.at,
    type: event.type,
    payload: event.payload,
  })).digest('hex');
}

export async function readRecoveryJournalSnapshot(journalPath, fsApi = fs) {
  const raw = await fsApi.readFile(journalPath, 'utf8');
  if (!raw.endsWith('\n')) {
    throw new Error('legacy_lesson_collector_journal_snapshot_incomplete');
  }
  const lines = raw.split('\n').slice(0, -1);
  const events = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index]) {
      throw new Error(`legacy_lesson_collector_journal_snapshot_invalid:${index}`);
    }
    let event;
    try {
      event = JSON.parse(lines[index]);
    } catch {
      throw new Error(`legacy_lesson_collector_journal_snapshot_invalid:${index}`);
    }
    if (
      !event
      || typeof event !== 'object'
      || Array.isArray(event)
      || Object.keys(event).sort().join(',') !== 'at,checksum,payload,seq,type'
      || event.seq !== index
      || typeof event.at !== 'string'
      || !ISO_TIME.test(event.at)
      || typeof event.type !== 'string'
      || !event.type
      || !event.payload
      || typeof event.payload !== 'object'
      || Array.isArray(event.payload)
      || event.checksum !== journalChecksum(event)
    ) {
      throw new Error(`legacy_lesson_collector_journal_snapshot_invalid:${index}`);
    }
    events.push(event);
  }
  return events;
}

function assertSafeId(value, code) {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) throw new Error(code);
  return value;
}

function assertHash(value, code) {
  if (!HASH.test(String(value || ''))) throw new Error(code);
  return value;
}

function assertReadOnlyView(view, snapshot) {
  if (
    !view
    || typeof view.get !== 'function'
    || typeof view.list !== 'function'
    || ['set', 'update', 'delete'].some((name) => typeof view[name] === 'function')
    || view.capabilities?.completeScopeList !== true
    || view.capabilities?.includesDeletedLessons !== true
    || view.capabilities?.workingCopyOnly !== true
    || view.capabilities?.snapshotHash !== snapshot?.snapshot_hash
    || view.capabilities?.stateTreeHash !== snapshot?.state_tree_hash
    || view.capabilities?.engineHash !== snapshot?.engine?.sha256
  ) {
    throw new Error('legacy_lesson_collector_trusted_read_only_view_required');
  }
}

async function completeList(view, scope, code) {
  const values = await view.list(scope);
  if (!Array.isArray(values)) throw new Error(code);
  return values;
}

function projectReceipt(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('legacy_lesson_collector_receipt_invalid');
  }
  return {
    key: assertSafeId(value.key, 'legacy_lesson_collector_receipt_key_invalid'),
    runId: assertSafeId(value.runId, 'legacy_lesson_collector_receipt_run_invalid'),
    unitId: assertSafeId(value.unitId, 'legacy_lesson_collector_receipt_unit_invalid'),
    stage: value.stage,
    inputHash: assertHash(
      value.inputHash,
      'legacy_lesson_collector_receipt_input_hash_invalid',
    ),
    status: value.status,
    failure: value.failure && typeof value.failure === 'object'
      ? {
        class: value.failure.class,
        cause: value.failure.cause,
        ...(value.failure.phase ? { phase: value.failure.phase } : {}),
      }
      : null,
  };
}

function projectRun(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('legacy_lesson_collector_run_invalid');
  }
  return {
    id: assertSafeId(value.id, 'legacy_lesson_collector_run_id_invalid'),
    sessionId: assertSafeId(
      value.sessionId,
      'legacy_lesson_collector_run_session_invalid',
    ),
    status: value.status,
    inputHash: assertHash(
      value.inputHash,
      'legacy_lesson_collector_run_input_hash_invalid',
    ),
    configHash: assertHash(
      value.configHash,
      'legacy_lesson_collector_run_config_hash_invalid',
    ),
    ...(value.extractionGeneration === undefined
      ? {}
      : { extractionGeneration: value.extractionGeneration }),
    createdLessonIds: Array.isArray(value.createdLessonIds)
      ? value.createdLessonIds.map((id) => assertSafeId(
        id,
        'legacy_lesson_collector_created_lesson_id_invalid',
      ))
      : null,
    replacedLessonIds: Array.isArray(value.replacedLessonIds)
      ? value.replacedLessonIds.map((id) => assertSafeId(
        id,
        'legacy_lesson_collector_replaced_lesson_id_invalid',
      ))
      : null,
    finishedAt: value.finishedAt,
  };
}

function projectChunk(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('legacy_lesson_collector_chunk_invalid');
  }
  return {
    id: assertSafeId(value.id, 'legacy_lesson_collector_chunk_id_invalid'),
    runId: assertSafeId(value.runId, 'legacy_lesson_collector_chunk_run_invalid'),
    sessionId: assertSafeId(
      value.sessionId,
      'legacy_lesson_collector_chunk_session_invalid',
    ),
    chunkIndex: value.chunkIndex,
    status: value.status,
    lessonIds: Array.isArray(value.lessonIds)
      ? value.lessonIds.map((id) => assertSafeId(
        id,
        'legacy_lesson_collector_chunk_lesson_id_invalid',
      ))
      : null,
  };
}

function projectLesson(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('legacy_lesson_collector_formal_lesson_invalid');
  }
  const watermarks = value.sourceWatermarks;
  const safeWatermarks = {};
  if (watermarks !== undefined) {
    if (!watermarks || typeof watermarks !== 'object' || Array.isArray(watermarks)) {
      throw new Error('legacy_lesson_collector_watermarks_invalid');
    }
    for (const [sessionId, watermark] of Object.entries(watermarks)) {
      assertSafeId(sessionId, 'legacy_lesson_collector_watermark_session_invalid');
      if (
        !watermark
        || typeof watermark !== 'object'
        || Array.isArray(watermark)
        || !Number.isSafeInteger(watermark.generation)
        || watermark.generation <= 0
        || typeof watermark.mutationId !== 'string'
        || !SAFE_ID.test(watermark.mutationId)
      ) {
        throw new Error('legacy_lesson_collector_watermark_invalid');
      }
      safeWatermarks[sessionId] = {
        generation: watermark.generation,
        mutationId: watermark.mutationId,
      };
    }
  }
  return {
    id: assertSafeId(value.id, 'legacy_lesson_collector_lesson_id_invalid'),
    ...(value.sourceRunId === undefined
      ? {}
      : {
        sourceRunId: assertSafeId(
          value.sourceRunId,
          'legacy_lesson_collector_lesson_source_run_invalid',
        ),
      }),
    sourceWatermarks: safeWatermarks,
    deleted: value.deleted === true,
  };
}

function projectCommitReceipt(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('legacy_lesson_collector_commit_receipt_invalid');
  }
  return {
    key: assertSafeId(
      value.key,
      'legacy_lesson_collector_commit_receipt_key_invalid',
    ),
    runId: assertSafeId(
      value.runId,
      'legacy_lesson_collector_commit_receipt_run_invalid',
    ),
    unitId: assertSafeId(
      value.unitId,
      'legacy_lesson_collector_commit_receipt_unit_invalid',
    ),
    status: value.status,
    effectHash: assertHash(
      value.effectHash,
      'legacy_lesson_collector_commit_receipt_effect_hash_invalid',
    ),
  };
}

function scopeProof(scope, projected) {
  return {
    scope,
    exact_count: projected.length,
    safe_projection_hash: hashRecoveryValue(projected),
  };
}

function assertUniqueProjection(values, field, code) {
  const identities = values.map((value) => value[field]);
  if (new Set(identities).size !== identities.length) throw new Error(code);
}

function journalUnitFacts(events, unitId) {
  const reduced = reduceRecoveryJournal(events);
  const unit = reduced.units.get(unitId);
  if (
    !unit
    || !unit.started
    || typeof unit.attempt_id !== 'string'
    || !unit.attempt_id
    || !HASH.test(String(unit.input_hash || ''))
  ) {
    throw new Error(`legacy_lesson_collector_journal_unit_incomplete:${unitId}`);
  }
  return {
    attemptId: unit.attempt_id,
    runnerInputHash: unit.input_hash,
    operationId: unit.active_operation?.operation_id
      || unit.completed_operations.at(-1)?.operation_id
      || `${unitId}:legacy`,
  };
}

function validateSnapshotBinding(snapshot, request, events) {
  if (
    snapshot?.schema !== 'agentmemory-recovery-evidence-snapshot/v1'
    || snapshot?.completeness?.two_pass_source_match !== true
    || snapshot?.completeness?.destination_hash_match !== true
    || !HASH.test(String(snapshot?.snapshot_hash || ''))
    || snapshot?.expected_journal?.run_id !== request.run_id
    || snapshot?.expected_journal?.stage !== request.stage
    || snapshot?.expected_journal?.journal_seq !== request.journal_seq
    || snapshot?.expected_journal?.input_summary_hash !== request.input_summary_hash
    || (events.at(-1)?.seq ?? -1) !== request.journal_seq
    || hashRecoveryValue(events) !== request.input_summary_hash
  ) {
    throw new Error('legacy_lesson_collector_snapshot_journal_binding_invalid');
  }
}

async function collectUnit({ view, events, unitId, snapshot }) {
  assertSafeId(unitId, 'legacy_lesson_collector_unit_id_invalid');
  const journal = journalUnitFacts(events, unitId);
  const receiptKey = operationReceiptKey(journal.attemptId, unitId);
  const receiptScope = SCOPES.receipt(receiptKey);
  const [
    currentReceipt,
    currentReceiptScope,
    legacyReceipts,
    rawRuns,
    rawLessons,
  ] = await Promise.all([
    view.get(SCOPES.receipt(receiptKey), receiptKey),
    completeList(
      view,
      receiptScope,
      'legacy_lesson_collector_receipt_scope_incomplete',
    ),
    completeList(
      view,
      SCOPES.legacyReceipts,
      'legacy_lesson_collector_legacy_receipt_scope_incomplete',
    ),
    completeList(
      view,
      SCOPES.runs,
      'legacy_lesson_collector_run_scope_incomplete',
    ),
    completeList(
      view,
      SCOPES.lessons,
      'legacy_lesson_collector_lesson_scope_incomplete',
    ),
  ]);
  const projectedCurrentReceiptScope = currentReceiptScope.map(projectReceipt);
  const projectedLegacyReceipts = legacyReceipts.map(projectReceipt);
  assertUniqueProjection(
    projectedCurrentReceiptScope,
    'key',
    'legacy_lesson_collector_receipt_scope_duplicate',
  );
  assertUniqueProjection(
    projectedLegacyReceipts,
    'key',
    'legacy_lesson_collector_legacy_receipt_scope_duplicate',
  );
  const legacyMatches = projectedLegacyReceipts.filter(
    (receipt) => receipt.key === receiptKey,
  );
  const projectedCurrentReceipt = currentReceipt
    ? projectReceipt(currentReceipt)
    : null;
  if (
    projectedCurrentReceiptScope.length > 1
    || projectedCurrentReceiptScope.some((receipt) => receipt.key !== receiptKey)
    || Boolean(projectedCurrentReceipt)
      !== (projectedCurrentReceiptScope.length === 1)
    || (
      projectedCurrentReceipt
      && hashRecoveryValue(projectedCurrentReceipt)
        !== hashRecoveryValue(projectedCurrentReceiptScope[0])
    )
    || legacyMatches.length > 1
    || (projectedCurrentReceipt && legacyMatches.length > 0)
  ) {
    throw new Error(`legacy_lesson_collector_receipt_ambiguous:${unitId}`);
  }
  const projectedReceipt = projectedCurrentReceipt || legacyMatches[0];
  if (!projectedReceipt) {
    throw new Error(`legacy_lesson_collector_receipt_missing:${unitId}`);
  }
  const projectedRuns = rawRuns.map(projectRun);
  assertUniqueProjection(
    projectedRuns,
    'id',
    'legacy_lesson_collector_run_scope_duplicate',
  );
  const matchingRuns = projectedRuns.filter((run) => (
    run.sessionId === unitId
    && hashRecoveryValue({
      configHash: run.configHash,
      runnerInputHash: journal.runnerInputHash,
      serviceInputHash: run.inputHash,
    }) === projectedReceipt.inputHash
  ));
  if (matchingRuns.length !== 1) {
    throw new Error(`legacy_lesson_collector_run_ambiguous:${unitId}`);
  }
  const run = matchingRuns[0];
  if (
    projectedReceipt.key !== receiptKey
    || projectedReceipt.runId !== journal.attemptId
    || projectedReceipt.unitId !== unitId
    || projectedReceipt.stage !== 'lessons'
    || projectedReceipt.status !== 'failed'
    || projectedReceipt.failure?.class !== 'unit'
    || projectedReceipt.failure?.cause !== 'lesson_no_blocks'
    || !['failed', 'retryable'].includes(run.status)
    || !Array.isArray(run.createdLessonIds)
    || run.createdLessonIds.length !== 0
    || !Array.isArray(run.replacedLessonIds)
    || run.replacedLessonIds.length !== 0
    || typeof run.finishedAt !== 'string'
    || !ISO_TIME.test(run.finishedAt)
    || (
      run.extractionGeneration !== undefined
      && (
        !Number.isSafeInteger(run.extractionGeneration)
        || run.extractionGeneration <= 0
      )
    )
  ) {
    throw new Error(`legacy_lesson_collector_zero_effect_not_proven:${unitId}`);
  }
  const [rawChunks, rawCommitReceipts] = await Promise.all([
    completeList(
      view,
      SCOPES.chunks(run.id),
      'legacy_lesson_collector_chunk_scope_incomplete',
    ),
    completeList(
      view,
      SCOPES.commitReceipts(run.id),
      'legacy_lesson_collector_commit_receipt_scope_incomplete',
    ),
  ]);
  const chunks = rawChunks.map(projectChunk);
  const lessons = rawLessons.map(projectLesson);
  const commitReceipts = rawCommitReceipts.map(projectCommitReceipt);
  assertUniqueProjection(
    chunks,
    'id',
    'legacy_lesson_collector_chunk_scope_duplicate',
  );
  assertUniqueProjection(
    lessons,
    'id',
    'legacy_lesson_collector_lesson_scope_duplicate',
  );
  assertUniqueProjection(
    commitReceipts,
    'key',
    'legacy_lesson_collector_commit_receipt_scope_duplicate',
  );
  const watermarkConflict = lessons.some((lesson) => {
    const watermark = lesson.sourceWatermarks[unitId];
    if (!watermark) return false;
    return run.extractionGeneration === undefined
      || watermark.generation >= run.extractionGeneration;
  });
  if (
    chunks.some((chunk) => (
      chunk.runId !== run.id
      || chunk.sessionId !== unitId
      || !Number.isSafeInteger(chunk.chunkIndex)
      || chunk.chunkIndex < 0
      || !Array.isArray(chunk.lessonIds)
      || chunk.lessonIds.length !== 0
    ))
    || lessons.some((lesson) => lesson.sourceRunId === run.id)
    || watermarkConflict
    || commitReceipts.length !== 0
  ) {
    throw new Error(`legacy_lesson_collector_effect_detected:${unitId}`);
  }
  const scopeProofs = [
    scopeProof(receiptScope, projectedCurrentReceiptScope),
    scopeProof(SCOPES.legacyReceipts, projectedLegacyReceipts),
    scopeProof(SCOPES.runs, projectedRuns),
    scopeProof(SCOPES.chunks(run.id), chunks),
    scopeProof(SCOPES.lessons, lessons),
    scopeProof(SCOPES.commitReceipts(run.id), commitReceipts),
  ].sort((left, right) => left.scope.localeCompare(right.scope, 'en'));
  return {
    adapter: LEGACY_LESSON_SAFE_FACTS_ADAPTER,
    attempt_id: journal.attemptId,
    operation_id: journal.operationId,
    safe_facts: {
      failure: { class: 'unit', cause: 'lesson_no_blocks' },
      expectedLessonRunId: run.id,
      expectedRunInputHash: run.inputHash,
      expectedReceiptInputHash: projectedReceipt.inputHash,
      expectedConfigHash: run.configHash,
      lessonRun: {
        id: run.id,
        sessionId: run.sessionId,
        status: run.status,
        inputHash: run.inputHash,
        configHash: run.configHash,
        ...(run.extractionGeneration === undefined
          ? {}
          : { extractionGeneration: run.extractionGeneration }),
        createdLessonIds: [],
        replacedLessonIds: [],
        finishedAt: run.finishedAt,
      },
      receipt: projectedReceipt,
      lessonChunks: chunks,
      formalLessonWrites: [],
      collection: {
        schema: 'legacy-lesson-safe-facts-collection/v1',
        snapshot_hash: snapshot.snapshot_hash,
        state_tree_hash: snapshot.state_tree_hash,
        engine_hash: snapshot.engine.sha256,
        journal_input_summary_hash: snapshot.expected_journal.input_summary_hash,
        scope_proofs: scopeProofs,
      },
    },
  };
}

export async function collectLegacyLessonSafeFacts({
  view,
  snapshot,
  request,
  journalEvents,
}) {
  assertReadOnlyView(view, snapshot);
  if (
    request?.stage !== 'lessons'
    || !Array.isArray(request.units)
    || new Set(request.units).size !== request.units.length
  ) {
    throw new Error('legacy_lesson_collector_request_invalid');
  }
  validateSnapshotBinding(snapshot, request, journalEvents);
  const entries = await Promise.all(
    [...request.units].sort((left, right) => left.localeCompare(right, 'en'))
      .map(async (unitId) => [
        unitId,
        await collectUnit({
          view,
          events: journalEvents,
          unitId,
          snapshot,
        }),
      ]),
  );
  return canonicalRecoveryValue(Object.fromEntries(entries));
}

function isPathInside(candidate, root) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === ''
    || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function createVerifierWorkingSnapshot(snapshotDir, fsApi) {
  const absoluteSnapshotDir = path.resolve(snapshotDir);
  let workingBase = path.resolve(os.tmpdir());
  if (isPathInside(workingBase, absoluteSnapshotDir)) {
    workingBase = path.dirname(absoluteSnapshotDir);
  }
  await fsApi.mkdir(workingBase, { recursive: true });
  const workingRoot = await fsApi.mkdtemp(path.join(
    workingBase,
    'agentmemory-recovery-evidence-working-',
  ));
  const workingSnapshotDir = path.join(workingRoot, 'snapshot');
  try {
    if (
      isPathInside(workingRoot, absoluteSnapshotDir)
      || isPathInside(absoluteSnapshotDir, workingRoot)
    ) {
      throw new Error('legacy_lesson_collector_working_copy_isolation_failed');
    }
    await fsApi.cp(absoluteSnapshotDir, workingSnapshotDir, {
      recursive: true,
      force: false,
      errorOnExist: true,
      verbatimSymlinks: true,
    });
    return { workingBase, workingRoot, workingSnapshotDir };
  } catch (error) {
    await fsApi.rm(workingRoot, { recursive: true, force: true });
    throw error;
  }
}

async function removeVerifierWorkingSnapshot(working, fsApi) {
  const relative = path.relative(working.workingBase, working.workingRoot);
  if (
    !relative
    || relative.startsWith('..')
    || path.isAbsolute(relative)
    || !path.basename(working.workingRoot)
      .startsWith('agentmemory-recovery-evidence-working-')
  ) {
    throw new Error('legacy_lesson_collector_working_copy_cleanup_refused');
  }
  await fsApi.rm(working.workingRoot, { recursive: true, force: true });
}

export function createLegacyLessonEvidenceProvenanceVerifier({
  snapshotDir,
  openReadOnlyWorkingCopy,
  fsApi = fs,
}) {
  if (
    typeof snapshotDir !== 'string'
    || !path.isAbsolute(snapshotDir)
    || typeof openReadOnlyWorkingCopy !== 'function'
  ) {
    throw new Error('legacy_lesson_collector_engine_adapter_unavailable');
  }
  return async (request) => {
    const absoluteSnapshotDir = path.resolve(snapshotDir);
    const snapshot = await verifyOfflineStateKvSnapshot({
      snapshotDir: absoluteSnapshotDir,
      fsApi,
    });
    const working = await createVerifierWorkingSnapshot(
      absoluteSnapshotDir,
      fsApi,
    );
    try {
      const workingSnapshot = await verifyOfflineStateKvSnapshot({
        snapshotDir: working.workingSnapshotDir,
        fsApi,
      });
      if (workingSnapshot.snapshot_hash !== snapshot.snapshot_hash) {
        throw new Error('legacy_lesson_collector_working_copy_drifted');
      }
      await verifyOfflineStateKvSnapshot({
        snapshotDir: absoluteSnapshotDir,
        fsApi,
      });
      const journalEvents = await readRecoveryJournalSnapshot(
        path.join(working.workingSnapshotDir, 'journal.jsonl'),
        fsApi,
      );
      let view;
      try {
        view = await openReadOnlyWorkingCopy({
          snapshot: workingSnapshot,
          snapshotDir: working.workingSnapshotDir,
          stateDir: path.join(working.workingSnapshotDir, 'state'),
          enginePath: path.join(working.workingSnapshotDir, 'engine.bin'),
        });
        return {
          source_type: TRUSTED_READ_ONLY_COLLECTOR_SOURCE,
          safeEvidenceByUnit: await collectLegacyLessonSafeFacts({
            view,
            snapshot: workingSnapshot,
            request,
            journalEvents,
          }),
          collector_provenance: {
            schema: 'legacy-lesson-safe-facts-provenance/v1',
            snapshot_hash: workingSnapshot.snapshot_hash,
            engine_hash: workingSnapshot.engine.sha256,
          },
        };
      } finally {
        await view?.close?.();
        await verifyOfflineStateKvSnapshot({
          snapshotDir: working.workingSnapshotDir,
          fsApi,
        });
      }
    } finally {
      try {
        await verifyOfflineStateKvSnapshot({
          snapshotDir: absoluteSnapshotDir,
          fsApi,
        });
      } finally {
        await removeVerifierWorkingSnapshot(working, fsApi);
      }
    }
  };
}
