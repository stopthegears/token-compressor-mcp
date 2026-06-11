import { MCPServer, text } from "mcp-use/server";
import { z } from "zod";

type CompressionMode = "brief" | "balanced" | "structured" | "lossless_facts";

type ContextRecord = {
  id: string;
  title: string;
  tags: string[];
  rawText: string;
  compressedText: string;
  rawTokenEstimate: number;
  compressedTokenEstimate: number;
  compressionRatio: number;
  createdAt: string;
  updatedAt: string;
};

type SectionName =
  | "summary"
  | "decisions"
  | "owners"
  | "datesMilestones"
  | "blockers"
  | "risks"
  | "dependencies"
  | "requirements"
  | "actionItems"
  | "openQuestions"
  | "urlsIds"
  | "other";

type Sections = Record<SectionName, string[]>;

const store = new Map<string, ContextRecord>();

const server = new MCPServer({
  name: "token-compressor-mcp",
  title: "Token Compressor MCP",
  version: "0.5.0",
  description:
    "Compress, save, retrieve, and delete compact context records for Claude/Cowork. Use for non-sensitive long notes, transcripts, project background, and reusable context.",
  stateless: false,
});

function estimateTokens(input: string): number {
  const value = input.trim();
  if (!value) return 0;
  return Math.ceil(value.length / 4);
}

function makeId(): string {
  return Math.random().toString(36).slice(2, 10);
}

function normalizeWhitespace(input: string): string {
  return input
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function splitSentences(input: string): string[] {
  return normalizeWhitespace(input)
    .replace(/\n+/g, " ")
    .split(/(?<=[.!?])\s+(?=[A-Z0-9])/g)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length >= 25);
}

function normalizeForCompare(input: string): string {
  return input
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function wordSet(input: string): Set<string> {
  return new Set(
    normalizeForCompare(input)
      .split(" ")
      .filter((word) => word.length > 3),
  );
}

function overlapRatio(a: string, b: string): number {
  const aWords = wordSet(a);
  const bWords = wordSet(b);

  if (aWords.size === 0 || bWords.size === 0) return 0;

  let shared = 0;
  for (const word of aWords) {
    if (bWords.has(word)) shared += 1;
  }

  return shared / Math.min(aWords.size, bWords.size);
}

function addUnique(target: string[], candidate: string): void {
  const cleaned = candidate.replace(/^[-*•]\s+/, "").replace(/^\d+[.)]\s+/, "").trim();
  if (!cleaned) return;

  for (const existing of target) {
    if (normalizeForCompare(existing) === normalizeForCompare(cleaned)) return;
    if (overlapRatio(existing, cleaned) >= 0.82) return;
  }

  target.push(cleaned);
}

function includesAny(value: string, terms: string[]): boolean {
  const lower = value.toLowerCase();
  return terms.some((term) => lower.includes(term));
}

function hasDate(value: string): boolean {
  return /\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2}\b/i.test(value)
    || /\b\d{1,2}[/-]\d{1,2}([/-]\d{2,4})?\b/.test(value)
    || /\b\d{4}-\d{2}-\d{2}\b/.test(value)
    || /\bby\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.test(value)
    || /\bby\s+(today|tomorrow|eod|end of week|next week)\b/i.test(value);
}

function extractUrlsAndIds(input: string): string[] {
  const matches = [
    ...input.matchAll(/https?:\/\/[^\s)]+/g),
    ...input.matchAll(/\b[A-Z][A-Z0-9]+-\d+\b/g),
    ...input.matchAll(/\b[A-Z]{2,}-[A-Z0-9-]{3,}\b/g),
  ].map((match) => match[0]);

  const result: string[] = [];
  for (const match of matches) addUnique(result, match);
  return result;
}

function classifySentence(sentence: string): SectionName {
  const lower = sentence.toLowerCase();

  if (
    includesAny(lower, ["open question", "not decided", "no final answer", "needs a decision", "needs guidance"])
    || sentence.endsWith("?")
  ) {
    return "openQuestions";
  }

  if (
    includesAny(lower, ["action item", "next step"])
    || (
      /\b[A-Z][a-z]+(\s[A-Z][a-z]+)?\s+will\b/.test(sentence)
      && (hasDate(sentence) || lower.includes(" by "))
    )
  ) {
    return "actionItems";
  }

  if (
    /\b[A-Z][a-z]+(\s[A-Z][a-z]+)?\s+owns\b/.test(sentence)
    || includesAny(lower, ["project sponsor", "program lead", "owner is", "owner:", "responsible for", "accountable for"])
  ) {
    return "owners";
  }

  if (
    includesAny(lower, ["decision", "decided", "approved", "final call", "chosen", "agreed to"])
  ) {
    return "decisions";
  }

  if (
    includesAny(lower, ["primary blocker", "main blocker", "blocker", "blocked", "blocking"])
  ) {
    return "blockers";
  }

  if (
    includesAny(lower, ["risk", "concern", "could affect", "could create", "may cause", "disruption"])
  ) {
    return "risks";
  }

  if (
    includesAny(lower, ["depends on", "dependency", "dependent on"])
  ) {
    return "dependencies";
  }

  if (
    includesAny(lower, ["requirement", "must", "success criteria", "criteria are", "target is", "target launch"])
  ) {
    return "requirements";
  }

  if (
    hasDate(sentence)
    || includesAny(lower, ["launch date", "deadline", "milestone", "go/no-go", "backup date"])
  ) {
    return "datesMilestones";
  }

  return "other";
}

function scoreSentence(sentence: string): number {
  const lower = sentence.toLowerCase();
  let score = 0;

  if (includesAny(lower, ["decision", "approved", "blocker", "risk", "dependency", "owner", "owns"])) score += 4;
  if (includesAny(lower, ["action", "next step", "open question", "success criteria", "requirement"])) score += 4;
  if (hasDate(sentence)) score += 3;
  if (/\b[A-Z][a-z]+\s[A-Z][a-z]+\b/.test(sentence)) score += 2;
  if (/https?:\/\//.test(sentence)) score += 2;
  if (sentence.length >= 50 && sentence.length <= 220) score += 1;
  if (sentence.length > 280) score -= 2;

  return score;
}

function extractSections(rawText: string): Sections {
  const sections: Sections = {
    summary: [],
    decisions: [],
    owners: [],
    datesMilestones: [],
    blockers: [],
    risks: [],
    dependencies: [],
    requirements: [],
    actionItems: [],
    openQuestions: [],
    urlsIds: extractUrlsAndIds(rawText),
    other: [],
  };

  const sentences = splitSentences(rawText);

  for (const sentence of sentences) {
    const section = classifySentence(sentence);
    addUnique(sections[section], sentence);
  }

  const summaryCandidates = sentences
    .filter((sentence) => sentence.length >= 60 && sentence.length <= 240)
    .slice(0, 4);

  for (const sentence of summaryCandidates) addUnique(sections.summary, sentence);

  const importantOther = sentences
    .filter((sentence) => classifySentence(sentence) === "other")
    .map((sentence) => ({ sentence, score: scoreSentence(sentence) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((item) => item.sentence);

  sections.other = [];
  for (const sentence of importantOther) addUnique(sections.other, sentence);

  return sections;
}

function isProtectedSection(sectionName: SectionName): boolean {
  return [
    "decisions",
    "owners",
    "datesMilestones",
    "blockers",
    "risks",
    "dependencies",
    "requirements",
    "actionItems",
    "openQuestions",
    "urlsIds",
  ].includes(sectionName);
}

function sectionLimit(mode: CompressionMode, sectionName: SectionName, itemCount: number): number {
  if (mode === "lossless_facts") {
    return itemCount;
  }

  if (mode === "structured" && isProtectedSection(sectionName)) {
    return itemCount;
  }

  if (mode === "brief") {
    const limits: Record<SectionName, number> = {
      summary: 3,
      decisions: 4,
      owners: 4,
      datesMilestones: 4,
      blockers: 4,
      risks: 4,
      dependencies: 3,
      requirements: 4,
      actionItems: 5,
      openQuestions: 4,
      urlsIds: 6,
      other: 3,
    };
    return Math.min(itemCount, limits[sectionName]);
  }

  if (mode === "balanced") {
    const limits: Record<SectionName, number> = {
      summary: 4,
      decisions: 6,
      owners: 8,
      datesMilestones: 6,
      blockers: 6,
      risks: 6,
      dependencies: 5,
      requirements: 6,
      actionItems: 8,
      openQuestions: 6,
      urlsIds: 8,
      other: 5,
    };
    return Math.min(itemCount, limits[sectionName]);
  }

  const structuredNarrativeLimits: Record<SectionName, number> = {
    summary: 4,
    decisions: itemCount,
    owners: itemCount,
    datesMilestones: itemCount,
    blockers: itemCount,
    risks: itemCount,
    dependencies: itemCount,
    requirements: itemCount,
    actionItems: itemCount,
    openQuestions: itemCount,
    urlsIds: itemCount,
    other: 4,
  };

  return Math.min(itemCount, structuredNarrativeLimits[sectionName]);
}

function bulletize(items: string[], maxItems: number): string {
  const selected = items.slice(0, maxItems);
  if (selected.length === 0) return "• None detected.";
  return selected.map((item) => `• ${item}`).join("\n");
}

function renderSection(title: string, items: string[], maxItems: number): string {
  return [`## ${title}`, bulletize(items, maxItems)].join("\n");
}

function buildOutput(sections: Sections, mode: CompressionMode, targetTokens: number): string {
  const orderedSections: Array<[string, SectionName]> = [
    ["Summary", "summary"],
    ["Decisions", "decisions"],
    ["Owners", "owners"],
    ["Dates / Milestones", "datesMilestones"],
    ["Blockers", "blockers"],
    ["Risks", "risks"],
    ["Dependencies", "dependencies"],
    ["Requirements / Success Criteria", "requirements"],
    ["Action Items", "actionItems"],
    ["Open Questions", "openQuestions"],
    ["URLs / IDs", "urlsIds"],
    ["Other Important Context", "other"],
  ];

  const warnings: string[] = [];

  const render = (includeOther: boolean, shrinkNarrative: boolean): string => {
    const parts = ["Compressed context:"];

    for (const [title, key] of orderedSections) {
      if (!includeOther && key === "other") continue;

      const itemCount = sections[key].length;
      const baseLimit = sectionLimit(mode, key, itemCount);

      let limit = baseLimit;
      if (shrinkNarrative && !isProtectedSection(key)) {
        limit = Math.max(1, Math.ceil(baseLimit / 2));
      }

      parts.push("", renderSection(title, sections[key], limit));
    }

    if (warnings.length > 0) {
      parts.push("", "## Fidelity Warnings", bulletize(warnings, 10));
    }

    parts.push(
      "",
      "## Use Guidance",
      "• Use this compact context instead of the raw source unless exact wording is required.",
      "• Verify protected facts against the source before final decisions.",
    );

    return parts.join("\n");
  };

  let output = render(mode !== "brief" && mode !== "lossless_facts", false);

  if (mode === "lossless_facts") return output;

  if (estimateTokens(output) <= targetTokens) return output;

  warnings.push(`Output exceeded target of ${targetTokens} tokens; non-critical context was trimmed first.`);
  output = render(false, false);

  if (estimateTokens(output) <= targetTokens) return output;

  if (mode === "structured") {
    warnings.push("Protected facts were preserved even though the output exceeded the requested target.");
    return output;
  }

  warnings.push("Protected sections were reduced to fit the target token budget.");
  output = render(false, true);

  return output;
}

function compressText(rawText: string, targetTokens = 1200, mode: CompressionMode = "structured"): string {
  const rawTokens = estimateTokens(rawText);

  if (rawTokens < 150) {
    return [
      "Input is already short.",
      "",
      `Raw token estimate: ${rawTokens}`,
      "Compression threshold: 150 tokens",
      "",
      "Recommendation:",
      "• Use the text as-is unless you need to store it for later retrieval.",
    ].join("\n");
  }

  const sections = extractSections(rawText);
  return buildOutput(sections, mode, targetTokens);
}

function recordToText(record: ContextRecord): string {
  return [
    `ID: ${record.id}`,
    `Title: ${record.title}`,
    `Tags: ${record.tags.join(", ") || "none"}`,
    `Raw token estimate: ${record.rawTokenEstimate}`,
    `Compressed token estimate: ${record.compressedTokenEstimate}`,
    `Estimated reduction: ${Math.round(record.compressionRatio * 100)}%`,
    `Updated: ${record.updatedAt}`,
    "",
    record.compressedText,
  ].join("\n");
}

const compressionModeSchema = z
  .enum(["brief", "balanced", "structured", "lossless_facts"])
  .default("structured")
  .describe("Compression mode. structured preserves project-management fields by default. lossless_facts preserves extracted facts even if reduction is lower.");

server.tool(
  {
    name: "compress_context",
    description:
      "Compress long pasted text into a structured summary without saving it. Use for meeting notes, transcripts, project docs, research, or repeated context. Preserves decisions, owners, dates, risks, blockers, dependencies, requirements, action items, open questions, IDs, and links.",
    schema: z.object({
      text: z.string().min(1).describe("Raw text to compress."),
      targetTokens: z.number().int().min(100).max(4000).default(1200).describe("Approximate target token budget for the compressed output."),
      mode: compressionModeSchema,
    }),
  },
  async ({ text: rawText, targetTokens, mode }) => {
    const compressed = compressText(rawText, targetTokens, mode);
    const rawEstimate = estimateTokens(rawText);
    const compressedEstimate = estimateTokens(compressed);
    const reduction = rawEstimate === 0 ? 0 : 1 - compressedEstimate / rawEstimate;

    return text([
      `Mode: ${mode}`,
      `Raw token estimate: ${rawEstimate}`,
      `Compressed token estimate: ${compressedEstimate}`,
      `Estimated reduction: ${Math.max(0, Math.round(reduction * 100))}%`,
      "",
      compressed,
    ].join("\n"));
  },
);

server.tool(
  {
    name: "save_context",
    description:
      "Save raw text and a compressed reusable summary for later retrieval. Use when the user provides long non-sensitive context they may need again in future Claude/Cowork sessions. Do not use for sensitive or confidential data unless the user explicitly approves storage.",
    schema: z.object({
      title: z.string().min(1).describe("Short human-readable title."),
      text: z.string().min(1).describe("Raw context text to save and compress."),
      tags: z.array(z.string()).default([]).describe("Optional tags for retrieval."),
      targetTokens: z.number().int().min(100).max(4000).default(1200).describe("Approximate target token budget for the compressed summary."),
      mode: compressionModeSchema,
    }),
  },
  async ({ title, text: rawText, tags, targetTokens, mode }) => {
    const id = makeId();
    const compressedText = compressText(rawText, targetTokens, mode);
    const rawTokenEstimate = estimateTokens(rawText);
    const compressedTokenEstimate = estimateTokens(compressedText);
    const compressionRatio = rawTokenEstimate === 0 ? 0 : Math.max(0, 1 - compressedTokenEstimate / rawTokenEstimate);
    const now = new Date().toISOString();

    const record: ContextRecord = {
      id,
      title,
      tags,
      rawText,
      compressedText,
      rawTokenEstimate,
      compressedTokenEstimate,
      compressionRatio,
      createdAt: now,
      updatedAt: now,
    };

    store.set(id, record);
    return text(`Saved context.\n\n${recordToText(record)}`);
  },
);

server.tool(
  {
    name: "retrieve_context",
    description:
      "Retrieve relevant saved compressed context by title, tag, ID, or query. Use this instead of asking the user to re-paste long background material.",
    schema: z.object({
      query: z.string().min(1).describe("Title, tag, ID, or search term."),
      limit: z.number().int().min(1).max(10).default(3).describe("Maximum records to return."),
    }),
  },
  async ({ query, limit }) => {
    const q = query.toLowerCase();
    const matches = Array.from(store.values())
      .filter((record) => [record.id, record.title, ...record.tags, record.compressedText].join(" ").toLowerCase().includes(q))
      .slice(0, limit);

    if (matches.length === 0) return text(`No saved context found for query: ${query}`);
    return text(matches.map(recordToText).join("\n\n---\n\n"));
  },
);

server.tool(
  {
    name: "list_contexts",
    description: "List saved compressed context records with IDs, titles, tags, token estimates, and update times.",
    schema: z.object({
      limit: z.number().int().min(1).max(50).default(20).describe("Maximum records to list."),
    }),
  },
  async ({ limit }) => {
    const records = Array.from(store.values()).slice(0, limit);
    if (records.length === 0) return text("No saved contexts.");

    return text(records.map((record) => [
      `ID: ${record.id}`,
      `Title: ${record.title}`,
      `Tags: ${record.tags.join(", ") || "none"}`,
      `Raw tokens: ${record.rawTokenEstimate}`,
      `Compressed tokens: ${record.compressedTokenEstimate}`,
      `Reduction: ${Math.round(record.compressionRatio * 100)}%`,
      `Updated: ${record.updatedAt}`,
    ].join("\n")).join("\n\n"));
  },
);

server.tool(
  {
    name: "context_stats",
    description: "Show estimated aggregate token savings across saved compressed context records.",
    schema: z.object({}),
  },
  async () => {
    const records = Array.from(store.values());
    const raw = records.reduce((sum, record) => sum + record.rawTokenEstimate, 0);
    const compressed = records.reduce((sum, record) => sum + record.compressedTokenEstimate, 0);
    const saved = Math.max(0, raw - compressed);
    const reduction = raw === 0 ? 0 : Math.round((1 - compressed / raw) * 100);

    return text([
      `Saved records: ${records.length}`,
      `Raw token estimate: ${raw}`,
      `Compressed token estimate: ${compressed}`,
      `Estimated tokens avoided per full reuse: ${saved}`,
      `Average estimated reduction: ${Math.max(0, reduction)}%`,
    ].join("\n"));
  },
);

server.tool(
  {
    name: "delete_context",
    description: "Delete one saved context record by ID. Use when the user asks to remove stored context or clear sensitive material.",
    schema: z.object({
      id: z.string().min(1).describe("Saved context ID."),
    }),
  },
  async ({ id }) => {
    const existed = store.delete(id);
    return text(existed ? `Deleted context: ${id}` : `No context found with ID: ${id}`);
  },
);

server.tool(
  {
    name: "clear_contexts",
    description: "Delete all saved contexts. Use only when the user explicitly asks to clear all stored context.",
    schema: z.object({
      confirm: z.boolean().describe("Must be true to clear all contexts."),
    }),
  },
  async ({ confirm }) => {
    if (!confirm) return text("Clear cancelled. Set confirm=true to delete all contexts.");
    const count = store.size;
    store.clear();
    return text(`Deleted ${count} saved contexts.`);
  },
);

const port = Number(process.env.PORT ?? 3000);
await server.listen(port);
