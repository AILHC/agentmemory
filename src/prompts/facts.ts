export interface ParsedSemanticFact {
  fact: string;
  confidence: number;
}

export function parseFactResponse(response: string): ParsedSemanticFact[] {
  const facts: ParsedSemanticFact[] = [];
  const factRegex = /<fact(\s+[^>]*)?>([\s\S]*?)<\/fact>/gi;
  let match: RegExpExecArray | null;
  while ((match = factRegex.exec(response)) !== null) {
    const openTag = match[1] ?? "";
    const matchConfidence = openTag.match(/\bconfidence\s*=\s*["']([^"']+)["']/i);
    const parsedConf = matchConfidence ? Number.parseFloat(matchConfidence[1]) : NaN;
    const confidence = Number.isFinite(parsedConf) ? Math.max(0, Math.min(1, parsedConf)) : 0.5;
    const fact = match[2]?.replace(/<[^>]*>/g, " ").trim();
    if (fact) facts.push({ fact, confidence });
  }
  return facts;
}
