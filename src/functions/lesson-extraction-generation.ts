import type { Lesson, LessonExtractionGenerationRegistry, LessonExtractionRun } from "../types.js";
import { KV } from "../state/schema.js";
import type { StateKV } from "../state/kv.js";
import { withKeyedLock } from "../state/keyed-mutex.js";

export class LessonExtractionGenerationConflictError extends Error {
  constructor() {
    super("lesson_extraction_generation_conflict");
    this.name = "LessonExtractionGenerationConflictError";
  }
}

function isGeneration(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function isHash(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function sameRunIdentity(left: LessonExtractionRun, right: LessonExtractionRun): boolean {
  return left.id === right.id
    && left.sessionId === right.sessionId
    && left.strategy === right.strategy
    && left.inputHash === right.inputHash
    && left.configHash === right.configHash
    && left.providerName === right.providerName
    && left.extractionGeneration === right.extractionGeneration;
}

function registryIsConsistent(registry: LessonExtractionGenerationRegistry): boolean {
  const entries = Object.entries(registry.bindings);
  const generations = entries.map(([, binding]) => binding.generation);
  return registry.sessionId.length > 0
    && Number.isSafeInteger(registry.nextGeneration)
    && registry.nextGeneration > 0
    && entries.every(([runId, binding]) => runId.length > 0
      && binding.sessionId === registry.sessionId
      && isGeneration(binding.generation)
      && isHash(binding.inputHash)
      && isHash(binding.configHash)
      && binding.generation < registry.nextGeneration)
    && new Set(generations).size === generations.length;
}

function watermarkGeneration(lesson: Lesson, sessionId: string): number | undefined {
  const watermark = lesson.sourceWatermarks?.[sessionId];
  return watermark
    && isGeneration(watermark.generation)
    && typeof watermark.mutationId === "string"
    && watermark.mutationId.length > 0
    ? watermark.generation
    : undefined;
}

export async function bindLessonExtractionGeneration(
  kv: StateKV,
  suppliedRun: LessonExtractionRun,
): Promise<LessonExtractionRun> {
  return withKeyedLock(`lesson-extraction-generation:${suppliedRun.sessionId}`, async () => {
    const persistedBefore = await kv.get<LessonExtractionRun>(KV.lessonExtractionRuns, suppliedRun.id);
    if (!persistedBefore || !sameRunIdentity(suppliedRun, persistedBefore)) {
      throw new LessonExtractionGenerationConflictError();
    }
    const [storedRegistry, runs, lessons] = await Promise.all([
      kv.get<LessonExtractionGenerationRegistry>(KV.lessonExtractionGeneration(suppliedRun.sessionId), suppliedRun.sessionId),
      kv.list<LessonExtractionRun>(KV.lessonExtractionRuns),
      kv.list<Lesson>(KV.lessons),
    ]);
    if (storedRegistry && (!registryIsConsistent(storedRegistry) || storedRegistry.sessionId !== suppliedRun.sessionId)) {
      throw new LessonExtractionGenerationConflictError();
    }
    const bindings = { ...(storedRegistry?.bindings ?? {}) };
    for (const run of runs.filter((item) => item.sessionId === suppliedRun.sessionId)) {
      if (run.extractionGeneration === undefined) continue;
      if (!isGeneration(run.extractionGeneration)) throw new LessonExtractionGenerationConflictError();
      const binding = bindings[run.id];
      if (binding && (
        binding.generation !== run.extractionGeneration
        || binding.sessionId !== run.sessionId
        || binding.inputHash !== run.inputHash
        || binding.configHash !== run.configHash
      )) throw new LessonExtractionGenerationConflictError();
      bindings[run.id] = {
        generation: run.extractionGeneration,
        sessionId: run.sessionId,
        inputHash: run.inputHash,
        configHash: run.configHash,
      };
    }
    const binding = bindings[suppliedRun.id];
    if (binding && suppliedRun.extractionGeneration !== undefined && binding.generation !== suppliedRun.extractionGeneration) {
      throw new LessonExtractionGenerationConflictError();
    }
    const formalGenerations: number[] = [];
    for (const lesson of lessons) {
      const watermark = lesson.sourceWatermarks?.[suppliedRun.sessionId];
      if (watermark === undefined) continue;
      const generation = watermarkGeneration(lesson, suppliedRun.sessionId);
      if (generation === undefined) throw new LessonExtractionGenerationConflictError();
      formalGenerations.push(generation);
    }
    const observed = [
      ...Object.values(bindings).map((item) => item.generation),
      ...formalGenerations,
    ];
    const maxObserved = Math.max(0, ...observed);
    const generation = suppliedRun.extractionGeneration ?? binding?.generation ?? maxObserved + 1;
    if (!isGeneration(generation)) throw new LessonExtractionGenerationConflictError();
    bindings[suppliedRun.id] = {
      generation,
      sessionId: suppliedRun.sessionId,
      inputHash: suppliedRun.inputHash,
      configHash: suppliedRun.configHash,
    };
    const registry: LessonExtractionGenerationRegistry = {
      sessionId: suppliedRun.sessionId,
      nextGeneration: Math.max(storedRegistry?.nextGeneration ?? 1, maxObserved + 1, generation + 1),
      bindings,
      updatedAt: new Date().toISOString(),
    };
    if (!registryIsConsistent(registry)) throw new LessonExtractionGenerationConflictError();
    await kv.set(KV.lessonExtractionGeneration(suppliedRun.sessionId), suppliedRun.sessionId, registry);
    const bound = { ...persistedBefore, extractionGeneration: generation, updatedAt: registry.updatedAt };
    await kv.set(KV.lessonExtractionRuns, bound.id, bound);
    const [verifiedRegistry, verifiedRun] = await Promise.all([
      kv.get<LessonExtractionGenerationRegistry>(KV.lessonExtractionGeneration(suppliedRun.sessionId), suppliedRun.sessionId),
      kv.get<LessonExtractionRun>(KV.lessonExtractionRuns, suppliedRun.id),
    ]);
    const verifiedBinding = verifiedRegistry?.bindings[suppliedRun.id];
    if (!verifiedRegistry || !verifiedRun || !registryIsConsistent(verifiedRegistry)
      || !sameRunIdentity(bound, verifiedRun)
      || verifiedRun.extractionGeneration !== generation
      || !verifiedBinding
      || verifiedBinding.generation !== generation
      || verifiedBinding.sessionId !== bound.sessionId
      || verifiedBinding.inputHash !== bound.inputHash
      || verifiedBinding.configHash !== bound.configHash) {
      throw new LessonExtractionGenerationConflictError();
    }
    return verifiedRun;
  });
}
