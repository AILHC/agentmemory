import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  parseArguments,
  runScaleVerification,
} from './verify-run-state-journal-v2-scale.mjs';

test('eight-stage v2 scale verification measures linear runner and receipt growth', async () => {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-v2-scale-test-'));
  try {
    const report = await runScaleVerification({ workDir, units: 4 });
    assert.equal(report.benchmark_scope, 'isolated_eight_stage_release_candidate');
    assert.equal(report.stages.length, 8);
    assert.deepEqual(report.sample_units, { n: 4, two_n: 8 });
    assert.equal(report.checks.runner_growth_linear, true);
    assert.equal(report.checks.serialized_service_receipt_growth_linear, true);
    assert.equal(report.checks.status_bounded_to_4k, true);
    assert.equal(report.checks.no_v1_snapshot_files, true);
    assert.equal(report.checks.receipt_projection_excludes_summary_narrative, true);
    assert.equal(report.samples[0].service_receipt_count, 0);
    assert.equal(report.samples[1].service_receipt_count, 40);
    assert.equal(report.samples[2].service_receipt_count, 80);
    assert.equal(report.release_decision.default_format, 'v2');
    assert.equal(report.release_decision.change_default, false);
    assert.equal(report.release_decision.reason, 'default_already_switched_after_managed_canary');
    for (const sample of report.samples) {
      assert.equal(sample.stage_count, 8);
      assert.equal(sample.v1_snapshot_files.length, 0);
      assert.ok(Number.isFinite(sample.peak_heap_bytes));
      assert.ok(Number.isFinite(sample.peak_heap_delta_bytes));
      assert.ok(Number.isFinite(sample.recovery.duration_ms));
      assert.ok(sample.recovery.duration_ms < 10_000);
      assert.equal(Object.keys(sample.recovery.stage_event_counts).length, 8);
    }
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
});

test('scale verification CLI parser validates units and paths', () => {
  assert.deepEqual(
    parseArguments(['--units', '25', '--work-dir', 'artifacts', '--out', 'report.json']),
    { units: 25, workDir: 'artifacts', out: 'report.json' },
  );
  assert.throws(() => parseArguments(['--units', '0']), /units_must_be_a_positive_integer/);
  assert.throws(() => parseArguments(['--unknown']), /unknown_argument/);
});

test('scale verification never replaces an existing sample directory', async () => {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-v2-scale-existing-'));
  const existingSample = path.join(workDir, 'b0');
  const sentinel = path.join(existingSample, 'keep.txt');
  try {
    await fs.mkdir(existingSample);
    await fs.writeFile(sentinel, 'keep');
    await assert.rejects(() => runScaleVerification({ workDir, units: 1 }), /EEXIST/);
    assert.equal(await fs.readFile(sentinel, 'utf8'), 'keep');
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
});
