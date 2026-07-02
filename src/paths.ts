import { homedir } from "node:os";
import { join, resolve } from "node:path";

export function agentMemoryHome(...segments: string[]): string {
  // 状态文件（pid/state/.env/preferences/data/...）使用 AGENTMEMORY_HOME 隔离，
  // 保证不同用户状态目录互不影响。
  const raw = process.env["AGENTMEMORY_HOME"]?.trim();
  const base = raw ? resolve(raw) : join(homedir(), ".agentmemory");
  return segments.length > 0 ? join(base, ...segments) : base;
}

export function agentMemoryInstallHome(...segments: string[]): string {
  // 引擎二进制安装目录（私有）与 AGENTMEMORY_HOME 解耦，
  // 避免状态目录迁移时误带走已安装的 iii 引擎二进制。
  const raw = process.env["AGENTMEMORY_INSTALL_HOME"]?.trim();
  const base = raw ? resolve(raw) : join(homedir(), ".agentmemory");
  return segments.length > 0 ? join(base, ...segments) : base;
}
