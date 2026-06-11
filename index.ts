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

type ExtractedSections = {
  summary: string[];
  decisions: string[];
  owners: string[];
  datesMilestones: string[];
  blockers: string[];
  risks: string[];
  dependencies: string[];
  requirements: string[];
  actionItems: string[];
  openQuestions: string[];
  urlsIds: string[];
  otherImportant: string[];
};

const store = new Map<string, ContextRecord>();

const server = new MCPServer({
  name: "token-compressor-mcp",
  title: "Token Compressor MCP",
  version: "0.3.0",
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
    .replace(/[\t ]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function splitSentences(input: string): string[] {
  return normalizeWhitespace(input)
    .split(/(?<=[.!?])\s+(?=[A-Z0-9])/g)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function unique(items: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const item of items) {
    const cleaned = item
      .replace(/^[-*•]\s+/, "")
      .replace(/^\d+[.)]\s+/, "")
      .replace(/\s+/g, " ")
      .trim();

    if (!cleaned) continue;

    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;

    seen.add(key);
    result.push(cleaned);
  }

  return result;
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

  return unique(matches);
}

function scoreSentence(sentence: string): number {
  const lower = sentence.toLowerCase();
  let score = 0;

  const highValueTerms = [
    "decision",
    "decided",
    "approved",
    "owner",
    "owns",
    "sponsor",
    "lead",
    "due",
    "deadline",
    "risk",
    "blocker",
    "blocked",
    "dependency",
    "depends on",
    "next step",
    "action",
    "todo",
    "requirement",
    "must",
    "should",
    "approval",
    "launch",
    "date",
    "milestone",
    "open question",
    "issue",
    "constraint",
    "success criteria",
    "metric",
    "scope",
    "status",
    "timeline",
  ];

  for (const term of highValueTerms) {
    if (lower.includes(term)) score += 3;
  }

  if (/\b[A-Z][a-z]+\s[A-Z][a-z]+\b/.test(sentence)) score += 2;
  if (hasDate(sentence)) score += 2;
  if (/https?:\/\//.test(sentence)) score += 2;
  if (/\b[A-Z]+-\d+\b/.test(sentence)) score += 2;
  if (sentence.length > 40 && sentence.length < 260) score += 1;
  if (sentence.length > 300) score -= 1;

  return score;
}

function extractSections(rawText: string): ExtractedSections {
  const cleaned = normalizeWhitespace(rawText);
  const lines = cleaned.split("\n").map((line) => line.trim()).filter(Boolean);
  const sentences = splitSentences(cleaned);
  const allUnits = unique([...lines, ...sentences]);

  const sections: ExtractedSections = {
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
    urlsIds: extractUrlsAndIds(cleaned),
    otherImportant: [],
  };

  for (const unit of allUnits) {
    const lower = unit.toLowerCase();

    if (
      includesAny(lower, ["decision", "decided", "approved", "final call", "chosen", "agreed to", "will use", "approach will"])
    ) {
      sections.decisions.push(unit);
    }

    if (
      /\b[A-Z][a-z]+(\s[A-Z][a-z]+)?\s+owns\b/.test(unit)
      || includesAny(lower, ["project sponsor", "program lead", "owns ", "owner is", "owner:", "responsible for", "accountable for"])
    ) {
      sections.owners.push(unit);
    }

    if (
      hasDate(unit)
      || includesAny(lower, ["target launch", "launch date", "deadline", "milestone", "go/no-go", "readiness checklist", "backup date"])
    ) {
      sections.datesMilestones.push(unit);
    }

    if (
      includesAny(lower, ["blocker", "blocked", "blocking", "primary blocker", "main blocker", "cannot", "unable to"])
    ) {
      sections.blockers.push(unit);
    }

    if (
      includesAny(lower, ["risk", "concern", "could affect", "could create", "may cause", "mitigation", "disruption"])
    ) {
      sections.risks.push(unit);
    }

    if (
      includesAny(lower, ["depends on", "dependency", "dependent on", "requires", "requires vendor", "requires identity"])
    ) {
      sections.dependencies.push(unit);
    }

    if (
      includesAny(lower, ["requirement", "must", "should", "success criteria", "target", "criteria", "metric", "readiness"])
    ) {
      sections.requirements.push(unit);
    }

    if (
      includesAny(lower, ["action item", "next step", "will ", " to draft ", " to send ", " to confirm ", " to complete ", " to run ", " to publish ", " to prepare "])
      && (hasDate(unit) || includesAny(lower, ["by ", "next step", "action item"]))
    ) {
      sections.actionItems.push(unit);
    }

    if (
      includesAny(lower, ["open question", "not decided", "no final answer", "needs a decision", "needs guidance", "whether "])
      || unit.endsWith("?")
    ) {
      sections.openQuestions.push(unit);
    }
  }

  const important = sentences
    .map((sentence) => ({ sentence, score: scoreSentence(sentence) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((item) => item.sentence);

  sections.otherImportant = unique(important).slice(0, 20);

  const firstSentences = sentences
    .filter((sentence) => sentence.length > 60 && sentence.length < 260)
    .slice(0, 4);

  sections.summary = unique(firstSentences);

  for (const key of Object.keys(sections) as Array<keyof ExtractedSections>) {
    sections[key] = unique(sections[key]);
  }

  return sections;
}

function bulletize(items: string[], maxItems?: number): string {
  const selected = typeof maxItems === "number" ? items.slice(0, maxItems) : items;
  if (selected.length === 0) return "• None detected.";
  return selected.map((item) => `• ${item}`).join("\n");
}

function section(title: string, items: string[], maxItems?: number): string {
  return [`## ${title}`, bulletize(items, maxItems)].join("\n");
}

function buildStructuredOutput(rawText: string, targetTokens: number, mode: CompressionMode): string {
  const rawTokens = estimateTokens(rawText);
  const extracted = extractSections(rawText);

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

  const warnings: string[] = [];

  if (rawText.toLowerCase().includes("owner") && extracted.owners.length === 0) {
    warnings.push("Owner-related language was detected, but no owner mappings were confidently extracted.");
  }

  if (
    includesAny(rawText.toLowerCase(), ["action", "next step", "will "])
    && extracted.actionItems.length === 0
  ) {
    warnings.push("Action-related language was detected, but no action items were confidently extracted.");
  }

  if (
    includesAny(rawText.toLowerCase(), ["open question", "not decided", "whether"])
    && extracted.openQuestions.length === 0
  ) {
    warnings.push("Open-question language was detected, but no open questions were confidently extracted.");
  }

  const isBrief = mode === "brief";
  const isBalanced = mode === "balanced";
  const isLosslessFacts = mode === "lossless_facts";

  const maxSummary = isBrief ? 3 : 5;
  const maxOther = isBrief ? 6 : isBalanced ? 10 : 14;
  const protectedMax = isBrief ? 8 : undefined;

  const parts = [
    "Compressed context:",
    "",
    section("Summary", extracted.summary, maxSummary),
    "",
    section("Decisions", extracted.decisions, protectedMax),
    "",
    section("Owners", extracted.owners, protectedMax),
    "",
    section("Dates / Milestones", extracted.datesMilestones, protectedMax),
    "",
    section("Blockers", extracted.blockers, protectedMax),
    "",
    section("Risks", extracted.risks, protectedMax),
    "",
    section("Dependencies", extracted.dependencies, protectedMax),
    "",
    section("Requirements / Success Criteria", extracted.requirements, protectedMax),
    "",
    section("Action Items", extracted.actionItems, protectedMax),
    "",
    section("Open Questions", extracted.openQuestions, protectedMax),
    "",
    section("URLs / IDs", extracted.urlsIds, protectedMax),
  ];

  if (!isLosslessFacts) {
    parts.push("", section("Other Important Context", extracted.otherImportant, maxOther));
  }

  if (warnings.length > 0) {
    parts.push("", "## Fidelity Warnings", bulletize(warnings));
  }

  parts.push(
    "",
    "## Use Guidance",
    "• Use this compact context instead of the raw source unless exact wording is required.",
    "• Verify protected facts against the source before making final decisions.",
    "• Prefer a lower compression ratio over dropping owners, dates, decisions, risks, blockers, action items, IDs, or links.",
  );

  let output = parts.join("\n");

  if (estimateTokens(output) <= targetTokens || isLosslessFacts) {
    return output;
  }

  const reduced = [
    "Compressed context:",
    "",
    section("Summary", extracted.summary, maxSummary),
    "",
    section("Decisions", extracted.decisions, protectedMax),
    "",
    section("Owners", extracted.owners, protectedMax),
    "",
    section("Dates / Milestones", extracted.datesMilestones, protectedMax),
    "",
    section("Blockers", extracted.blockers, protectedMax),
    "",
    section("Risks", extracted.risks, protectedMax),
    "",
    section("Dependencies", extracted.dependencies, protectedMax),
    "",
    section("Requirements / Success Criteria", extracted.requirements, protectedMax),
    "",
    section("Action Items", extracted.actionItems, protectedMax),
    "",
    section("Open Questions", extracted.openQuestions, protectedMax),
    "",
    section("URLs / IDs", extracted.urlsIds, protectedMax),
  ];

  if (warnings.length > 0) {
    reduced.push("", "## Fidelity Warnings", bulletize(warnings));
  }

  reduced.push(
    "",
    "## Compression Note",
    `• Output exceeded the requested target of ${targetTokens} tokens, so narrative context was removed before protected facts.`,
  );

  output = reduced.join("\n");
  return output;
}

function compressText(rawText: string, targetTokens = 1200, mode: CompressionMode = "structured"): string {
  return buildStructuredOutput(rawText, targetTokens, mode);
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
    if (!confirm) return text("Clear cancelled. Set confirm=true to delete all saved contexts.");
    const count = store.size;
    store.clear();
    return text(`Deleted ${count} saved contexts.`);
  },
);

const port = Number(process.env.PORT ?? 3000);
await server.listen(port);
