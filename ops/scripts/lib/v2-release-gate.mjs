import fs from 'node:fs/promises';
import path from 'node:path';

const MAX_V1_STATUS_BYTES = 1024 * 1024;

function artifactIdentity(name) {
  for (const [suffix, kind] of [
    ['.json.lock', 'lock'],
    ['.journal.jsonl', 'journal'],
    ['.status.json', 'status'],
    ['.json', 'snapshot'],
  ]) {
    if (name.endsWith(suffix) && name.length > suffix.length) {
      return { runId: name.slice(0, -suffix.length), kind };
    }
  }
  return null;
}

function statusProvesCompleted(status) {
  return status?.coverage?.acceptance_ready === true
    && (status?.current_stage === null || status?.current_stage === undefined)
    && Number(status?.in_flight_gaps?.total || 0) === 0;
}

async function readBoundedStatus(statusPath, fsApi) {
  const metadata = await fsApi.stat(statusPath);
  if (!metadata.isFile() || metadata.size > MAX_V1_STATUS_BYTES) {
    throw new Error('v1_status_not_bounded');
  }
  return JSON.parse(await fsApi.readFile(statusPath, 'utf8'));
}

export async function inspectV1ReleaseGate(stateDir, { fsApi = fs } = {}) {
  let entries;
  try {
    entries = await fsApi.readdir(stateDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return { ready: true, blockers: [] };
    throw error;
  }
  const runs = new Map();
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const identity = artifactIdentity(entry.name);
    if (!identity) continue;
    const run = runs.get(identity.runId) || { run_id: identity.runId, artifacts: new Set() };
    run.artifacts.add(identity.kind);
    runs.set(identity.runId, run);
  }

  const blockers = [];
  for (const run of [...runs.values()].sort((left, right) => left.run_id.localeCompare(right.run_id))) {
    if (run.artifacts.has('lock')) {
      blockers.push({ run_id: run.run_id, reason: 'v1_lock_present' });
      continue;
    }
    if (!run.artifacts.has('status')) {
      blockers.push({ run_id: run.run_id, reason: 'v1_completion_unproven' });
      continue;
    }
    try {
      const status = await readBoundedStatus(
        path.join(stateDir, `${run.run_id}.status.json`),
        fsApi,
      );
      if (!statusProvesCompleted(status)) {
        blockers.push({ run_id: run.run_id, reason: 'v1_run_incomplete' });
      }
    } catch {
      blockers.push({ run_id: run.run_id, reason: 'v1_status_invalid' });
    }
  }
  return { ready: blockers.length === 0, blockers };
}

export async function assertV1ReleaseGate(stateDir, options = {}) {
  const result = await inspectV1ReleaseGate(stateDir, options);
  if (!result.ready) {
    const detail = result.blockers
      .map((blocker) => `${blocker.run_id}:${blocker.reason}`)
      .join(',');
    throw new Error(`v2_v1_release_gate_blocked:${detail}`);
  }
  return result;
}
