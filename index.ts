import { MCPServer, text } from "mcp-use/server";
import { z } from "zod";

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

const store = new Map<string, ContextRecord>();

const server = new MCPServer({
  name: "token-compressor-mcp",
  title: "Token Compressor MCP",
  version: "0.2.0",
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

function scoreSentence(sentence: string): number {
  const lower = sentence.toLowerCase();
  let score = 0;

  const highValueTerms = [
    "decision",
    "decided",
    "owner",
    "due",
    "deadline",
    "risk",
    "blocker",
    "dependency",
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
  if (/\b\d{1,2}[/-]\d{1,2}([/-]\d{2,4})?\b|\b\d{4}-\d{2}-\d{2}\b/.test(sentence)) score += 2;
  if (/https?:\/\//.test(sentence)) score += 2;
  if (/\b[A-Z]+-\d+\b/.test(sentence)) score += 2;
  if (sentence.length > 40 && sentence.length < 260) score += 1;
  if (sentence.length > 300) score -= 1;

  return score;
}

function bulletize(lines: string[]): string {
  const unique = Array.from(
    new Set(lines.map((line) => line.trim()).filter(Boolean)),
  );
  return unique.map((line) => `• ${line}`).join("\n");
}

function compressText(rawText: string, targetTokens = 1200): string {
  const cleaned = normalizeWhitespace(rawText);
  if (!cleaned) return "";

  const lines = cleaned.split("\n").map((line) => line.trim()).filter(Boolean);
  const explicitBullets = lines.filter((line) => /^[-*•]\s+|^\d+[.)]\s+/.test(line));
  const sentences = splitSentences(cleaned);

  const highValueSentences = sentences
    .map((sentence) => ({ sentence, score: scoreSentence(sentence) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((item) => item.sentence);

  const selected: string[] = [];

  for (const line of explicitBullets.slice(0, 30)) {
    selected.push(line.replace(/^[-*•]\s+/, "").replace(/^\d+[.)]\s+/, ""));
  }

  for (const sentence of highValueSentences) {
    selected.push(sentence);
    if (estimateTokens(bulletize(selected)) >= targetTokens) break;
  }

  if (selected.length < 5) {
    for (const sentence of sentences.slice(0, 14)) selected.push(sentence);
  }

  const compressed = bulletize(selected);

  return [
    "Compressed context:",
    compressed,
    "",
    "Use guidance:",
    "• Use this compact context instead of the raw source unless exact wording is required.",
    "• Preserve IDs, dates, owners, decisions, risks, blockers, and links exactly when drafting from this context.",
  ].join("\n");
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

server.tool(
  {
    name: "compress_context",
    description:
      "Compress long pasted text into a dense summary without saving it. Use for meeting notes, transcripts, project docs, research, or repeated context. Preserves decisions, owners, dates, risks, blockers, IDs, links, and next actions.",
    schema: z.object({
      text: z.string().min(1).describe("Raw text to compress."),
      targetTokens: z.number().int().min(100).max(4000).default(1200).describe("Approximate target token budget for the compressed output."),
    }),
  },
  async ({ text: rawText, targetTokens }) => {
    const compressed = compressText(rawText, targetTokens);
    const rawEstimate = estimateTokens(rawText);
    const compressedEstimate = estimateTokens(compressed);
    const reduction = rawEstimate === 0 ? 0 : 1 - compressedEstimate / rawEstimate;

    return text([
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
    }),
  },
  async ({ title, text: rawText, tags, targetTokens }) => {
    const id = makeId();
    const compressedText = compressText(rawText, targetTokens);
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
