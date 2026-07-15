import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export interface WorkerLifecycleIdentity {
  supervisorPid: number;
  supervisorStartedAt: string;
  instanceId: string;
}

interface WorkerLockRecord extends WorkerLifecycleIdentity {
  schemaVersion: 1;
  workerPid: number;
  workerStartedAt: string;
}

export interface WorkerLifecycleLock {
  record: WorkerLockRecord;
  release(): void;
}

export function readWorkerLifecycleIdentity(
  environment: Record<string, string | undefined>,
  parentPid: number,
): WorkerLifecycleIdentity {
  const supervisorPid = Number(environment.AGENTMEMORY_SUPERVISOR_PID);
  const supervisorStartedAt = environment.AGENTMEMORY_SUPERVISOR_STARTED_AT?.trim() ?? "";
  const instanceId = environment.AGENTMEMORY_INSTANCE_ID?.trim() ?? "";
  if (!Number.isSafeInteger(supervisorPid) || supervisorPid <= 0) throw new Error("WORKER_SUPERVISOR_PID_INVALID");
  if (supervisorPid !== parentPid) throw new Error("WORKER_PARENT_MISMATCH");
  if (!supervisorStartedAt || Number.isNaN(Date.parse(supervisorStartedAt))) throw new Error("WORKER_SUPERVISOR_STARTED_AT_INVALID");
  if (!instanceId) throw new Error("WORKER_INSTANCE_ID_INVALID");
  return { supervisorPid, supervisorStartedAt, instanceId };
}

export function readOptionalWorkerLifecycleIdentity(
  environment: Record<string, string | undefined>,
  parentPid: number,
): WorkerLifecycleIdentity | null {
  const values = [
    environment.AGENTMEMORY_SUPERVISOR_PID,
    environment.AGENTMEMORY_SUPERVISOR_STARTED_AT,
    environment.AGENTMEMORY_INSTANCE_ID,
  ];
  if (values.every((value) => value === undefined)) return null;
  return readWorkerLifecycleIdentity(environment, parentPid);
}

export function resolveWorkerLifecycleIdentity(
  environment: Record<string, string | undefined>,
  parentPid: number,
  startedAt = new Date(),
): WorkerLifecycleIdentity {
  const supervised = readOptionalWorkerLifecycleIdentity(environment, parentPid);
  if (supervised) return supervised;
  if (!Number.isSafeInteger(parentPid) || parentPid <= 0) throw new Error("WORKER_PARENT_INVALID");
  const supervisorStartedAt = startedAt.toISOString();
  return {
    supervisorPid: parentPid,
    supervisorStartedAt,
    instanceId: "legacy-direct",
  };
}

function readWorkerLock(path: string): WorkerLockRecord | null {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as WorkerLockRecord;
    if (
      value.schemaVersion !== 1 ||
      !Number.isSafeInteger(value.workerPid) ||
      value.workerPid <= 0 ||
      !Number.isSafeInteger(value.supervisorPid) ||
      value.supervisorPid <= 0 ||
      !value.instanceId ||
      !value.supervisorStartedAt ||
      Number.isNaN(Date.parse(value.supervisorStartedAt)) ||
      !value.workerStartedAt ||
      Number.isNaN(Date.parse(value.workerStartedAt))
    ) return null;
    return value;
  } catch {
    return null;
  }
}

function archive(path: string): void {
  if (!existsSync(path)) return;
  renameSync(path, `${path}.stale-${Date.now()}`);
}

export function assertWorkerSlotAvailable(
  home: string,
  isProcessAlive: (pid: number) => boolean,
): void {
  const lockPath = join(home, "worker.lock.json");
  const pidPath = join(home, "worker.pid");
  const record = readWorkerLock(lockPath);
  if (!record) {
    if (existsSync(lockPath)) throw new Error("WORKER_LOCK_INVALID");
    if (!existsSync(pidPath)) return;
    let legacyPid = Number.NaN;
    try { legacyPid = Number(readFileSync(pidPath, "utf8").trim()); } catch {}
    if (Number.isSafeInteger(legacyPid) && legacyPid > 0 && isProcessAlive(legacyPid)) {
      throw new Error("LIVE_WORKER_PID_PRESENT");
    }
    archive(pidPath);
    return;
  }
  if (isProcessAlive(record.workerPid)) throw new Error("LIVE_WORKER_LOCK_PRESENT");
  archive(lockPath);
  if (existsSync(pidPath)) archive(pidPath);
}

export function acquireWorkerLifecycleLock(options: {
  home: string;
  workerPid: number;
  parentPid: number;
  identity: WorkerLifecycleIdentity;
  isProcessAlive?: (pid: number) => boolean;
  now?: () => Date;
}): WorkerLifecycleLock {
  if (options.parentPid !== options.identity.supervisorPid) throw new Error("WORKER_PARENT_MISMATCH");
  mkdirSync(options.home, { recursive: true });
  const lockPath = join(options.home, "worker.lock.json");
  assertWorkerSlotAvailable(options.home, options.isProcessAlive ?? isProcessAlive);
  const record: WorkerLockRecord = {
    schemaVersion: 1,
    workerPid: options.workerPid,
    supervisorPid: options.identity.supervisorPid,
    supervisorStartedAt: options.identity.supervisorStartedAt,
    instanceId: options.identity.instanceId,
    workerStartedAt: (options.now ?? (() => new Date()))().toISOString(),
  };
  const descriptor = openSync(lockPath, "wx");
  try {
    writeFileSync(descriptor, `${JSON.stringify(record)}\n`, "utf8");
  } finally {
    closeSync(descriptor);
  }
  writeFileSync(join(options.home, "worker.pid"), `${options.workerPid}\n`, "utf8");

  let released = false;
  return {
    record,
    release() {
      if (released) return;
      released = true;
      const current = readWorkerLock(lockPath);
      if (current?.workerPid !== record.workerPid || current.supervisorPid !== record.supervisorPid || current.workerStartedAt !== record.workerStartedAt) return;
      try { unlinkSync(lockPath); } catch {}
      try {
        const pid = Number(readFileSync(join(options.home, "worker.pid"), "utf8").trim());
        if (pid === record.workerPid) unlinkSync(join(options.home, "worker.pid"));
      } catch {}
    },
  };
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function createWorkerShutdownCoordinator(cleanup: () => Promise<void>): {
  request(): Promise<void>;
} {
  let shutdown: Promise<void> | null = null;
  return {
    request() {
      shutdown ??= cleanup();
      return shutdown;
    },
  };
}
