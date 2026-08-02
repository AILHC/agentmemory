export const SEMANTIC_MERGE_SYSTEM = `You are a memory consolidation engine. Given overlapping episodic memories (session summaries), extract stable factual knowledge.

Output format (XML):
<facts>
  <fact confidence="0.0-1.0">Concise factual statement</fact>
</facts>

Rules:
- Extract only facts that appear in 2+ episodes or are highly confident
- Confidence reflects how well-supported the fact is across episodes
- Combine overlapping information into single concise facts
- Skip ephemeral details (specific error messages, temporary states)`;

export const SEMANTIC_MERGE_OUTPUT_CONTRACT = {
  semantic: [
    "<fact> 内容必须使用简体中文，可保留 XML 结构与 attributes（如 confidence）不变。",
    "XML tags、attributes（包括 confidence）和 XML 结构不可改写。",
    "paths、commands、package/API/class/function/type names、URLs、代码标识符保持原文，不要翻译。",
  ],
} as const;

export function buildSemanticMergePrompt(
  episodes: Array<{ title: string; narrative: string; concepts: string[] }>,
): string {
  const items = episodes
    .map(
      (e, i) =>
        `[Episode ${i + 1}]\nTitle: ${e.title}\nNarrative: ${e.narrative}\nConcepts: ${e.concepts.join(", ")}`,
    )
    .join("\n\n");
  return `Consolidate these episodic memories into stable facts:\n\n${items}`;
}

export const PROCEDURAL_EXTRACTION_SYSTEM = `You are a procedural memory extractor. Given repeated patterns and workflows observed across sessions, extract reusable procedures.

Output format (XML):
<procedures>
  <procedure name="short descriptive name" trigger="when to use this procedure">
    <step>Step 1 description</step>
    <step>Step 2 description</step>
  </procedure>
</procedures>

Rules:
- Only extract procedures observed 2+ times
- Steps should be concrete and actionable
- Trigger condition should be specific enough to match automatically
- Existing procedures are context only; reinforce or merge one only when the new patterns support it
- If the new patterns support no reusable procedure, return exactly <procedures></procedures>`;

export function buildProceduralExtractionPrompt(
  patterns: Array<{ content: string; frequency: number }>,
  historicalProcedures: Array<{
    name: string;
    triggerCondition: string;
    steps: string[];
  }> = [],
): string {
  const items = patterns
    .map((p, i) => `[Pattern ${i + 1}] (seen ${p.frequency}x)\n${p.content}`)
    .join("\n\n");
  const history = historicalProcedures.length > 0
    ? historicalProcedures.map((procedure, index) => [
        `[Existing procedure ${index + 1}] ${procedure.name}`,
        `Trigger: ${procedure.triggerCondition}`,
        ...procedure.steps.map((step) => `- ${step}`),
      ].join("\n")).join("\n\n")
    : "(none)";
  return [
    "Extract reusable procedures supported by the new recurring patterns.",
    "New patterns are evidence. Existing procedures are historical context only.",
    "",
    "New recurring patterns:",
    items,
    "",
    "Existing procedures (context only):",
    history,
  ].join("\n");
}
