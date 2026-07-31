import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockKv = {
  get: vi.fn(),
  set: vi.fn(),
  list: vi.fn(),
  delete: vi.fn(),
};

const mockSdk = {
  registerFunction: vi.fn(),
};

const mockProvider = {
  name: "test",
  compress: vi.fn(),
  summarize: vi.fn(),
};

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../src/functions/audit.js", () => ({
  recordAudit: vi.fn(),
}));

import { registerSkillExtractFunctions } from "../src/functions/skill-extract.js";
import { KV } from "../src/state/schema.js";

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    .filter(([, child]) => child !== undefined)
    .map(([key, child]) => [key, canonical(child)]));
}

describe("skill-extract", () => {
  let handlers: Record<string, Function>;

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.AGENTMEMORY_OUTPUT_LANGUAGE;
    mockProvider.name = "test";
    mockKv.get.mockResolvedValue(null);
    mockKv.set.mockResolvedValue(undefined);
    mockKv.list.mockResolvedValue([]);

    handlers = {};
    mockSdk.registerFunction.mockImplementation((idOrMeta: any, handler: any) => {
      const id = typeof idOrMeta === "string" ? idOrMeta : idOrMeta.id;
      handlers[id] = handler;
    });

    registerSkillExtractFunctions(mockSdk as any, mockKv as any, mockProvider);
  });

  afterEach(() => {
    delete process.env.AGENTMEMORY_OUTPUT_LANGUAGE;
  });

  it("registers all skill functions", () => {
    expect(handlers["mem::skill-extract"]).toBeDefined();
    expect(handlers["mem::full-skill-extract-prepare"]).toBeDefined();
    expect(handlers["mem::full-skill-extract-commit"]).toBeDefined();
    expect(handlers["mem::skill-list"]).toBeDefined();
    expect(handlers["mem::skill-match"]).toBeDefined();
  });

  it("skill-extract requires sessionId", async () => {
    const result = await handlers["mem::skill-extract"]({});
    expect(result.success).toBe(false);
  });

  it("skill-extract returns error for missing session", async () => {
    mockKv.get.mockReturnValue(Promise.resolve(null));
    const result = await handlers["mem::skill-extract"]({
      sessionId: "nonexistent",
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("session not found");
  });

  it("rejects a fresh prepare when source drift changes the absence-bound input hash", async () => {
    mockKv.get.mockImplementation((scope: string) => {
      if (scope === KV.sessions) {
        return Promise.resolve({
          id: "s1",
          project: "test",
          status: "completed",
          startedAt: "2026-07-30T00:00:00.000Z",
        });
      }
      if (scope === KV.summaries) {
        return Promise.resolve({
          sessionId: "s1",
          title: "Changed summary",
          narrative: "The source changed after the receipt absence probe.",
          keyDecisions: ["Reject drift"],
          filesModified: ["src/recovery.ts"],
          concepts: ["recovery"],
        });
      }
      return Promise.resolve(null);
    });
    mockKv.list.mockResolvedValue(Array.from({ length: 3 }, (_, index) => ({
      id: `obs-${index}`,
      sessionId: "s1",
      timestamp: `2026-07-30T00:00:0${index}.000Z`,
      type: "file_edit",
      title: `Edit ${index}`,
      narrative: `Changed source ${index}`,
      importance: 8,
    })));

    const result = await handlers["mem::full-skill-extract-prepare"]({
      identity: {
        runId: "skill-drift-attempt",
        stage: "skill_extract",
        unitId: "s1",
        inputHash: "a".repeat(64),
      },
      sessionId: "s1",
      operationReceiptManaged: true,
      expectedReceiptInputHash: "b".repeat(64),
    });

    expect(result).toMatchObject({
      success: false,
      status: "failed",
      failure: {
        class: "hard",
        cause: "extraction_operation_input_hash_drifted_after_absence",
      },
    });
    expect(mockProvider.summarize).not.toHaveBeenCalled();
  });

  it("persists and replays a provider failure without creating skill effects", async () => {
    const store = new Map<string, Map<string, any>>();
    const put = (scope: string, key: string, value: any) => {
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, structuredClone(value));
    };
    put(KV.sessions, "s1", {
      id: "s1",
      project: "test",
      status: "completed",
      startedAt: "2026-07-30T00:00:00.000Z",
    });
    put(KV.summaries, "s1", {
      sessionId: "s1",
      project: "test",
      title: "Provider failure",
      narrative: "The provider fails before a proposal can be frozen.",
      keyDecisions: ["Do not write effects"],
      filesModified: [],
      concepts: ["recovery"],
    });
    for (let index = 0; index < 3; index += 1) {
      put(KV.observations("s1"), `obs-${index}`, {
        id: `obs-${index}`,
        sessionId: "s1",
        timestamp: `2026-07-30T00:00:0${index}.000Z`,
        type: "file_edit",
        title: `Step ${index}`,
        narrative: "Attempted a repeatable change.",
        importance: 8,
      });
    }
    mockKv.get.mockImplementation(async (scope: string, key: string) => {
      const value = store.get(scope)?.get(key);
      return value === undefined ? null : structuredClone(value);
    });
    mockKv.set.mockImplementation(async (scope: string, key: string, value: any) => {
      put(scope, key, value);
      return value;
    });
    mockKv.list.mockImplementation(async (scope: string) =>
      [...(store.get(scope)?.values() ?? [])].map((value) => structuredClone(value)));
    mockProvider.summarize.mockRejectedValue(new Error("pi_stream_failed"));
    const input = {
      identity: {
        runId: "skill-provider-failure",
        stage: "skill_extract",
        unitId: "s1",
        inputHash: "runner-input-hash",
      },
      sessionId: "s1",
      operationReceiptManaged: true,
    };

    const first = await handlers["mem::full-skill-extract-prepare"](input);
    const replay = await handlers["mem::full-skill-extract-prepare"]({
      ...input,
      requireExistingReceipt: true,
    });

    expect(first).toMatchObject({
      success: false,
      status: "failed",
      failure: { class: "transient_provider", cause: "pi_stream_failed" },
    });
    expect(replay).toEqual(first);
    expect(mockProvider.summarize).toHaveBeenCalledTimes(1);
    const receipts = [...store.entries()]
      .filter(([scope]) => scope.startsWith("mem:extraction-operation-receipt:"))
      .flatMap(([, entries]) => [...entries.values()]);
    expect(receipts).toEqual([
      expect.objectContaining({
        status: "failed",
        failure: { class: "transient_provider", cause: "pi_stream_failed" },
      }),
    ]);
    expect(store.get(KV.procedural)?.size ?? 0).toBe(0);
    expect(store.get(KV.audit)?.size ?? 0).toBe(0);
    expect([...store.keys()].some((scope) =>
      scope.startsWith("mem:skill-extraction-proposal:"))).toBe(false);
  });

  it("skill-extract parses LLM response into ProceduralMemory", async () => {
    process.env.AGENTMEMORY_OUTPUT_LANGUAGE = "zh-CN";
    mockKv.get.mockImplementation((scope: string, key: string) => {
      if (scope === "mem:sessions")
        return Promise.resolve({ id: "s1", project: "test", status: "completed" });
      if (scope === "mem:summaries")
        return Promise.resolve({
          sessionId: "s1",
          project: "test",
          title: "Fix auth bug",
          narrative: "Debugged and fixed JWT expiration",
          keyDecisions: ["Switch to RS256"],
          filesModified: ["auth.ts"],
          concepts: ["authentication", "JWT"],
          createdAt: new Date().toISOString(),
          observationCount: 10,
        });
      return Promise.resolve(null);
    });

    mockKv.list.mockReturnValue(
      Promise.resolve(Array.from({ length: 5 }, (_, i) => ({
        id: `obs${i}`,
        sessionId: "s1",
        timestamp: new Date().toISOString(),
        type: "file_edit",
        title: `Edit auth.ts step ${i}`,
        narrative: `Modified JWT validation logic step ${i}`,
        importance: 7,
        concepts: ["JWT"],
        files: ["auth.ts"],
        facts: [],
      }))),
    );

    mockProvider.summarize.mockResolvedValue(`
<skill>
<trigger>When the agent encounters JWT authentication failures or token expiration issues</trigger>
<title>Fix JWT Token Expiration</title>
<steps>
<step>Check the JWT library configuration for clock skew tolerance</step>
<step>Verify the signing algorithm matches between issuer and verifier</step>
<step>Update token expiration to use RS256 with proper key rotation</step>
</steps>
<expected_outcome>JWT auth works reliably with proper expiration handling</expected_outcome>
<tags>jwt,authentication,security</tags>
</skill>
    `);

    const result = await handlers["mem::skill-extract"]({ sessionId: "s1" });
    expect(result.success).toBe(true);
    expect(result.extracted).toBe(true);
    expect(result.skill.name).toBe("Fix JWT Token Expiration");
    expect(result.skill.steps).toHaveLength(3);
    expect(result.skill.triggerCondition).toContain("JWT");
    expect(mockKv.set).toHaveBeenCalled();
    expect(mockProvider.summarize).toHaveBeenCalledWith(
      expect.stringContaining("AgentMemory Output Language Policy"),
      expect.any(String),
    );
  });

  it("skill-extract returns effective model and prompt metrics metadata", async () => {
    mockProvider.name = "pi-agent-sdk";
    process.env.AGENTMEMORY_OUTPUT_LANGUAGE = "zh-CN";
    mockKv.get.mockImplementation((scope: string) => {
      if (scope === "mem:sessions")
        return Promise.resolve({ id: "s1", project: "test", status: "completed" });
      if (scope === "mem:summaries")
        return Promise.resolve({
          sessionId: "s1",
          project: "test",
          title: "Fix auth bug",
          narrative: "Debugged and fixed JWT expiration",
          keyDecisions: ["Switch to RS256"],
          filesModified: ["auth.ts"],
          concepts: ["authentication", "JWT"],
          createdAt: new Date().toISOString(),
          observationCount: 10,
        });
      return Promise.resolve(null);
    });
    mockKv.list.mockReturnValue(
      Promise.resolve(Array.from({ length: 5 }, (_, i) => ({
        id: `obs${i}`,
        sessionId: "s1",
        timestamp: new Date().toISOString(),
        type: "file_edit",
        title: `Edit auth.ts step ${i}`,
        narrative: `Modified JWT validation logic step ${i}`,
        importance: 7,
        concepts: ["JWT"],
        files: ["auth.ts"],
        facts: [],
      }))),
    );
    mockProvider.summarize.mockResolvedValue(`
<skill>
<trigger>When the agent encounters JWT authentication failures</trigger>
<title>Fix JWT Token Expiration</title>
<steps>
<step>Check the JWT library configuration</step>
<step>Verify the signing algorithm</step>
</steps>
<expected_outcome>JWT auth works reliably</expected_outcome>
<tags>jwt,authentication</tags>
</skill>
    `);

    const result = await handlers["mem::skill-extract"]({
      sessionId: "s1",
      model: "skill-model",
    });

    expect(result).toMatchObject({
      success: true,
      stage: "skill_extract",
      model: "skill-model",
      modelSource: "explicitModel",
      provider: "pi-agent-sdk",
      modelApplied: true,
      parseFailures: 0,
    });
    expect(result.promptChars).toBeGreaterThan(0);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("adds anti-overgeneralization guidance for child sessions", async () => {
    mockKv.get.mockImplementation((scope: string) => {
      if (scope === "mem:sessions") {
        return Promise.resolve({
          id: "child-session",
          project: "proj",
          cwd: "/repo",
          startedAt: "2026-01-01T00:00:00.000Z",
          endedAt: "2026-01-01T00:01:00.000Z",
          status: "completed",
          observationCount: 3,
          lineage: "child",
          parentSessionId: "parent-session",
        });
      }
      if (scope === "mem:summaries") {
        return Promise.resolve({
          sessionId: "child-session",
          project: "proj",
          title: "Child task",
          narrative: "Delegated implementation.",
          keyDecisions: [],
          filesModified: [],
          concepts: ["delegation"],
          observationCount: 3,
          createdAt: "2026-01-01T00:02:00.000Z",
        });
      }
      return Promise.resolve(null);
    });
    mockKv.list.mockResolvedValue(
      Array.from({ length: 3 }, (_, i) => ({
        id: `obs-${i}`,
        sessionId: "child-session",
        timestamp: "2026-01-01T00:00:00.000Z",
        type: "conversation",
        title: `step ${i}`,
        narrative: "Did delegated work.",
        facts: ["local detail"],
        files: [],
        concepts: ["delegation"],
        importance: 7,
      })),
    );
    mockProvider.summarize.mockResolvedValue("<no-skill/>");

    const result = await handlers["mem::skill-extract"]({ sessionId: "child-session" });

    expect(result.success).toBe(true);
    expect(mockProvider.summarize.mock.calls[0][1]).toContain("Session lineage: child.");
    expect(mockProvider.summarize.mock.calls[0][1]).toContain("Do not promote child-local facts");
  });

  it("skill-extract returns no-skill for exploratory sessions", async () => {
    mockKv.get.mockImplementation((scope: string) => {
      if (scope === "mem:sessions") return Promise.resolve({ id: "s1", project: "test", status: "completed" });
      if (scope === "mem:summaries")
        return Promise.resolve({
          sessionId: "s1",
          project: "test",
          title: "Explore codebase",
          narrative: "Browsed files",
          keyDecisions: [],
          filesModified: [],
          concepts: [],
          createdAt: new Date().toISOString(),
          observationCount: 3,
        });
      return Promise.resolve(null);
    });
    mockKv.list.mockReturnValue(
      Promise.resolve(Array.from({ length: 4 }, (_, i) => ({
        id: `obs${i}`,
        sessionId: "s1",
        timestamp: new Date().toISOString(),
        type: "file_read",
        title: `Read file ${i}`,
        importance: 5,
        concepts: [],
        files: [],
        facts: [],
        narrative: "",
      }))),
    );
    mockProvider.summarize.mockResolvedValue("<no-skill/>");

    const result = await handlers["mem::skill-extract"]({ sessionId: "s1" });
    expect(result.success).toBe(true);
    expect(result.extracted).toBe(false);
  });

  it("ordered prepare and commit reinforces a shared skill once per source session", async () => {
    const store = new Map<string, Map<string, any>>();
    const put = (scope: string, key: string, value: any) => {
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, value);
    };
    for (const sessionId of ["s1", "s2"]) {
      put(KV.sessions, sessionId, { id: sessionId, project: "test", status: "completed" });
      put(KV.summaries, sessionId, {
        sessionId,
        project: "test",
        title: "Fix auth bug",
        narrative: "Debugged and fixed JWT expiration",
        keyDecisions: ["Switch to RS256"],
        filesModified: ["auth.ts"],
        concepts: ["authentication", "JWT"],
      });
      for (let index = 0; index < 3; index += 1) {
        put(KV.observations(sessionId), `obs-${sessionId}-${index}`, {
          id: `obs-${sessionId}-${index}`,
          sessionId,
          timestamp: `2026-07-18T00:00:0${index}.000Z`,
          type: "file_edit",
          title: `Step ${index}`,
          narrative: "Updated auth",
          importance: 7,
        });
      }
    }
    mockKv.get.mockImplementation(async (scope: string, key: string) =>
      store.get(scope)?.get(key) ?? null);
    mockKv.set.mockImplementation(async (scope: string, key: string, value: any) => {
      put(scope, key, structuredClone(value));
      return value;
    });
    mockKv.list.mockImplementation(async (scope: string) =>
      Array.from(store.get(scope)?.values() || []));
    mockProvider.summarize.mockResolvedValue(`
<skill>
<trigger>When JWT authentication fails</trigger>
<title>Fix JWT Token Expiration</title>
<steps><step>Check configuration</step><step>Update signing keys</step></steps>
<expected_outcome>Authentication succeeds</expected_outcome>
<tags>jwt,auth</tags>
</skill>`);
    mockProvider.name = "pi-agent-sdk";

    const prepare = handlers["mem::full-skill-extract-prepare"];
    const commit = handlers["mem::full-skill-extract-commit"];
    const identities = ["s1", "s2"].map((sessionId) => ({
      runId: "formal-run",
      stage: "skill_extract",
      unitId: `skill-${sessionId}`,
      inputHash: `hash-${sessionId}`,
    }));
    const prepared = await Promise.all(identities.map((identity, index) =>
      prepare({ identity, sessionId: `s${index + 1}`, model: "skill-release-b" })));
    expect(prepared.map((result) => result.status)).toEqual(["prepared", "prepared"]);
    expect(prepared[0]).toMatchObject({
      stage: "skill_extract",
      model: "skill-release-b",
      modelSource: "explicitModel",
      provider: "pi-agent-sdk",
      modelApplied: true,
    });
    expect(mockProvider.summarize).toHaveBeenCalledTimes(2);
    const proposalScopes = [...store.keys()].filter((scope) =>
      scope.startsWith("mem:skill-extraction-proposal:"));
    expect(proposalScopes).toHaveLength(2);
    expect(proposalScopes.every((scope) => store.get(scope)?.size === 1)).toBe(true);
    expect(store.has(KV.skillExtractionProposals)).toBe(false);
    for (const scope of proposalScopes) {
      const [[key, proposal]] = [...store.get(scope)!.entries()];
      put(scope, key, canonical(proposal));
    }

    const replay = await prepare({
      identity: identities[0],
      sessionId: "s1",
      model: "skill-release-b",
    });
    expect(replay.preparedHandle).toBe(prepared[0].preparedHandle);
    expect(replay.model).toBe("skill-release-b");
    expect(mockProvider.summarize).toHaveBeenCalledTimes(2);

    await Promise.all(prepared.map((proposal, index) => commit({
      identity: identities[index],
      preparedHandle: proposal.preparedHandle,
      proposalHash: proposal.proposalHash,
    })));
    const skills = Array.from(store.get(KV.procedural)?.values() || []);
    expect(skills).toHaveLength(1);
    const committed = await commit({
      identity: identities[0],
      preparedHandle: prepared[0].preparedHandle,
      proposalHash: prepared[0].proposalHash,
    });
    expect(committed.model).toBe("skill-release-b");
    await expect(commit({
      identity: identities[0],
      preparedHandle: prepared[0].preparedHandle,
      proposalHash: "wrong-proposal-hash",
    })).resolves.toMatchObject({
      success: false,
      failure: { class: "hard", cause: "proposal_identity_conflict" },
    });
    expect(skills[0]).toMatchObject({
      frequency: 2,
      strength: 0.75,
      sourceSessionIds: ["s1", "s2"],
    });

    await Promise.all(prepared.map((proposal, index) => commit({
      identity: identities[index],
      preparedHandle: proposal.preparedHandle,
      proposalHash: proposal.proposalHash,
    })));
    expect(Array.from(store.get(KV.procedural)?.values() || [])[0]).toMatchObject({
      frequency: 2,
      strength: 0.75,
      sourceSessionIds: ["s1", "s2"],
    });

    const firstProposal = Array.from(store.get(proposalScopes[0])!.values())[0];
    const firstAudit = store.get(KV.audit)!.get(firstProposal.commitIntent.auditId);
    store.get(KV.audit)!.delete(firstProposal.commitIntent.auditId);
    await expect(commit({
      identity: identities[0],
      preparedHandle: prepared[0].preparedHandle,
      proposalHash: prepared[0].proposalHash,
    })).resolves.toMatchObject({
      success: false,
      failure: { class: "hard", cause: "skill_extract_committed_effect_missing" },
    });
    put(KV.audit, firstProposal.commitIntent.auditId, firstAudit);

    const skill = store.get(KV.procedural)!.get(firstProposal.commitIntent.resultId);
    put(KV.procedural, skill.id, {
      ...skill,
      sourceSessionIds: skill.sourceSessionIds.filter((id: string) => id !== "s1"),
    });
    await expect(commit({
      identity: identities[0],
      preparedHandle: prepared[0].preparedHandle,
      proposalHash: prepared[0].proposalHash,
    })).resolves.toMatchObject({
      success: false,
      failure: { class: "hard", cause: "skill_extract_committed_effect_conflict" },
    });

    const stableSkill = structuredClone(skill);
    for (const drifted of [
      { ...stableSkill, name: "Drifted skill" },
      { ...stableSkill, triggerCondition: "When unrelated work starts" },
      { ...stableSkill, steps: ["Replace the frozen steps"] },
      { ...stableSkill, steps: null },
      { ...stableSkill, expectedOutcome: "A different outcome" },
      { ...stableSkill, tags: ["drifted"] },
      { ...stableSkill, concepts: ["drifted"] },
      { ...stableSkill, sourceObservationIds: ["drifted-observation"] },
    ]) {
      put(KV.procedural, stableSkill.id, drifted);
      await expect(commit({
        identity: identities[0],
        preparedHandle: prepared[0].preparedHandle,
        proposalHash: prepared[0].proposalHash,
      })).resolves.toMatchObject({
        success: false,
        failure: { class: "hard", cause: "skill_extract_committed_effect_conflict" },
      });
    }

    put(KV.procedural, stableSkill.id, stableSkill);
    put(KV.skillExtractionProposal(firstProposal.key), firstProposal.key, {
      ...firstProposal,
      concepts: ["coordinated-drift"],
    });
    await expect(commit({
      identity: identities[0],
      preparedHandle: prepared[0].preparedHandle,
      proposalHash: prepared[0].proposalHash,
    })).resolves.toMatchObject({
      success: false,
      failure: { class: "hard", cause: "proposal_identity_conflict" },
    });
  });

  it.each([
    [
      "commit intent",
      (scope: string, value: any) =>
        scope.startsWith("mem:skill-extraction-proposal:")
        && value?.status === "committing"
        && value?.commitIntent?.stableResultHash === undefined,
    ],
    [
      "stable effect hash",
      (scope: string, value: any) =>
        scope.startsWith("mem:skill-extraction-proposal:")
        && value?.status === "committing"
        && typeof value?.commitIntent?.stableResultHash === "string",
    ],
    ["procedural effect", (scope: string) => scope === KV.procedural],
    ["audit effect", (scope: string) => scope === KV.audit],
    [
      "committed proposal",
      (scope: string, value: any) =>
        scope.startsWith("mem:skill-extraction-proposal:")
        && value?.status === "committed",
    ],
  ])("re-enters after the %s write without another provider call or reinforcement", async (
    _faultName,
    shouldInterrupt,
  ) => {
    const store = new Map<string, Map<string, any>>();
    const put = (scope: string, key: string, value: any) => {
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, structuredClone(value));
    };
    put(KV.sessions, "s1", { id: "s1", project: "test", status: "completed" });
    put(KV.summaries, "s1", {
      sessionId: "s1",
      project: "test",
      title: "Fix auth bug",
      narrative: "Debugged and fixed JWT expiration",
      keyDecisions: ["Switch to RS256"],
      filesModified: ["auth.ts"],
      concepts: ["authentication", "JWT"],
    });
    for (let index = 0; index < 3; index += 1) {
      put(KV.observations("s1"), `obs-${index}`, {
        id: `obs-${index}`,
        sessionId: "s1",
        timestamp: `2026-07-30T00:00:0${index}.000Z`,
        type: "file_edit",
        title: `Step ${index}`,
        narrative: "Updated auth.",
        importance: 8,
      });
    }
    mockKv.get.mockImplementation(async (scope: string, key: string) => {
      const value = store.get(scope)?.get(key);
      return value === undefined ? null : structuredClone(value);
    });
    mockKv.set.mockImplementation(async (scope: string, key: string, value: any) => {
      put(scope, key, value);
      return value;
    });
    mockKv.list.mockImplementation(async (scope: string) =>
      [...(store.get(scope)?.values() ?? [])].map((value) => structuredClone(value)));
    mockProvider.summarize.mockResolvedValue(`
<skill>
<trigger>When JWT authentication fails</trigger>
<title>Fix JWT Token Expiration</title>
<steps><step>Check configuration</step><step>Update signing keys</step></steps>
<expected_outcome>Authentication succeeds</expected_outcome>
<tags>jwt,auth</tags>
</skill>`);
    const identity = {
      runId: "skill-partial-write",
      stage: "skill_extract",
      unitId: "s1",
      inputHash: "skill-partial-write-input",
    };
    const prepared = await handlers["mem::full-skill-extract-prepare"]({
      identity,
      sessionId: "s1",
    });
    expect(prepared.status).toBe("prepared");
    let interrupt = true;
    mockKv.set.mockImplementation(async (scope: string, key: string, value: any) => {
      put(scope, key, value);
      if (interrupt && shouldInterrupt(scope, value)) {
        interrupt = false;
        throw new Error("interrupted after durable write");
      }
      return value;
    });
    const commitInput = {
      identity,
      preparedHandle: prepared.preparedHandle,
      proposalHash: prepared.proposalHash,
    };

    await expect(
      handlers["mem::full-skill-extract-commit"](commitInput),
    ).rejects.toThrow("interrupted after durable write");
    const recovered = await handlers["mem::full-skill-extract-commit"](commitInput);

    expect(interrupt).toBe(false);
    expect(recovered).toMatchObject({
      success: true,
      status: "succeeded",
      extracted: true,
      reinforced: expect.any(Boolean),
    });
    expect(mockProvider.summarize).toHaveBeenCalledTimes(1);
    expect([...(store.get(KV.procedural)?.values() ?? [])]).toEqual([
      expect.objectContaining({
        frequency: 1,
        strength: 0.6,
        sourceSessionIds: ["s1"],
      }),
    ]);
    expect(store.get(KV.audit)?.size).toBe(1);
    const proposalScopes = [...store.keys()].filter((scope) =>
      scope.startsWith("mem:skill-extraction-proposal:"));
    expect(proposalScopes).toHaveLength(1);
    expect([...(store.get(proposalScopes[0])?.values() ?? [])]).toEqual([
      expect.objectContaining({ status: "committed" }),
    ]);
  });

  it("serializes direct persistence with proposal commit for the same skill fingerprint", async () => {
    const store = new Map<string, Map<string, any>>();
    const put = (scope: string, key: string, value: any) => {
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, structuredClone(value));
    };
    for (const sessionId of ["seed", "direct", "proposal"]) {
      put(KV.sessions, sessionId, {
        id: sessionId,
        project: "test",
        status: "completed",
      });
      put(KV.summaries, sessionId, {
        sessionId,
        project: "test",
        title: "Fix auth bug",
        narrative: "Debugged and fixed JWT expiration",
        keyDecisions: ["Switch to RS256"],
        filesModified: ["auth.ts"],
        concepts: ["authentication", "JWT"],
      });
      for (let index = 0; index < 3; index += 1) {
        put(KV.observations(sessionId), `obs-${sessionId}-${index}`, {
          id: `obs-${sessionId}-${index}`,
          sessionId,
          timestamp: `2026-07-18T00:00:0${index}.000Z`,
          type: "file_edit",
          title: `Step ${index}`,
          narrative: "Updated auth",
          importance: 7,
        });
      }
    }

    let blockFirstProceduralRead = false;
    let proceduralReadCount = 0;
    let releaseFirstRead!: () => void;
    let markFirstReadStarted!: () => void;
    let markSecondReadStarted!: () => void;
    const firstReadStarted = new Promise<void>((resolve) => {
      markFirstReadStarted = resolve;
    });
    const secondReadStarted = new Promise<void>((resolve) => {
      markSecondReadStarted = resolve;
    });
    const firstReadRelease = new Promise<void>((resolve) => {
      releaseFirstRead = resolve;
    });
    mockKv.get.mockImplementation(async (scope: string, key: string) => {
      const value = store.get(scope)?.get(key) ?? null;
      if (blockFirstProceduralRead && scope === KV.procedural && value) {
        proceduralReadCount += 1;
        const snapshot = structuredClone(value);
        if (proceduralReadCount === 1) {
          markFirstReadStarted();
          await firstReadRelease;
        } else if (proceduralReadCount === 2) {
          markSecondReadStarted();
        }
        return snapshot;
      }
      return value === null ? null : structuredClone(value);
    });
    mockKv.set.mockImplementation(async (scope: string, key: string, value: any) => {
      put(scope, key, value);
      return value;
    });
    mockKv.list.mockImplementation(async (scope: string) =>
      Array.from(store.get(scope)?.values() || [], (value) => structuredClone(value)));
    mockProvider.summarize.mockResolvedValue(`
<skill>
<trigger>When JWT authentication fails</trigger>
<title>Fix JWT Token Expiration</title>
<steps><step>Check configuration</step><step>Update signing keys</step></steps>
<expected_outcome>Authentication succeeds</expected_outcome>
<tags>jwt,auth</tags>
</skill>`);

    const direct = handlers["mem::skill-extract"];
    const prepare = handlers["mem::full-skill-extract-prepare"];
    const commit = handlers["mem::full-skill-extract-commit"];
    const identity = {
      runId: "formal-run",
      stage: "skill_extract",
      unitId: "skill-proposal",
      inputHash: "proposal-input",
    };
    expect(await direct({ sessionId: "seed" })).toMatchObject({
      success: true,
      reinforced: false,
    });
    const prepared = await prepare({ identity, sessionId: "proposal" });

    blockFirstProceduralRead = true;
    const directResultPromise = direct({ sessionId: "direct" });
    await firstReadStarted;
    const commitResultPromise = commit({
      identity,
      preparedHandle: prepared.preparedHandle,
      proposalHash: prepared.proposalHash,
    });
    const proposalReadWhileDirectHeldLock = await Promise.race([
      secondReadStarted.then(() => true),
      new Promise<boolean>((resolve) => setImmediate(() => resolve(false))),
    ]);
    releaseFirstRead();
    const [directResult, commitResult] = await Promise.all([
      directResultPromise,
      commitResultPromise,
    ]);

    expect(proposalReadWhileDirectHeldLock).toBe(false);
    expect(directResult.success).toBe(true);
    expect(commitResult.success).toBe(true);
    const skill = Array.from(store.get(KV.procedural)?.values() || [])[0];
    expect(skill).toMatchObject({
      frequency: 3,
      strength: 0.9,
      sourceSessionIds: ["seed", "direct", "proposal"],
    });

    await Promise.all([
      direct({ sessionId: "direct" }),
      commit({
        identity,
        preparedHandle: prepared.preparedHandle,
        proposalHash: prepared.proposalHash,
      }),
    ]);
    expect(Array.from(store.get(KV.procedural)?.values() || [])[0]).toMatchObject({
      frequency: 3,
      strength: 0.9,
      sourceSessionIds: ["seed", "direct", "proposal"],
    });
  });

  it("releases the shared commit lock after direct persistence fails", async () => {
    mockKv.get.mockImplementation((scope: string) => {
      if (scope === KV.sessions) {
        return Promise.resolve({ id: "s1", project: "test", status: "completed" });
      }
      if (scope === KV.summaries) {
        return Promise.resolve({
          sessionId: "s1",
          project: "test",
          title: "Fix auth bug",
          narrative: "Debugged and fixed JWT expiration",
          keyDecisions: [],
          filesModified: ["auth.ts"],
          concepts: ["JWT"],
        });
      }
      return Promise.resolve(null);
    });
    mockKv.list.mockResolvedValue(
      Array.from({ length: 3 }, (_, index) => ({
        id: `obs-${index}`,
        sessionId: "s1",
        timestamp: `2026-07-18T00:00:0${index}.000Z`,
        type: "file_edit",
        title: `Step ${index}`,
        narrative: "Updated auth",
        importance: 7,
      })),
    );
    mockKv.set
      .mockRejectedValueOnce(new Error("procedural write failed"))
      .mockResolvedValue(undefined);
    mockProvider.summarize.mockResolvedValue(`
<skill>
<trigger>When JWT authentication fails</trigger>
<title>Fix JWT Token Expiration</title>
<steps><step>Check configuration</step><step>Update signing keys</step></steps>
<expected_outcome>Authentication succeeds</expected_outcome>
<tags>jwt</tags>
</skill>`);

    expect(await handlers["mem::skill-extract"]({ sessionId: "s1" })).toMatchObject({
      success: false,
      status: "failed",
    });
    const secondAttempt = await Promise.race([
      handlers["mem::skill-extract"]({ sessionId: "s1" }),
      new Promise((resolve) => setImmediate(() => resolve({ timeout: true }))),
    ]);
    expect(secondAttempt).not.toMatchObject({ timeout: true });
    expect(secondAttempt).toMatchObject({
      success: true,
      status: "succeeded",
    });
  });

  it("skill-list returns sorted by strength", async () => {
    mockKv.list.mockResolvedValue([
      { id: "s1", name: "Low", strength: 0.3 },
      { id: "s2", name: "High", strength: 0.9 },
    ]);
    const result = await handlers["mem::skill-list"]({});
    expect(result.skills[0].name).toBe("High");
  });

  it("skill-match finds relevant skills", async () => {
    mockKv.list.mockResolvedValue([
      {
        id: "s1",
        name: "Fix JWT Auth",
        triggerCondition: "JWT failures",
        tags: ["jwt", "auth"],
        steps: ["check config", "update key"],
        strength: 0.8,
      },
      {
        id: "s2",
        name: "Deploy Docker",
        triggerCondition: "container deployment",
        tags: ["docker", "deploy"],
        steps: ["build image", "push"],
        strength: 0.7,
      },
    ]);

    const result = await handlers["mem::skill-match"]({
      query: "JWT authentication token expired",
    });
    expect(result.matches.length).toBe(1);
    expect(result.matches[0].skill.name).toBe("Fix JWT Auth");
  });
});
