import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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
  const durablePayload = { ...payload };
  if (
    ['unit_started', 'unit_terminal', 'unit_blocked'].includes(type)
    && durablePayload.unit_id
    && !durablePayload.attempt_id
  ) {
    durablePayload.attempt_id = `attempt-${durablePayload.unit_id}`;
  }
  const item = { seq, at, type, payload: durablePayload };
  return {
    ...item,
    checksum: createHash('sha256').update(JSON.stringify(item)).digest('hex'),
  };
}

async function writeJournal(filePath, events) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const expandLegacyStage = events.some((item) => item.type === 'stage_completed');
  const startedUnits = new Set(events
    .filter((item) => item.type === 'unit_started')
    .map((item) => item.payload.unit_id));
  const withRecords = expandLegacyStage
    ? events.flatMap((item) => {
        if (
          item.type !== 'unit_terminal'
          || !['succeeded', 'skipped'].includes(item.payload.status)
        ) return [item];
        const prefix = startedUnits.has(item.payload.unit_id)
          ? []
          : [event(-1, 'unit_started', {
              unit_id: item.payload.unit_id,
              attempt_id: item.payload.attempt_id,
            }, item.at)];
        return [
          ...prefix,
          item,
          event(-1, 'unit_recorded', {
            unit_id: item.payload.unit_id,
            attempt_id: item.payload.attempt_id,
          }, item.at),
        ];
      })
    : events;
  const durableEvents = withRecords.map(({ seq: sourceSeq, at, type, payload }, index) => {
    const seq = expandLegacyStage ? index : sourceSeq;
    const item = { seq, at, type, payload };
    return {
      ...item,
      checksum: createHash('sha256').update(JSON.stringify(item)).digest('hex'),
    };
  });
  await fs.writeFile(
    filePath,
    `${durableEvents.map((item) => JSON.stringify(item)).join('\n')}\n`,
    'utf8',
  );
}

function runStatus(runtimeRoot, runId, requiredStages = '') {
  return runStatusWithShell('powershell.exe', runtimeRoot, runId, requiredStages);
}

function runStatusWithShell(shell, runtimeRoot, runId, requiredStages = '') {
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
  return spawnSync(shell, args, {
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
    /stage\.summary=succeeded:1,skipped:0,failed:0,pending:0,running:1,blocked:0/,
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

test('v2 journal 单独报告 blocked 且不把它计入 running', async (context) => {
  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-v2-status-blocked-'));
  context.after(() => fs.rm(runtimeRoot, { recursive: true, force: true }));
  const runId = 'v2-blocked';
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
    event(4, 'unit_blocked', {
      unit_id: 'session-a',
      reason: 'extraction_operation_reconciliation_required',
    }),
  ]);

  const result = runStatus(runtimeRoot, runId, 'summary');

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /acceptance_ready=false/);
  assert.match(
    result.stdout,
    /stage\.summary=succeeded:0,skipped:0,failed:0,pending:1,running:0,blocked:1/,
  );
});

test('v2 journal 在受控协调后把原 blocked 单元恢复为 running', async (context) => {
  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-v2-status-reconciled-'));
  context.after(() => fs.rm(runtimeRoot, { recursive: true, force: true }));
  const runId = 'v2-reconciled';
  const runRoot = path.join(runtimeRoot, 'extraction-runs', `${runId}.v2`);
  await writeJournal(path.join(runRoot, 'control.jsonl'), [
    event(0, 'run_started', { run_id: runId }),
    event(1, 'stage_opened', { stage: 'summary' }),
  ]);
  await writeJournal(path.join(runRoot, 'summary.jsonl'), [
    event(0, 'unit_planned', { unit_id: 'session-a', input_hash: 'b'.repeat(64) }),
    event(1, 'stage_plan_completed', {}),
    event(2, 'unit_started', {
      unit_id: 'session-a',
      attempt_id: 'a'.repeat(64),
    }),
    event(3, 'unit_operation_started', {
      unit_id: 'session-a',
      attempt_id: 'a'.repeat(64),
      operation_id: 'session-a:reduce',
    }),
    event(4, 'unit_blocked', {
      unit_id: 'session-a',
      attempt_id: 'a'.repeat(64),
      reason: 'extraction_operation_reconciliation_required',
    }),
    event(5, 'unit_reconciliation_resolved', {
      unit_id: 'session-a',
      attempt_id: 'a'.repeat(64),
      operation_id: 'session-a:reduce',
      reconciliation_id: `xrec_${'1'.repeat(32)}`,
      receipt_input_hash: 'c'.repeat(64),
      receipt_started_at: '2026-07-30T00:00:00.000Z',
      receipt_status: 'reconciled',
      result_status: 'absent',
      cause: 'orphaned_operation_result_absent',
    }),
  ]);

  const result = runStatus(runtimeRoot, runId, 'summary');

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /acceptance_ready=false/);
  assert.match(
    result.stdout,
    /stage\.summary=succeeded:0,skipped:0,failed:0,pending:0,running:1,blocked:0/,
  );
});

test('v2 journal 在追加重试授权后保留旧失败事件并把当前投影恢复为 pending', async (context) => {
  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-v2-status-retry-authorized-'));
  context.after(() => fs.rm(runtimeRoot, { recursive: true, force: true }));
  const runId = 'v2-retry-authorized';
  const runRoot = path.join(runtimeRoot, 'extraction-runs', `${runId}.v2`);
  await writeJournal(path.join(runRoot, 'control.jsonl'), [
    event(0, 'run_started', { run_id: runId }),
    event(1, 'stage_opened', { stage: 'summary' }),
  ]);
  await writeJournal(path.join(runRoot, 'summary.jsonl'), [
    event(0, 'unit_planned', { unit_id: 'session-a', input_hash: 'b'.repeat(64) }),
    event(1, 'stage_plan_completed', {}),
    event(2, 'unit_started', {
      unit_id: 'session-a',
      attempt_id: 'a'.repeat(64),
    }),
    event(3, 'unit_operation_started', {
      unit_id: 'session-a',
      attempt_id: 'a'.repeat(64),
      operation_id: 'session-a:reduce',
    }),
    event(4, 'unit_operation_completed', {
      unit_id: 'session-a',
      attempt_id: 'a'.repeat(64),
      operation_id: 'session-a:reduce',
      status: 'failed',
      error: 'pi_stream_failed',
      terminal_result: {
        status: 'failed',
        payload: { error: 'pi_stream_failed' },
      },
    }),
    event(5, 'unit_terminal', {
      unit_id: 'session-a',
      attempt_id: 'a'.repeat(64),
      status: 'failed',
      error: 'pi_stream_failed',
    }),
    event(6, 'unit_summary_failed_terminal_retry_authorized', {
      stage: 'summary',
      unit_id: 'session-a',
      attempt_id: 'a'.repeat(64),
      operation_id: 'session-a:reduce',
      runner_input_hash: 'b'.repeat(64),
      receipt_input_hash: 'c'.repeat(64),
      receipt_status: 'failed',
      failure_class: 'transient_provider',
      failure_cause: 'pi_stream_failed',
      failure_phase: 'provider_call',
      retry_epoch: 0,
      last_safe_failure: {
        error_class: 'transient_provider',
        cause: 'pi_stream_failed',
        phase: 'provider_call',
        timestamp: '2026-07-28T00:00:00.000Z',
      },
      superseded_operation_seq: 4,
      superseded_terminal_seq: 5,
      expected_journal_seq: 5,
    }),
  ]);

  const result = runStatus(runtimeRoot, runId, 'summary');

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(
    result.stdout,
    /stage\.summary=succeeded:0,skipped:0,failed:0,pending:1,running:0,blocked:0/,
  );
  const persisted = await fs.readFile(path.join(runRoot, 'summary.jsonl'), 'utf8');
  assert.match(persisted, /"unit_operation_completed"/);
  assert.match(persisted, /"unit_terminal"/);
  assert.match(persisted, /"unit_summary_failed_terminal_retry_authorized"/);

  const pwsh = spawnSync('pwsh', ['-NoProfile', '-Command', 'exit 0'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (pwsh.status === 0) {
    const modernResult = runStatusWithShell('pwsh', runtimeRoot, runId, 'summary');
    assert.equal(modernResult.status, 0, modernResult.stderr || modernResult.stdout);
    assert.match(
      modernResult.stdout,
      /stage\.summary=succeeded:0,skipped:0,failed:0,pending:1,running:0,blocked:0/,
    );
  }
});

test('v2 lessons 只接受零结果且身份完整的失败终态重试授权', async (context) => {
  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-v2-status-lessons-retry-'));
  context.after(() => fs.rm(runtimeRoot, { recursive: true, force: true }));
  const runId = 'v2-lessons-retry-authorized';
  const runRoot = path.join(runtimeRoot, 'extraction-runs', `${runId}.v2`);
  await writeJournal(path.join(runRoot, 'control.jsonl'), [
    event(0, 'run_started', { run_id: runId }),
    event(1, 'stage_opened', { stage: 'lessons' }),
  ]);
  const authorization = event(4, 'unit_lessons_failed_terminal_retry_authorized', {
    stage: 'lessons',
    unit_id: 'session-a',
    attempt_id: 'a'.repeat(64),
    runner_input_hash: 'b'.repeat(64),
    receipt_input_hash: 'c'.repeat(64),
    receipt_status: 'failed',
    receipt_failure_class: 'transient_provider',
    receipt_failure_cause: 'lesson_extraction_failed',
    failure_class: 'transient_provider',
    failure_cause: 'lesson_extraction_failed',
    failure_phase: 'provider_call',
    retry_epoch: 0,
    last_safe_failure: {
      error_class: 'transient_provider',
      cause: 'lesson_extraction_failed',
      phase: 'provider_call',
      timestamp: '2026-07-28T00:00:00.000Z',
    },
    lesson_run_evidence: {
      status: 'retryable',
      input_hash: 'd'.repeat(64),
      config_hash: 'e'.repeat(64),
      failure_cause: 'timeout',
      failure_phase: 'provider_call',
      failed_at: '2026-07-28T00:00:00.000Z',
      created_lesson_count: 0,
      replaced_lesson_count: 0,
      chunk_lesson_count: 0,
    },
    superseded_terminal_seq: 3,
    expected_journal_seq: 3,
  });
  const baseEvents = [
    event(0, 'unit_planned', { unit_id: 'session-a', input_hash: 'b'.repeat(64) }),
    event(1, 'stage_plan_completed', {}),
    event(2, 'unit_started', {
      unit_id: 'session-a',
      attempt_id: 'a'.repeat(64),
    }),
    event(3, 'unit_terminal', {
      unit_id: 'session-a',
      attempt_id: 'a'.repeat(64),
      status: 'failed',
      error: 'lesson_extraction_failed',
    }),
  ];
  await writeJournal(path.join(runRoot, 'lessons.jsonl'), [...baseEvents, authorization]);

  const accepted = runStatus(runtimeRoot, runId, 'lessons');
  assert.equal(accepted.status, 0, accepted.stderr || accepted.stdout);
  assert.match(
    accepted.stdout,
    /stage\.lessons=succeeded:0,skipped:0,failed:0,pending:1,running:0,blocked:0/,
  );

  authorization.payload.lesson_run_evidence.created_lesson_count = 1;
  await writeJournal(path.join(runRoot, 'lessons.jsonl'), [...baseEvents, authorization]);
  const rejected = runStatus(runtimeRoot, runId, 'lessons');
  assert.equal(rejected.status, 0, rejected.stderr || rejected.stdout);
  assert.match(
    rejected.stdout,
    /stage\.lessons=succeeded:0,skipped:0,failed:1,pending:0,running:0,blocked:0/,
  );
});

test('v2 status 忽略证据不完整的 summary 重试授权并保留 failed', async (context) => {
  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-v2-status-invalid-auth-'));
  context.after(() => fs.rm(runtimeRoot, { recursive: true, force: true }));
  const runId = 'v2-invalid-auth';
  const runRoot = path.join(runtimeRoot, 'extraction-runs', `${runId}.v2`);
  await writeJournal(path.join(runRoot, 'control.jsonl'), [
    event(0, 'run_started', { run_id: runId }),
    event(1, 'stage_opened', { stage: 'summary' }),
  ]);
  await writeJournal(path.join(runRoot, 'summary.jsonl'), [
    event(0, 'unit_planned', { unit_id: 'session-a', input_hash: 'b'.repeat(64) }),
    event(1, 'stage_plan_completed', {}),
    event(2, 'unit_started', {
      unit_id: 'session-a',
      attempt_id: 'a'.repeat(64),
    }),
    event(3, 'unit_operation_started', {
      unit_id: 'session-a',
      attempt_id: 'a'.repeat(64),
      operation_id: 'session-a:reduce',
    }),
    event(4, 'unit_operation_completed', {
      unit_id: 'session-a',
      attempt_id: 'a'.repeat(64),
      operation_id: 'session-a:reduce',
      status: 'failed',
      error: 'pi_stream_failed',
      terminal_result: {
        status: 'failed',
        payload: { error: 'pi_stream_failed' },
      },
    }),
    event(5, 'unit_terminal', {
      unit_id: 'session-a',
      attempt_id: 'a'.repeat(64),
      status: 'failed',
      error: 'pi_stream_failed',
    }),
    event(6, 'unit_summary_failed_terminal_retry_authorized', {
      stage: 'summary',
      unit_id: 'session-a',
      attempt_id: 'a'.repeat(64),
      operation_id: 'session-a:reduce',
      superseded_operation_seq: 4,
      superseded_terminal_seq: 5,
    }),
  ]);

  const result = runStatus(runtimeRoot, runId, 'summary');

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(
    result.stdout,
    /stage\.summary=succeeded:0,skipped:0,failed:1,pending:0,running:0,blocked:0/,
  );
});

test('v2 status 严格拒绝非整数数值和大小写变体的 summary 重试授权', async () => {
  const variants = [
    ['string retry epoch', (authorization) => { authorization.payload.retry_epoch = '0'; }],
    ['floating retry epoch', (authorization) => { authorization.payload.retry_epoch = 0.5; }],
    ['failure class case', (authorization) => {
      authorization.payload.failure_class = 'Transient_provider';
      authorization.payload.last_safe_failure.error_class = 'Transient_provider';
    }],
    ['failure phase case', (authorization) => {
      authorization.payload.failure_phase = 'Provider_call';
      authorization.payload.last_safe_failure.phase = 'Provider_call';
    }],
    ['string event seq', (authorization) => { authorization.seq = '6'; }],
    ['string evidence seq', (authorization) => {
      authorization.payload.superseded_operation_seq = '4';
    }],
  ];

  for (const [name, mutate] of variants) {
    const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-v2-status-strict-auth-'));
    const runId = `v2-strict-auth-${name.replaceAll(' ', '-')}`;
    const runRoot = path.join(runtimeRoot, 'extraction-runs', `${runId}.v2`);
    try {
      await writeJournal(path.join(runRoot, 'control.jsonl'), [
        event(0, 'run_started', { run_id: runId }),
        event(1, 'stage_opened', { stage: 'summary' }),
      ]);
      const authorization = event(6, 'unit_summary_failed_terminal_retry_authorized', {
        stage: 'summary',
        unit_id: 'session-a',
        attempt_id: 'a'.repeat(64),
        operation_id: 'session-a:reduce',
        runner_input_hash: 'b'.repeat(64),
        receipt_input_hash: 'c'.repeat(64),
        receipt_status: 'failed',
        failure_class: 'transient_provider',
        failure_cause: 'pi_stream_failed',
        failure_phase: 'provider_call',
        retry_epoch: 0,
        last_safe_failure: {
          error_class: 'transient_provider',
          cause: 'pi_stream_failed',
          phase: 'provider_call',
          timestamp: '2026-07-28T00:00:00.000Z',
        },
        superseded_operation_seq: 4,
        superseded_terminal_seq: 5,
        expected_journal_seq: 5,
      });
      mutate(authorization);
      await writeJournal(path.join(runRoot, 'summary.jsonl'), [
        event(0, 'unit_planned', { unit_id: 'session-a', input_hash: 'b'.repeat(64) }),
        event(1, 'stage_plan_completed', {}),
        event(2, 'unit_started', {
          unit_id: 'session-a',
          attempt_id: 'a'.repeat(64),
        }),
        event(3, 'unit_operation_started', {
          unit_id: 'session-a',
          attempt_id: 'a'.repeat(64),
          operation_id: 'session-a:reduce',
        }),
        event(4, 'unit_operation_completed', {
          unit_id: 'session-a',
          attempt_id: 'a'.repeat(64),
          operation_id: 'session-a:reduce',
          status: 'failed',
          error: 'pi_stream_failed',
          terminal_result: {
            status: 'failed',
            payload: { error: 'pi_stream_failed' },
          },
        }),
        event(5, 'unit_terminal', {
          unit_id: 'session-a',
          attempt_id: 'a'.repeat(64),
          status: 'failed',
          error: 'pi_stream_failed',
        }),
        authorization,
      ]);

      const result = runStatus(runtimeRoot, runId, 'summary');

      if (name === 'string event seq') {
        assert.notEqual(result.status, 0, name);
        assert.match(result.stderr, /safe recovery status projection failed/, name);
        continue;
      }
      assert.equal(result.status, 0, `${name}: ${result.stderr || result.stdout}`);
      assert.match(
        result.stdout,
        /stage\.summary=succeeded:0,skipped:0,failed:1,pending:0,running:0,blocked:0/,
        name,
      );
    } finally {
      await fs.rm(runtimeRoot, { recursive: true, force: true });
    }
  }
});

test('v2 status 在授权后的新 operation_started 上重新报告 running', async (context) => {
  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agentmemory-v2-status-auth-running-'));
  context.after(() => fs.rm(runtimeRoot, { recursive: true, force: true }));
  const runId = 'v2-auth-running';
  const runRoot = path.join(runtimeRoot, 'extraction-runs', `${runId}.v2`);
  await writeJournal(path.join(runRoot, 'control.jsonl'), [
    event(0, 'run_started', { run_id: runId }),
    event(1, 'stage_opened', { stage: 'summary' }),
  ]);
  const authorizedEvents = [
    event(0, 'unit_planned', { unit_id: 'session-a', input_hash: 'b'.repeat(64) }),
    event(1, 'stage_plan_completed', {}),
    event(2, 'unit_started', { unit_id: 'session-a', attempt_id: 'a'.repeat(64) }),
    event(3, 'unit_operation_started', {
      unit_id: 'session-a',
      attempt_id: 'a'.repeat(64),
      operation_id: 'session-a:reduce',
    }),
    event(4, 'unit_operation_completed', {
      unit_id: 'session-a',
      attempt_id: 'a'.repeat(64),
      operation_id: 'session-a:reduce',
      status: 'failed',
      error: 'pi_stream_failed',
      terminal_result: {
        status: 'failed',
        payload: { error: 'pi_stream_failed' },
      },
    }),
    event(5, 'unit_terminal', {
      unit_id: 'session-a',
      attempt_id: 'a'.repeat(64),
      status: 'failed',
      error: 'pi_stream_failed',
    }),
    event(6, 'unit_summary_failed_terminal_retry_authorized', {
      stage: 'summary',
      unit_id: 'session-a',
      attempt_id: 'a'.repeat(64),
      operation_id: 'session-a:reduce',
      runner_input_hash: 'b'.repeat(64),
      receipt_input_hash: 'c'.repeat(64),
      receipt_status: 'failed',
      failure_class: 'transient_provider',
      failure_cause: 'pi_stream_failed',
      failure_phase: 'provider_call',
      retry_epoch: 0,
      last_safe_failure: {
        error_class: 'transient_provider',
        cause: 'pi_stream_failed',
        phase: 'provider_call',
        timestamp: '2026-07-28T00:00:00.000Z',
      },
      superseded_operation_seq: 4,
      superseded_terminal_seq: 5,
      expected_journal_seq: 5,
    }),
    event(7, 'unit_operation_started', {
      unit_id: 'session-a',
      attempt_id: 'a'.repeat(64),
      operation_id: 'session-a:reduce',
    }),
  ];
  await writeJournal(path.join(runRoot, 'summary.jsonl'), authorizedEvents);

  const result = runStatus(runtimeRoot, runId, 'summary');

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(
    result.stdout,
    /stage\.summary=succeeded:0,skipped:0,failed:0,pending:0,running:1,blocked:0/,
  );
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
