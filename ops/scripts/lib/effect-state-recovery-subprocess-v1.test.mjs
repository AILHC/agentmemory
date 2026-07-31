import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  SUBPROCESS_INTEGRATION_FAMILIES,
} from './effect-state-recovery-subprocess-fixture-v1.mjs';

const fixturePath = fileURLToPath(new URL(
  './effect-state-recovery-subprocess-fixture-v1.mjs',
  import.meta.url,
));

function runChild({ stateDir, family, crashBoundary = null }) {
  return new Promise((resolve, reject) => {
    const argumentsList = [
      fixturePath,
      '--state-dir',
      stateDir,
      '--family',
      family,
      ...(crashBoundary ? ['--crash-boundary', crashBoundary] : []),
    ];
    const child = spawn(process.execPath, argumentsList, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`subprocess_timeout:${family}:${crashBoundary || 'baseline'}`));
    }, 20_000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

function parseResult(execution) {
  assert.equal(execution.code, 0, execution.stderr);
  assert.equal(execution.signal, null);
  const line = execution.stdout.trim().split(/\r?\n/).at(-1);
  assert.ok(line, 'subprocess did not emit a result');
  return JSON.parse(line);
}

function businessProjection(result) {
  return {
    family: result.family,
    mode: result.mode,
    stage: result.stage,
    status: result.status,
    accepted_count: result.accepted_count,
    effect_count: result.effect_count,
    record_count: result.record_count,
    terminal: result.terminal,
    recorded: result.recorded,
  };
}

function eventBoundaries(eventTypes) {
  const occurrences = new Map();
  return eventTypes.map((type) => {
    const occurrence = (occurrences.get(type) || 0) + 1;
    occurrences.set(type, occurrence);
    return `${type}#${occurrence}`;
  });
}

test('runtime_boundary::runner_restart_at_each_journal_boundary', async () => {
  assert.deepEqual(SUBPROCESS_INTEGRATION_FAMILIES, {
    summary_custom: { mode: 'single', stage: 'summary' },
    lessons_custom: { mode: 'single', stage: 'lessons' },
    two_phase_prepare_commit: {
      mode: 'two_phase',
      stage: 'memory_consolidate',
    },
    two_phase_prepare_commit_skill_extract: {
      mode: 'two_phase',
      stage: 'skill_extract',
    },
    generic_single: { mode: 'single', stage: 'semantic_rollup' },
    generic_single_crystal: { mode: 'single', stage: 'crystal' },
    generic_single_consolidation_procedural: {
      mode: 'single',
      stage: 'consolidation_procedural',
    },
    generic_single_reflect_insight: {
      mode: 'single',
      stage: 'reflect_insight',
    },
  });

  const temporaryRoot = await fs.mkdtemp(path.join(
    os.tmpdir(),
    'effect-state-recovery-subprocess-',
  ));
  try {
    const baselines = new Map();
    for (const [family, integration] of Object.entries(
      SUBPROCESS_INTEGRATION_FAMILIES,
    )) {
      const stateDir = path.join(temporaryRoot, 'baseline', family);
      const baseline = parseResult(await runChild({ stateDir, family }));
      assert.equal(baseline.mode, integration.mode);
      assert.equal(baseline.stage, integration.stage);
      assert.equal(baseline.status, 'completed');
      assert.equal(baseline.accepted_count, 1);
      assert.equal(baseline.effect_count, 1);
      assert.equal(baseline.record_count, 1);
      assert.equal(baseline.terminal, 'succeeded');
      assert.equal(baseline.recorded, true);
      baselines.set(family, baseline);
    }

    for (const family of Object.keys(SUBPROCESS_INTEGRATION_FAMILIES)) {
      const baseline = baselines.get(family);
      for (const boundary of eventBoundaries(baseline.event_types)) {
        const stateDir = path.join(
          temporaryRoot,
          'restart',
          family,
          boundary.replace('#', '-'),
        );
        const interrupted = await runChild({
          stateDir,
          family,
          crashBoundary: boundary,
        });
        assert.equal(
          interrupted.code,
          86,
          `${family}:${boundary}\n${interrupted.stderr}`,
        );
        assert.equal(interrupted.signal, null);
        assert.equal(interrupted.stdout, '');

        const recovered = parseResult(await runChild({ stateDir, family }));
        assert.deepEqual(
          businessProjection(recovered),
          businessProjection(baseline),
          `${family}:${boundary}`,
        );
        assert.deepEqual(
          recovered.event_types,
          baseline.event_types,
          `${family}:${boundary}:journal`,
        );
      }
    }
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true });
  }
});
