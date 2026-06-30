import { LessonExtractionOutputSchema } from "../eval/schemas.js";
import { validateOutput } from "../eval/validator.js";

export const LESSON_EXTRACTION_SYSTEM = `You are a lesson extraction engine for an AI coding agent memory system.
Extract durable, reusable lessons from a coding-agent session.

A lesson is a portable rule, warning, preference, or practice that should guide future sessions.
Do not summarize routine events.
Do not include temporary TODOs.
Do not include unverified guesses.
Do not include secrets, tokens, credentials, or private data.
Prefer lessons that are actionable, reusable, and grounded in the transcript.

Output EXACTLY this XML format with no additional text:

<lessons>
  <lesson confidence="0.0-1.0">
    <content>Imperative lesson, concise and reusable</content>
    <context>When/where this lesson applies</context>
    <tags>
      <tag>search term</tag>
    </tags>
  </lesson>
</lessons>

Rules:
- Extract only lessons supported by the provided session text.
- Preserve user corrections, preferences, prohibitions, workflow rules, and repeated failure-avoidance patterns.
- Do not include ordinary facts that belong in long-term memory instead of lessons.
- Do not include one-off task progress.
- Keep content short and directly actionable.`;

export interface LessonPromptItem {
  index: number;
  kind: "user_prompt" | "assistant_response" | "observation";
  text: string;
  type?: string;
  title?: string;
  files?: string[];
}

export interface LessonPromptInput {
  sessionId: string;
  project: string;
  firstPrompt?: string;
  items: LessonPromptItem[];
}

export interface ParsedLessonCandidate {
  content: string;
  context: string;
  confidence: number;
  tags: string[];
}

type ParsedLessonExtraction = {
  lessons: ParsedLessonCandidate[];
};

const TRUNCATED_MARKER = "[...truncated]";
const FIRST_PROMPT_CHAR_LIMIT = 1200;
const ITEM_TEXT_CHAR_LIMIT = 2000;
const ITEM_META_CHAR_LIMIT = 500;
const TOTAL_PROMPT_CHAR_LIMIT = 12000;

function truncate(input: string, limit: number): string {
  const trimmed = input.trim();
  if (trimmed.length <= limit) return trimmed;
  const sliceLimit = Math.max(0, limit - TRUNCATED_MARKER.length - 1);
  return `${trimmed.slice(0, sliceLimit).trimEnd()}\n${TRUNCATED_MARKER}`;
}

function normalizeTagText(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

export function buildLessonExtractionPrompt(input: LessonPromptInput): string {
  const lines = [
    `Session: ${input.sessionId}`,
    `Project: ${input.project}`,
  ];

  if (input.firstPrompt) {
    lines.push(`First prompt:\n${truncate(input.firstPrompt, FIRST_PROMPT_CHAR_LIMIT)}`);
  }

  for (const item of input.items) {
    const meta: string[] = [];
    if (item.type) meta.push(`Type: ${item.type}`);
    if (item.title) meta.push(`Title: ${truncate(normalizeTagText(item.title), ITEM_META_CHAR_LIMIT)}`);
    if (item.files && item.files.length > 0) {
      meta.push(`Files: ${truncate(item.files.map(normalizeTagText).join(", "), ITEM_META_CHAR_LIMIT)}`);
    }

    const metaText = meta.length > 0 ? `\n${meta.join("\n")}` : "";
    lines.push(
      `[${item.index}] ${item.kind}${metaText}\n${truncate(normalizeTagText(item.text), ITEM_TEXT_CHAR_LIMIT)}`,
    );
  }

  return truncate(lines.join("\n\n"), TOTAL_PROMPT_CHAR_LIMIT);
}

function stripXmlWrappers(raw: string): string {
  if (!raw) return "";
  let cleaned = raw.trim();
  cleaned = cleaned.replace(/```\s*xml\s*\n?/gi, "");
  cleaned = cleaned.replace(/```/g, "");
  return cleaned.trim();
}

function getTagBlock(xml: string, tag: string): string {
  const escapedTag = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = xml.match(
    new RegExp(`<${escapedTag}>[\\s\\S]*?</${escapedTag}>`, "gi"),
  );
  if (!match) return "";
  const block = match[0];
  const open = block.match(
    new RegExp(`<${escapedTag}[^>]*>`, "i"),
  );
  if (!open) return "";
  return block.slice(open[0].length, -`</${tag}>`.length);
}

function getTagValue(xml: string, tag: string): string {
  return getTagBlock(xml, tag).replace(/<[^>]*>/g, " ").trim();
}

function getLessonConfidence(lessonOpenTag: string): number {
  const match = lessonOpenTag.match(/\bconfidence\s*=\s*["']([^"']+)["']/i);
  if (!match?.[1]) return 0.6;
  const raw = Number.parseFloat(match[1]);
  if (!Number.isFinite(raw)) return 0.6;
  return Math.min(1, Math.max(0, raw));
}

export function parseLessonExtractionXml(raw: string): ParsedLessonExtraction {
  const xml = stripXmlWrappers(raw);
  if (!xml) throw new Error("No XML content");

  const rootMatch = xml.match(/<lessons\b[\s\S]*?>[\s\S]*?<\/lessons>/i);
  if (!rootMatch) {
    throw new Error("Missing <lessons> root");
  }

  const lessonsBlock = rootMatch[0];
  const lessonBlocks = lessonsBlock.match(/<lesson\b[^>]*>[\s\S]*?<\/lesson>/gi) ?? [];
  if (lessonBlocks.length === 0) throw new Error("No <lesson> blocks");

  const parsedLessons: ParsedLessonCandidate[] = lessonBlocks
    .map((lessonBlock) => {
      const openTag = lessonBlock.match(/<lesson\b[^>]*>/i)?.[0] ?? "<lesson>";
      const confidence = getLessonConfidence(openTag);
      const content = getTagValue(lessonBlock, "content");
      if (!content) return null;

      const context = getTagValue(lessonBlock, "context");

      const tagsBlock = getTagBlock(lessonBlock, "tags");
      const tags: string[] = [];
      if (tagsBlock) {
        const tagMatches = tagsBlock.match(/<tag>([\s\S]*?)<\/tag>/gi) ?? [];
        for (const tagMatch of tagMatches) {
          const tag = tagMatch
            .replace(/^<tag>/i, "")
            .replace(/<\/tag>$/i, "")
            .trim();
          if (tag) tags.push(tag);
        }
      }

      return {
        content,
        context,
        confidence,
        tags,
      };
    })
    .filter((candidate): candidate is ParsedLessonCandidate =>
      candidate !== null && candidate.content.length > 0,
    );

  if (parsedLessons.length === 0) {
    throw new Error("No valid lessons found");
  }

  const validation = validateOutput(
    LessonExtractionOutputSchema,
    { lessons: parsedLessons },
    "mem::replay::lesson-extract",
  );
  if (!validation.valid) {
    throw new Error(validation.result.errors.join("; "));
  }

  return validation.data;
}
