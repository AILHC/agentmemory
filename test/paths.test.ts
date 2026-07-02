import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { homedir } from "node:os";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { agentMemoryHome, agentMemoryInstallHome } from "../src/paths.js";

describe("agentmemory path helpers", () => {
  let homeEnv: string | undefined;
  let installHomeEnv: string | undefined;

  beforeEach(() => {
    homeEnv = process.env["AGENTMEMORY_HOME"];
    installHomeEnv = process.env["AGENTMEMORY_INSTALL_HOME"];
    delete process.env["AGENTMEMORY_HOME"];
    delete process.env["AGENTMEMORY_INSTALL_HOME"];
  });

  afterEach(() => {
    if (homeEnv === undefined) delete process.env["AGENTMEMORY_HOME"];
    else process.env["AGENTMEMORY_HOME"] = homeEnv;
    if (installHomeEnv === undefined) delete process.env["AGENTMEMORY_INSTALL_HOME"];
    else process.env["AGENTMEMORY_INSTALL_HOME"] = installHomeEnv;
  });

  it("uses default ~/.agentmemory when env is not set", () => {
    expect(agentMemoryHome("bin", "iii")).toBe(resolve(homedir(), ".agentmemory", "bin", "iii"));
    expect(agentMemoryInstallHome("bin", "iii")).toBe(resolve(homedir(), ".agentmemory", "bin", "iii"));
  });

  it("keeps install home independent from AGENTMEMORY_HOME", () => {
    const stateHome = join(tmpdir(), "agentmemory-home");
    const installHome = join(tmpdir(), "agentmemory-install");
    process.env["AGENTMEMORY_HOME"] = stateHome;
    process.env["AGENTMEMORY_INSTALL_HOME"] = installHome;

    expect(agentMemoryHome("iii.pid")).toBe(resolve(stateHome, "iii.pid"));
    expect(agentMemoryInstallHome("bin", "iii")).toBe(
      resolve(installHome, "bin", "iii"),
    );
  });

  it("falls back install home to ~/.agentmemory when AGENTMEMORY_INSTALL_HOME is missing", () => {
    const stateHome = join(tmpdir(), "agentmemory-home");
    process.env["AGENTMEMORY_HOME"] = stateHome;
    expect(agentMemoryHome("iii.pid")).toBe(resolve(stateHome, "iii.pid"));
    expect(agentMemoryInstallHome("iii")).toBe(resolve(homedir(), ".agentmemory", "iii"));
  });
});
