export type OutputLanguage = "default" | "zh-CN";

const POLICY_MARKER = "AgentMemory Output Language Policy";

export function resolveOutputLanguage(
  env: Record<string, string | undefined> = process.env,
): OutputLanguage {
  const raw = env.AGENTMEMORY_OUTPUT_LANGUAGE;
  if (!raw || raw === "en" || raw === "en-US") return "default";
  if (raw === "zh-CN") return "zh-CN";
  throw new Error(`Unsupported AGENTMEMORY_OUTPUT_LANGUAGE: ${raw}`);
}

export function withOutputLanguagePolicy(
  systemPrompt: string,
  env: Record<string, string | undefined> = process.env,
): string {
  if (resolveOutputLanguage(env) === "default") return systemPrompt;
  if (systemPrompt.includes(POLICY_MARKER)) return systemPrompt;

  return `${systemPrompt.trim()}

${POLICY_MARKER}:
- 人类可读内容使用简体中文；不要把 XML/JSON 结构契约或代码标识符翻译成中文。
- 保留 XML tags、JSON keys、attribute names、enum values、file paths、code identifiers；同时保留 schema fields、URLs、commands、package/API/class/function/type names。
- concepts/tags/sourceConceptCluster 以及 search terms 需保留英文技术标识，或在有助于检索时使用中英双语。
- Graph extraction: entity name、relationship source/target、relationship type enum 不得翻译或改写；source/target 必须与 entity name 精确匹配。
- 不翻译 code snippets、quoted source identifiers 或任何需要精确匹配的原文标识符。`;
}
