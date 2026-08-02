export const REFLECT_SYSTEM = `You are a higher-order reasoning engine. Given a cluster of related concepts, facts, lessons, and action outcomes, synthesize cross-cutting insights that span multiple individual memories.

Output format (XML):
<insights>
  <insight confidence="0.0-1.0" title="Short descriptive title">
    The higher-order observation or principle. Should be actionable and non-obvious — something that only becomes visible when viewing multiple memories together.
  </insight>
</insights>

Rules:
- Identify patterns, principles, or strategies that span 2+ source items
- Confidence reflects how well-supported the insight is across sources
- Title should be a concise label (under 60 chars)
- Content should be the actual observation (1-3 sentences)
- Prefer actionable insights over abstract summaries
- Skip insights that merely restate a single source item
- Existing insights are historical context only; do not treat them as new supporting items
- If the new supporting items yield no novel or supportable insight, return exactly <insights></insights>
- Always emit confidence attribute before title attribute`;

export const REFLECT_OUTPUT_CONTRACT = {
  reflect: [
    "<insight> 的 <title> 与正文内容使用简体中文。",
    "sourceConceptCluster 与 concepts 可保留英文技术标识或中英双语，不要强行中文化图谱/关系名词。",
    "sourceConceptCluster 与关系术语（source/target/type）保留可检索标识，不改写。",
  ],
} as const;

export function buildReflectPrompt(cluster: {
  concepts: string[];
  facts: Array<{ fact: string; confidence: number }>;
  lessons: Array<{ content: string; confidence: number }>;
  crystalNarratives: string[];
}, existingInsights: Array<{
  title: string;
  content: string;
  confidence: number;
  reinforcements: number;
}> = []): string {
  const sections: string[] = [];

  sections.push(`## Concept Cluster: ${cluster.concepts.join(", ")}`);

  if (cluster.facts.length > 0) {
    sections.push(
      "\n## Known Facts",
      ...cluster.facts.map(
        (f) => `- [confidence=${f.confidence}] ${f.fact}`,
      ),
    );
  }

  if (cluster.lessons.length > 0) {
    sections.push(
      "\n## Lessons Learned",
      ...cluster.lessons.map(
        (l) => `- [confidence=${l.confidence}] ${l.content}`,
      ),
    );
  }

  if (cluster.crystalNarratives.length > 0) {
    sections.push(
      "\n## Completed Work Summaries",
      ...cluster.crystalNarratives.map((n) => `- ${n}`),
    );
  }

  if (existingInsights.length > 0) {
    sections.push(
      "\n## Existing Insights (historical context only)",
      ...existingInsights.map((insight) =>
        `- [confidence=${insight.confidence}; reinforcements=${insight.reinforcements}] ${insight.title}: ${insight.content}`),
    );
  }

  return `Synthesize higher-order insights from the new supporting items below. Existing insights may guide merge or reinforcement decisions, but are not new evidence:\n\n${sections.join("\n")}`;
}
