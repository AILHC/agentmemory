import { createHash } from 'node:crypto';

function receiptKey(attemptId, unitId) {
  return `xop_${createHash('sha256').update(JSON.stringify([attemptId, 'lessons', unitId])).digest('hex').slice(0, 32)}`;
}

function hash(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function completeCollectionProof(data, expected) {
  const collection = data?.collection;
  const proofs = collection?.scope_proofs;
  if (
    collection?.schema !== 'legacy-lesson-safe-facts-collection/v1'
    || !hash(collection.snapshot_hash)
    || !hash(collection.state_tree_hash)
    || !hash(collection.engine_hash)
    || !hash(collection.journal_input_summary_hash)
    || !Array.isArray(proofs)
    || proofs.length < 6
  ) return false;
  const byScope = new Map();
  for (const proof of proofs) {
    if (
      typeof proof?.scope !== 'string'
      || byScope.has(proof.scope)
      || !Number.isSafeInteger(proof.exact_count)
      || proof.exact_count < 0
      || !hash(proof.safe_projection_hash)
    ) return false;
    byScope.set(proof.scope, proof);
  }
  return [
    `mem:extraction-operation-receipt:${expected.receiptKey}`,
    'mem:extraction-operation-receipts',
    'mem:lesson-extraction:runs',
    `mem:lesson-extraction:chunks:${expected.lessonRunId}`,
    'mem:lessons',
    `mem:lesson-commit:receipts:${expected.lessonRunId}`,
  ].every((scope) => byScope.has(scope));
}

function zeroEffectProof(data, expected) {
  const run = data?.lessonRun;
  const receipt = data?.receipt;
  const chunks = Array.isArray(data?.lessonChunks) ? data.lessonChunks : null;
  const formalWrites = Array.isArray(data?.formalLessonWrites) ? data.formalLessonWrites : null;
  if (!run || !receipt || !chunks || !formalWrites || !hash(expected.runInputHash) || !hash(expected.receiptInputHash) || !hash(expected.configHash)
    || !completeCollectionProof(data, expected)
    || run.id !== expected.lessonRunId || run.sessionId !== expected.sessionId
    || run.inputHash !== expected.runInputHash || run.configHash !== expected.configHash
    || run.status !== 'failed'
    || receipt.key !== expected.receiptKey || receipt.runId !== expected.attemptId
    || receipt.unitId !== expected.sessionId || receipt.stage !== 'lessons'
    || receipt.inputHash !== expected.receiptInputHash || receipt.status !== 'failed'
    || receipt.failure?.class !== 'unit' || receipt.failure?.cause !== 'lesson_no_blocks'
    || !Array.isArray(run.createdLessonIds) || run.createdLessonIds.length !== 0
    || !Array.isArray(run.replacedLessonIds) || run.replacedLessonIds.length !== 0
    || typeof run.finishedAt !== 'string'
    || chunks.some((chunk) => chunk?.runId !== expected.lessonRunId || chunk?.sessionId !== expected.sessionId || !Array.isArray(chunk?.lessonIds) || chunk.lessonIds.length !== 0)
    || formalWrites.some((write) => write?.sourceRunId === expected.lessonRunId)) return null;
  return { kind: 'legacy_lessons_zero_effect', lessonRunId: run.id, receiptKey: receipt.key, inputHash: run.inputHash, configHash: run.configHash, createdLessonCount: 0, replacedLessonCount: 0, chunkLessonCount: 0, finishedAt: run.finishedAt };
}

export function adaptLessonOperationEvidence({ result, unit, attemptId, operationId }) {
  const data = result?.data || result || {};
  const key = receiptKey(attemptId, unit.unit_id);
  const structured = Array.isArray(data?.lessonEvidence) ? data.lessonEvidence[0] : data?.lessonEvidence;
  const lessonRun = Array.isArray(data?.runs) ? data.runs[0] : data?.run;
  let evidence = structured && typeof structured === 'object'
    && ['no_effect', 'staged', 'committing', 'committed', 'unknown', 'system_fault'].includes(structured.kind)
    ? structured
    : null;
  if (evidence?.kind === 'committed' && (
    evidence.receiptVersion !== 1
    || !/^lcr_[0-9a-f]{32}$/.test(String(evidence.receiptKey || ''))
    || typeof evidence.resultRef !== 'string' || !evidence.resultRef
    || !hash(evidence.effectHash)
    || typeof evidence.runId !== 'string' || !evidence.runId
    || typeof evidence.stagingId !== 'string' || !evidence.stagingId
    || typeof evidence.planId !== 'string' || !evidence.planId
    || lessonRun?.status !== 'succeeded'
    || evidence.runId !== lessonRun?.id
    || evidence.resultRef !== `lesson-commit-plans:${evidence.planId}`
  )) evidence = null;
  if (!evidence && data?.failure?.cause === 'lesson_no_blocks') {
    const proof = zeroEffectProof(data, {
      lessonRunId: data.expectedLessonRunId,
      receiptKey: key,
      attemptId,
      sessionId: unit.unit_id,
      runInputHash: data.expectedRunInputHash,
      receiptInputHash: data.expectedReceiptInputHash,
      configHash: data.expectedConfigHash,
    });
    if (proof) evidence = { kind: 'no_effect', observation: 'business_empty', reasonCode: 'lesson_no_blocks', proof };
  }
  if (!evidence) evidence = { kind: 'unknown', receiptKey: key, reasonCode: 'legacy_lessons_effect_unknown' };
  const effectVerification = evidence.kind === 'committed' ? 'all_applied' : undefined;
  let snapshot = {};
  if (evidence.kind === 'committed') {
    snapshot = {
      receipt: {
        key: evidence.receiptKey,
        version: evidence.receiptVersion,
        resultRef: evidence.resultRef,
        effectHash: evidence.effectHash,
        status: 'committed',
      },
    };
  } else if (evidence.kind === 'no_effect' && evidence.proof?.kind === 'legacy_lessons_zero_effect') {
    snapshot = {
      receipt: {
        key: evidence.proof.receiptKey,
        formalEffect: false,
      },
      lessonRun: {
        id: evidence.proof.lessonRunId,
        inputHash: evidence.proof.inputHash,
        configHash: evidence.proof.configHash,
        createdLessonCount: evidence.proof.createdLessonCount,
        replacedLessonCount: evidence.proof.replacedLessonCount,
        chunkLessonCount: evidence.proof.chunkLessonCount,
        finishedAt: evidence.proof.finishedAt,
      },
    };
  }
  return {
    candidateEvidence: evidence,
    snapshot,
    ...(effectVerification ? { effectVerification } : {}),
  };
}
