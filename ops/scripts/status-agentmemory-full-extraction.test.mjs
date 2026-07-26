import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const statusScript = path.resolve(
  'ops',
  'scripts',
  'status-agentmemory-full-extraction.ps1',
);

function event(seq, type, payload = {}, at = '2026-07-26T14:00:00.000Z') {
  return { seq, at, type, payload, checksum: `test-${seq}` };
}

async function writeJournal(filePath, events) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(
    filePath,
    `${events.map((item) => JSON.stringify(item)).join('\n')}\n`,
    'utf8',
  );
}

function runStatus(runtimeRoot, runId, requiredStages = '') {
  const args = [
    '-NoProfile',
    '-File',
    statusScript,
    '-RunId',
    runId,
    '-RuntimeRoot',
    runtimeRoot,
  ];
  if (requiredStages) args.push('-RequiredStages', requiredStages);
  return spawnSync('powershell.exe', args, {
    encoding: 'utf8',
    windowsHide: true,
  });
}

test('v2 journal 在阶段执行中发布有界进度和存活 lock', async (context) => {
  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-v2-status-active-'));
  context.after(() => fs.rm(runtimeRoot, { recursive: true, force: true }));
  const runId = 'v2-active';
  const runRoot = path.join(runtimeRoot, 'extraction-runs', `${runId}.v2`);
  await writeJournal(path.join(runRoot, 'control.jsonl'), [
    event(0, 'run_started', { run_id: runId }),
    event(1, 'stage_opened', { stage: 'summary' }),
  ]);
  await writeJournal(path.join(runRoot, 'summary.jsonl'), [
    event(0, 'unit_planned', { unit_id: 'session-a' }),
    event(1, 'unit_planned', { unit_id: 'session-b' }),
    event(2, 'stage_plan_completed', {}),
    event(3, 'unit_started', { unit_id: 'session-a' }),
    event(4, 'unit_terminal', { unit_id: 'session-a', status: 'succeeded' }),
    event(5, 'unit_started', { unit_id: 'session-b' }),
  ]);
  await fs.writeFile(
    path.join(runRoot, 'writer.lock.json'),
    `${JSON.stringify({ run_id: runId, pid: process.pid, owner_id: 'test-owner' })}\n`,
    'utf8',
  );

  const result = runStatus(runtimeRoot, runId, 'summary,lessons');

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /source=v2_journal/);
  assert.match(result.stdout, /lock_present=true/);
  assert.match(result.stdout, /lock_pid_alive=true/);
  assert.match(result.stdout, /current_stage=summary/);
  assert.match(result.stdout, /acceptance_ready=false/);
  assert.match(
    result.stdout,
    /stage\.summary=succeeded:1,skipped:0,failed:0,pending:0,running:1/,
  );
});

test('v2 required stages 完成后使用阶段性完成判据', async (context) => {
  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-v2-status-complete-'));
  context.after(() => fs.rm(runtimeRoot, { recursive: true, force: true }));
  const runId = 'v2-complete';
  const runRoot = path.join(runtimeRoot, 'extraction-runs', `${runId}.v2`);
  await writeJournal(path.join(runRoot, 'control.jsonl'), [
    event(0, 'run_started', { run_id: runId }),
    event(1, 'stage_opened', { stage: 'summary' }),
    event(2, 'stage_opened', { stage: 'lessons' }),
  ]);
  for (const stage of ['summary', 'lessons']) {
    await writeJournal(path.join(runRoot, `${stage}.jsonl`), [
      event(0, 'unit_planned', { unit_id: 'session-a' }),
      event(1, 'stage_plan_completed', {}),
      event(2, 'unit_started', { unit_id: 'session-a' }),
      event(3, 'unit_terminal', { unit_id: 'session-a', status: 'succeeded' }),
      event(4, 'stage_completed', { accepted_count: 1 }),
    ]);
  }

  const result = runStatus(runtimeRoot, runId, 'summary,lessons');

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /completion_mode=required_stages/);
  assert.match(result.stdout, /required_stages=summary,lessons/);
  assert.match(result.stdout, /acceptance_ready=true/);
  assert.match(result.stdout, /current_stage=\s*(?:\r?\n|$)/);
});

test('v2 全阶段模式仍要求 run_completed', async (context) => {
  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-v2-status-full-'));
  context.after(() => fs.rm(runtimeRoot, { recursive: true, force: true }));
  const runId = 'v2-full';
  const runRoot = path.join(runtimeRoot, 'extraction-runs', `${runId}.v2`);
  const stages = [
    'summary',
    'lessons',
    'memory_consolidate',
    'semantic_rollup',
    'skill_extract',
    'crystal',
    'consolidation_procedural',
    'reflect_insight',
  ];
  await writeJournal(path.join(runRoot, 'control.jsonl'), [
    event(0, 'run_started', { run_id: runId }),
    ...stages.map((stage, index) => event(index + 1, 'stage_opened', { stage })),
  ]);
  for (const stage of stages) {
    await writeJournal(path.join(runRoot, `${stage}.jsonl`), [
      event(0, 'unit_planned', { unit_id: `${stage}-unit` }),
      event(1, 'stage_plan_completed', {}),
      event(2, 'unit_terminal', { unit_id: `${stage}-unit`, status: 'succeeded' }),
      event(3, 'stage_completed', { accepted_count: 1 }),
    ]);
  }

  let result = runStatus(runtimeRoot, runId);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /acceptance_ready=false/);

  await writeJournal(path.join(runRoot, 'control.jsonl'), [
    event(0, 'run_started', { run_id: runId }),
    ...stages.map((stage, index) => event(index + 1, 'stage_opened', { stage })),
    event(stages.length + 1, 'run_completed', { run_id: runId, stage_count: 8 }),
  ]);
  result = runStatus(runtimeRoot, runId);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /acceptance_ready=true/);
});
