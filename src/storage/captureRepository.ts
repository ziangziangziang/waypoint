import { randomUUID, createHash } from "crypto";
import { promises as fs } from "fs";
import path from "path";
import { StoragePaths } from "./files";

const DEFAULT_CAPTURE_CONFIG: CaptureConfig = {
  enabled: false,
  retentionDays: 30,
  maxBytes: 20 * 1024 * 1024 * 1024,
};

const DATA_URL_RE = /^data:([^;]+);base64,(.+)$/i;

export interface CaptureConfig {
  enabled: boolean;
  retentionDays: number;
  maxBytes: number;
}

export interface CaptureRoutingInfo {
  publicModel?: string;
  endpointId?: string;
  endpointName?: string;
  upstreamModel?: string;
}

export interface CaptureRecordInput {
  route: string;
  method: string;
  statusCode: number;
  latencyMs: number;
  requestHeaders?: Record<string, string | string[] | undefined>;
  responseHeaders?: Record<string, string | string[] | undefined>;
  requestBody?: unknown;
  responseBody?: unknown;
  derivedRequest?: Record<string, unknown>;
  routing?: CaptureRoutingInfo;
  error?: { type?: string; message?: string };
}

export interface CaptureRecord {
  id: string;
  timestamp: string;
  route: string;
  method: string;
  captureEnabledSnapshot: boolean;
  statusCode: number;
  latencyMs: number;
  request: {
    headers: Record<string, string>;
    body?: unknown;
    derived?: Record<string, unknown>;
  };
  response: {
    headers: Record<string, string>;
    body?: unknown;
    error?: { type?: string; message?: string };
  };
  routing: CaptureRoutingInfo;
  analysis: CaptureAnalysisProjection;
  artifacts: CaptureArtifact[];
}

export interface CaptureArtifact {
  hash: string;
  mime: string;
  bytes: number;
  blobRef: string;
  kind: "image" | "audio" | "binary";
}

export interface CaptureAnalysisProjection {
  systemMessages: CaptureTextMessage[];
  userMessages: CaptureTextMessage[];
  assistantMessages: CaptureAssistantMessage[];
  toolMessages: CaptureToolMessage[];
  requestTimeline: CaptureTimelineEntry[];
  responseTimeline: CaptureTimelineEntry[];
  tools: Array<{ name: string; description?: string }>;
  mcpToolDescriptions: string[];
  agentsMdHints: string[];
  rawSections: string[];
  tokenFlow: CaptureTokenFlow;
}

export type CaptureTokenFlowMethod =
  | "exact_totals_estimated_categories"
  | "estimated_only"
  | "unavailable";

export interface CaptureTokenFlowBucket {
  key: string;
  label: string;
  tokens: number;
}

export interface CaptureTokenFlow {
  eligible: boolean;
  reason?: string;
  method: CaptureTokenFlowMethod;
  totals: {
    inputTokens: number | null;
    outputTokens: number | null;
    totalTokens: number | null;
  };
  input: CaptureTokenFlowBucket[];
  output: CaptureTokenFlowBucket[];
  notes?: string[];
}

export interface CaptureTextMessage {
  content: string;
  truncated?: boolean;
  originalLength?: number;
}

export interface CaptureAssistantMessage extends CaptureTextMessage {
  reasoningContent?: string;
  toolCalls?: CaptureToolCall[];
  asksForClarification?: boolean;
}

export interface CaptureToolMessage extends CaptureTextMessage {
  toolCallId?: string;
}

export interface CaptureToolCall {
  id?: string;
  type?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
}

export interface CaptureTimelineEntry {
  direction: "request" | "response";
  kind:
    | "message"
    | "tool_definition"
    | "tool_call"
    | "tool_result"
    | "reasoning"
    | "instructions"
    | "stream_preview"
    | "error";
  index: number;
  sourcePath: string;
  role?: "system" | "user" | "assistant" | "tool" | "developer";
  content?: string;
  name?: string;
  arguments?: string;
  toolCallId?: string;
  metadata?: Record<string, unknown>;
}

export interface CaptureCalendarDaySummary {
  date: string;
  count: number;
}

interface CaptureIndexEntry {
  id: string;
  timestamp: string;
  route: string;
  method: string;
  statusCode: number;
  latencyMs: number;
  model?: string;
  file: string;
}

interface ListCaptureRecordsOptions {
  limit?: number;
  offset?: number;
  date?: string;
}

function captureDir(paths: StoragePaths): string {
  return path.join(paths.baseDir, "capture");
}

function captureConfigPath(paths: StoragePaths): string {
  return path.join(captureDir(paths), "config.json");
}

function captureIndexPath(paths: StoragePaths): string {
  return path.join(captureDir(paths), "index.jsonl");
}

function captureRecordsDir(paths: StoragePaths): string {
  return path.join(captureDir(paths), "records");
}

function captureBlobsDir(paths: StoragePaths): string {
  return path.join(captureDir(paths), "blobs");
}

export async function ensureCaptureStore(paths: StoragePaths): Promise<void> {
  await fs.mkdir(captureDir(paths), { recursive: true });
  await fs.mkdir(captureRecordsDir(paths), { recursive: true });
  await fs.mkdir(captureBlobsDir(paths), { recursive: true });
  const configPath = captureConfigPath(paths);
  try {
    await fs.access(configPath);
  } catch {
    await fs.writeFile(configPath, JSON.stringify(DEFAULT_CAPTURE_CONFIG, null, 2), "utf8");
  }
}

export async function getCaptureConfig(paths: StoragePaths): Promise<CaptureConfig> {
  await ensureCaptureStore(paths);
  try {
    const raw = await fs.readFile(captureConfigPath(paths), "utf8");
    const parsed = JSON.parse(raw) as Partial<CaptureConfig>;
    return normalizeCaptureConfig(parsed);
  } catch {
    return { ...DEFAULT_CAPTURE_CONFIG };
  }
}

export async function updateCaptureConfig(
  paths: StoragePaths,
  patch: Partial<CaptureConfig>
): Promise<CaptureConfig> {
  const current = await getCaptureConfig(paths);
  const next = normalizeCaptureConfig({ ...current, ...patch });
  await fs.writeFile(captureConfigPath(paths), JSON.stringify(next, null, 2), "utf8");
  return next;
}

export async function isCaptureEnabled(paths: StoragePaths): Promise<boolean> {
  const config = await getCaptureConfig(paths);
  return config.enabled;
}

export async function persistCaptureRecord(
  paths: StoragePaths,
  input: CaptureRecordInput
): Promise<CaptureRecord | null> {
  const config = await getCaptureConfig(paths);
  if (!config.enabled) {
    return null;
  }

  const id = randomUUID();
  const now = new Date();
  const timestamp = now.toISOString();
  const artifacts: CaptureArtifact[] = [];
  const requestBodyPreview = await buildPreviewBody(paths, input.requestBody, artifacts);
  const responseBodyPreview = await buildPreviewBody(paths, input.responseBody, artifacts);

  const record: CaptureRecord = {
    id,
    timestamp,
    route: input.route,
    method: input.method,
    captureEnabledSnapshot: true,
    statusCode: input.statusCode,
    latencyMs: input.latencyMs,
    request: {
      headers: normalizeHeaderRecord(input.requestHeaders),
      body: input.requestBody,
      derived: input.derivedRequest,
    },
    response: {
      headers: normalizeHeaderRecord(input.responseHeaders),
      body: input.responseBody,
      error: input.error,
    },
    routing: input.routing ?? {},
    analysis: buildAnalysisProjection(input.route, input.requestBody, input.responseBody, input.derivedRequest),
    artifacts,
  };

  // Attach preview representations in derived block for UI readability.
  if (requestBodyPreview !== undefined || responseBodyPreview !== undefined) {
    record.request.derived = {
      ...(record.request.derived ?? {}),
      preview: {
        request: requestBodyPreview,
        response: responseBodyPreview,
      },
    };
  }

  const datePath = path.join(
    captureRecordsDir(paths),
    `${now.getUTCFullYear()}`,
    `${String(now.getUTCMonth() + 1).padStart(2, "0")}`,
    `${String(now.getUTCDate()).padStart(2, "0")}`
  );
  await fs.mkdir(datePath, { recursive: true });
  const fileName = `${timestamp.replace(/[:.]/g, "-")}_${id}.json`;
  const absoluteRecordPath = path.join(datePath, fileName);
  await fs.writeFile(absoluteRecordPath, JSON.stringify(record, null, 2), "utf8");

  const relRecordPath = path.relative(captureDir(paths), absoluteRecordPath);
  const entry: CaptureIndexEntry = {
    id,
    timestamp,
    route: input.route,
    method: input.method,
    statusCode: input.statusCode,
    latencyMs: input.latencyMs,
    model: input.routing?.publicModel,
    file: relRecordPath,
  };
  await fs.appendFile(captureIndexPath(paths), `${JSON.stringify(entry)}\n`, "utf8");
  await applyCaptureRetention(paths, config);
  return record;
}

export async function runCaptureRetention(paths: StoragePaths): Promise<void> {
  const config = await getCaptureConfig(paths);
  await applyCaptureRetention(paths, config);
}

export async function listCaptureRecords(
  paths: StoragePaths,
  options: number | ListCaptureRecordsOptions = 5
): Promise<{ data: CaptureIndexEntry[]; total: number }> {
  await ensureCaptureStore(paths);
  const entries = await readCaptureIndex(paths, { pruneMissing: true });
  const opts =
    typeof options === "number"
      ? { limit: options, offset: 0 }
      : { limit: 5, offset: 0, ...options };
  const limit = Math.max(1, Math.min(200, Math.floor(opts.limit ?? 5)));
  const offset = Math.max(0, Math.floor(opts.offset ?? 0));
  const filtered = opts.date
    ? entries.filter((entry) => utcDateString(entry.timestamp) === opts.date)
    : entries;
  const newestFirst = [...filtered].reverse();
  return {
    data: newestFirst.slice(offset, offset + limit),
    total: filtered.length,
  };
}

export async function getCaptureRecordById(
  paths: StoragePaths,
  id: string
): Promise<CaptureRecord | null> {
  const entries = await readCaptureIndex(paths, { pruneMissing: true });
  const match = entries.find((entry) => entry.id === id);
  if (!match) {
    return null;
  }
  const absolute = path.join(captureDir(paths), match.file);
  try {
    const raw = await fs.readFile(absolute, "utf8");
    return hydrateCaptureRecord(JSON.parse(raw) as CaptureRecord);
  } catch {
    return null;
  }
}

export async function getCaptureCalendarMonth(
  paths: StoragePaths,
  month: string
): Promise<CaptureCalendarDaySummary[]> {
  await ensureCaptureStore(paths);
  const entries = await readCaptureIndex(paths, { pruneMissing: true });
  const counts = new Map<string, number>();
  for (const entry of entries) {
    const date = utcDateString(entry.timestamp);
    if (!date.startsWith(`${month}-`)) continue;
    counts.set(date, (counts.get(date) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, count]) => ({ date, count }));
}

export async function findCaptureBlobPath(
  paths: StoragePaths,
  hash: string
): Promise<{ path: string; mime: string } | null> {
  await ensureCaptureStore(paths);
  const blobDir = captureBlobsDir(paths);
  let files: string[];
  try {
    files = await fs.readdir(blobDir);
  } catch {
    return null;
  }
  const candidate = files.find((name) => name.startsWith(`${hash}.`));
  if (!candidate) return null;
  const ext = candidate.split(".").pop()?.toLowerCase() ?? "bin";
  return {
    path: path.join(blobDir, candidate),
    mime: extToMime(ext),
  };
}

function normalizeCaptureConfig(input: Partial<CaptureConfig>): CaptureConfig {
  const retentionDays = Number.isFinite(input.retentionDays) ? Number(input.retentionDays) : DEFAULT_CAPTURE_CONFIG.retentionDays;
  const maxBytes = Number.isFinite(input.maxBytes) ? Number(input.maxBytes) : DEFAULT_CAPTURE_CONFIG.maxBytes;
  return {
    enabled: input.enabled === true,
    retentionDays: Math.max(1, Math.min(365, Math.floor(retentionDays))),
    maxBytes: Math.max(50 * 1024 * 1024, Math.floor(maxBytes)),
  };
}

function normalizeHeaderRecord(
  headers: Record<string, string | string[] | undefined> | undefined
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  for (const [key, value] of Object.entries(headers)) {
    if (!value) continue;
    out[key.toLowerCase()] = Array.isArray(value) ? value.join(", ") : String(value);
  }
  return out;
}

function buildAnalysisProjection(
  route: string,
  requestBody: unknown,
  responseBody: unknown,
  derived?: Record<string, unknown>
): CaptureAnalysisProjection {
  const source = (derived?.normalizedRequest as Record<string, unknown> | undefined) ?? asRecord(requestBody);
  const messages = Array.isArray(source?.messages) ? source.messages : [];
  const toolsRaw = Array.isArray(source?.tools) ? source.tools : [];
  const systemMessages: CaptureTextMessage[] = [];
  const userMessages: CaptureTextMessage[] = [];
  const assistantMessages: CaptureAssistantMessage[] = [];
  const toolMessages: CaptureToolMessage[] = [];
  const tools: Array<{ name: string; description?: string }> = [];
  const mcpToolDescriptions: string[] = [];
  const hints = new Set<string>();
  const rawSections: string[] = [];
  const requestTimeline = buildRequestTimeline(source, rawSections);
  const responseTimeline = buildResponseTimeline(responseBody);

  for (const message of messages) {
    const m = asRecord(message);
    if (!m) continue;
    const role = typeof m.role === "string" ? m.role : "unknown";
    const content = extractTextContent(m.content);
    const reasoningContent =
      typeof m.reasoning_content === "string" ? m.reasoning_content : undefined;
    const combinedText = [content, reasoningContent].filter(Boolean).join("\n\n").trim();
    if (combinedText && /(agents\.md|guardrail|mcp|tool|policy)/i.test(combinedText)) {
      hints.add(combinedText);
    }

    if (role === "system" && content) {
      systemMessages.push({ content });
      continue;
    }
    if (role === "user" && content) {
      userMessages.push({ content });
      continue;
    }
    if (role === "assistant") {
      const assistantMessage: CaptureAssistantMessage = {
        content,
      };
      if (reasoningContent) assistantMessage.reasoningContent = reasoningContent;
      const toolCalls = extractToolCalls(m.tool_calls);
      if (toolCalls.length > 0) assistantMessage.toolCalls = toolCalls;
      if (looksLikeClarification(content)) assistantMessage.asksForClarification = true;
      if (
        assistantMessage.content ||
        assistantMessage.reasoningContent ||
        (assistantMessage.toolCalls && assistantMessage.toolCalls.length > 0)
      ) {
        assistantMessages.push(assistantMessage);
      }
      continue;
    }
    if (role === "tool") {
      const toolMessage: CaptureToolMessage = {
        content,
      };
      if (typeof m.tool_call_id === "string") toolMessage.toolCallId = m.tool_call_id;
      if (toolMessage.content || toolMessage.toolCallId) {
        toolMessages.push(toolMessage);
      }
    }
  }

  for (const tool of toolsRaw) {
    const t = asRecord(tool);
    if (!t) continue;
    const fn = asRecord(t.function);
    const name = typeof fn?.name === "string" ? fn.name : undefined;
    const description = typeof fn?.description === "string" ? fn.description : undefined;
    if (!name) continue;
    tools.push({ name, description });
    if (description) {
      mcpToolDescriptions.push(`${name}: ${description}`);
      if (/(agents\.md|guardrail|mcp|policy)/i.test(description)) {
        hints.add(description);
      }
    }
  }

  return {
    systemMessages,
    userMessages,
    assistantMessages,
    toolMessages,
    requestTimeline,
    responseTimeline,
    tools,
    mcpToolDescriptions,
    agentsMdHints: Array.from(hints),
    rawSections,
    tokenFlow: buildTokenFlowProjection(route, source, responseBody),
  };
}

function buildRequestTimeline(
  source: Record<string, unknown> | null | undefined,
  rawSections: string[]
): CaptureTimelineEntry[] {
  const timeline: CaptureTimelineEntry[] = [];
  if (!source) return timeline;
  const push = createTimelinePusher("request", timeline);

  if (typeof source.instructions === "string") {
    rawSections.push("request.body.instructions");
    push({
      kind: "instructions",
      role: "system",
      sourcePath: "request.body.instructions",
      content: source.instructions,
    });
  }

  if (Array.isArray(source.messages)) {
    rawSections.push("request.body.messages");
    source.messages.forEach((message, idx) => pushMessageEntries(push, message, `request.body.messages[${idx}]`));
  }

  if (Array.isArray(source.input)) {
    rawSections.push("request.body.input");
    source.input.forEach((item, idx) => pushInputOutputEntry(push, item, `request.body.input[${idx}]`, "request"));
  }

  if (Array.isArray(source.tools)) {
    rawSections.push("request.body.tools");
    source.tools.forEach((tool, idx) => {
      const t = asRecord(tool);
      const fn = asRecord(t?.function);
      const name = typeof fn?.name === "string" ? fn.name : undefined;
      const description = typeof fn?.description === "string" ? fn.description : undefined;
      push({
        kind: "tool_definition",
        sourcePath: `request.body.tools[${idx}]`,
        name,
        content: description,
        metadata: t ?? undefined,
      });
    });
  }

  return timeline;
}

function buildResponseTimeline(responseBody: unknown): CaptureTimelineEntry[] {
  const timeline: CaptureTimelineEntry[] = [];
  const push = createTimelinePusher("response", timeline);
  const body = asRecord(responseBody);
  if (!body) {
    if (typeof responseBody === "string" && responseBody) {
      push({ kind: "message", sourcePath: "response.body", content: responseBody });
    }
    return timeline;
  }

  if (asRecord(body.error)) {
    const error = asRecord(body.error)!;
    push({
      kind: "error",
      sourcePath: "response.body.error",
      content: typeof error.message === "string" ? error.message : JSON.stringify(error, null, 2),
      metadata: error,
    });
  }

  if (body.$type === "stream") {
    const text = typeof body.text === "string" ? body.text : undefined;
    if (text) {
      const merged = buildMergedSsePreview(text);
      if (merged) {
        push({
          kind: "stream_preview",
          sourcePath: "response.body.stream",
          content: merged.content,
          metadata: merged.metadata,
        });
      }
    } else {
      push({
        kind: "stream_preview",
        sourcePath: "response.body",
        content: typeof body.note === "string" ? body.note : "Stream response metadata only",
        metadata: body,
      });
    }
    return timeline;
  }

  if (Array.isArray(body.output)) {
    body.output.forEach((item, idx) => pushInputOutputEntry(push, item, `response.body.output[${idx}]`, "response"));
  }

  if (Array.isArray(body.choices)) {
    body.choices.forEach((choice, idx) => {
      const choiceRecord = asRecord(choice);
      const message = asRecord(choiceRecord?.message);
      if (message) {
        pushMessageEntries(push, message, `response.body.choices[${idx}].message`);
      }
    });
  }

  if (timeline.length === 0) {
    push({
      kind: "message",
      sourcePath: "response.body",
      content: JSON.stringify(responseBody, null, 2),
    });
  }
  return timeline;
}

function extractTextContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  const chunks: string[] = [];
  for (const part of content) {
    const p = asRecord(part);
    if (!p) continue;
    if (p.type === "text" && typeof p.text === "string") {
      chunks.push(p.text);
    }
  }
  return chunks.join(" ");
}

function extractToolCalls(value: unknown): CaptureToolCall[] {
  if (!Array.isArray(value)) return [];
  const calls: CaptureToolCall[] = [];
  for (const item of value) {
    const record = asRecord(item);
    if (!record) continue;
    const call: CaptureToolCall = {};
    if (typeof record.id === "string") call.id = record.id;
    if (typeof record.type === "string") call.type = record.type;
    const fn = asRecord(record.function);
    if (fn) {
      call.function = {};
      if (typeof fn.name === "string") call.function.name = fn.name;
      if (typeof fn.arguments === "string") call.function.arguments = fn.arguments;
      if (!call.function.name && !call.function.arguments) delete call.function;
    }
    calls.push(call);
  }
  return calls;
}

function pushMessageEntries(
  push: (entry: Omit<CaptureTimelineEntry, "direction" | "index">) => void,
  message: unknown,
  sourcePath: string
): void {
  const m = asRecord(message);
  if (!m) return;
  const role = normalizeRole(m.role);
  const content = extractTextContent(m.content);
  if (content) {
    push({
      kind: role === "tool" ? "tool_result" : "message",
      role,
      sourcePath,
      content,
      toolCallId: typeof m.tool_call_id === "string" ? m.tool_call_id : undefined,
    });
  }
  if (typeof m.reasoning_content === "string") {
    push({
      kind: "reasoning",
      role: role ?? "assistant",
      sourcePath: `${sourcePath}.reasoning_content`,
      content: m.reasoning_content,
    });
  }
  const toolCalls = extractToolCalls(m.tool_calls);
  toolCalls.forEach((toolCall, idx) =>
    push({
      kind: "tool_call",
      role: "assistant",
      sourcePath: `${sourcePath}.tool_calls[${idx}]`,
      name: toolCall.function?.name,
      arguments: toolCall.function?.arguments,
      toolCallId: toolCall.id,
      metadata: toolCall.type ? { type: toolCall.type } : undefined,
    })
  );
}

function pushInputOutputEntry(
  push: (entry: Omit<CaptureTimelineEntry, "direction" | "index">) => void,
  item: unknown,
  sourcePath: string,
  direction: "request" | "response"
): void {
  const record = asRecord(item);
  if (!record) {
    if (typeof item === "string") {
      push({ kind: "message", sourcePath, content: item });
    }
    return;
  }

  const type = typeof record.type === "string" ? record.type : undefined;
  if (type === "message") {
    const role = normalizeRole(record.role);
    const content = extractTextContentFromResponseItem(record);
    if (content) {
      push({ kind: "message", role, sourcePath, content });
    }
    return;
  }
  if (type === "function_call") {
    push({
      kind: "tool_call",
      role: direction === "response" ? "assistant" : undefined,
      sourcePath,
      name: typeof record.name === "string" ? record.name : undefined,
      arguments: typeof record.arguments === "string" ? record.arguments : undefined,
      toolCallId: typeof record.call_id === "string" ? record.call_id : undefined,
    });
    return;
  }
  if (type === "function_call_output") {
    push({
      kind: "tool_result",
      role: "tool",
      sourcePath,
      content: typeof record.output === "string" ? record.output : stringifyMaybe(record.output),
      toolCallId: typeof record.call_id === "string" ? record.call_id : undefined,
    });
    return;
  }
  if (type === "reasoning") {
    push({
      kind: "reasoning",
      role: "assistant",
      sourcePath,
      content: extractReasoningItemText(record),
    });
    return;
  }

  push({
    kind: "message",
    sourcePath,
    content: stringifyMaybe(record),
    metadata: type ? { type } : undefined,
  });
}

function looksLikeClarification(content: string): boolean {
  const text = content.trim();
  if (!text) return false;
  return /(?:^|\b)(could you|can you|would you|which|what|do you want|please clarify|clarify)\b/i.test(text)
    || text.includes("?");
}

function createTimelinePusher(
  direction: "request" | "response",
  timeline: CaptureTimelineEntry[]
): (entry: Omit<CaptureTimelineEntry, "direction" | "index">) => void {
  return (entry) => {
    timeline.push({
      direction,
      index: timeline.length,
      ...entry,
    });
  };
}

function extractTextContentFromResponseItem(item: Record<string, unknown>): string {
  const content = item.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const chunks: string[] = [];
  for (const part of content) {
    const record = asRecord(part);
    if (!record) continue;
    if (typeof record.text === "string") chunks.push(record.text);
    else if (typeof record.content === "string") chunks.push(record.content);
  }
  return chunks.join("\n\n");
}

function extractReasoningItemText(item: Record<string, unknown>): string {
  if (typeof item.summary === "string") return item.summary;
  if (Array.isArray(item.summary)) {
    return item.summary
      .map((part) => {
        const record = asRecord(part);
        if (!record) return "";
        if (typeof record.text === "string") return record.text;
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (typeof item.content === "string") return item.content;
  return stringifyMaybe(item);
}

function parseSsePreview(text: string): Array<{ content: string; metadata?: Record<string, unknown> }> {
  const entries: Array<{ content: string; metadata?: Record<string, unknown> }> = [];
  const blocks = text.split(/\n\n+/).map((part) => part.trim()).filter(Boolean);
  for (const block of blocks) {
    const dataLines = block
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim());
    if (dataLines.length === 0) continue;
    const joined = dataLines.join("\n");
    try {
      const parsed = JSON.parse(joined) as Record<string, unknown>;
      entries.push({
        content: stringifyMaybe(parsed),
        metadata: parsed,
      });
    } catch {
      entries.push({ content: joined });
    }
  }
  return entries;
}

function buildMergedSsePreview(text: string): { content: string; metadata?: Record<string, unknown> } | null {
  const entries = parseSsePreview(text);
  if (entries.length === 0) return null;

  const textChunks: string[] = [];
  for (const entry of entries) {
    const extracted = extractStreamText(entry.metadata);
    if (extracted) {
      textChunks.push(extracted);
    }
  }

  const mergedText = textChunks.join("");
  if (mergedText.trim()) {
    return {
      content: mergedText,
      metadata: { events: entries.length, mode: "merged_text" },
    };
  }

  return {
    content: entries.map((entry) => entry.content).join("\n\n"),
    metadata: { events: entries.length, mode: "merged_events" },
  };
}

function extractStreamText(value: unknown): string {
  const record = asRecord(value);
  if (!record) return "";

  if (typeof record.delta === "string") {
    return record.delta;
  }
  if (typeof record.text === "string") {
    return record.text;
  }

  const choices = Array.isArray(record.choices) ? record.choices : [];
  const choiceChunks: string[] = [];
  for (const choice of choices) {
    const choiceRecord = asRecord(choice);
    if (!choiceRecord) continue;
    const delta = asRecord(choiceRecord.delta);
    if (typeof delta?.content === "string") choiceChunks.push(delta.content);
    if (typeof delta?.reasoning_content === "string") choiceChunks.push(delta.reasoning_content);
    const message = asRecord(choiceRecord.message);
    if (typeof message?.content === "string") choiceChunks.push(message.content);
  }
  if (choiceChunks.length > 0) {
    return choiceChunks.join("");
  }

  if (typeof record.type === "string") {
    if (
      record.type === "response.output_text.delta" ||
      record.type === "response.reasoning.delta" ||
      record.type === "response.output_text"
    ) {
      if (typeof record.delta === "string") return record.delta;
      if (typeof record.text === "string") return record.text;
    }
  }

  const output = Array.isArray(record.output) ? record.output : [];
  const outputChunks: string[] = [];
  for (const item of output) {
    const itemRecord = asRecord(item);
    if (!itemRecord) continue;
    const content = itemRecord.content;
    if (typeof content === "string") {
      outputChunks.push(content);
      continue;
    }
    if (Array.isArray(content)) {
      for (const part of content) {
        const partRecord = asRecord(part);
        if (!partRecord) continue;
        if (typeof partRecord.text === "string") outputChunks.push(partRecord.text);
      }
    }
  }
  return outputChunks.join("");
}

const INPUT_TOKEN_CATEGORIES: Array<{ key: string; label: string }> = [
  { key: "instructions", label: "Instructions" },
  { key: "system", label: "System" },
  { key: "developer", label: "Developer" },
  { key: "user", label: "User" },
  { key: "assistant_history", label: "Assistant History" },
  { key: "tool_results", label: "Tool Results" },
  { key: "tool_definitions", label: "Tool Definitions" },
  { key: "unattributed_input", label: "Unattributed Input" },
];

const OUTPUT_TOKEN_CATEGORIES: Array<{ key: string; label: string }> = [
  { key: "assistant_text", label: "Assistant Text" },
  { key: "reasoning", label: "Reasoning" },
  { key: "tool_calls", label: "Tool Calls" },
  { key: "tool_results", label: "Tool Results" },
  { key: "errors", label: "Errors" },
  { key: "unattributed_output", label: "Unattributed Output" },
];

function buildTokenFlowProjection(
  route: string,
  source: Record<string, unknown> | null | undefined,
  responseBody: unknown
): CaptureTokenFlow {
  if (!route.startsWith("/v1/chat/completions")) {
    return {
      eligible: false,
      reason: "Token flow is available only for /v1/chat/completions captures.",
      method: "unavailable",
      totals: { inputTokens: null, outputTokens: null, totalTokens: null },
      input: INPUT_TOKEN_CATEGORIES.map((category) => ({ ...category, tokens: 0 })),
      output: OUTPUT_TOKEN_CATEGORIES.map((category) => ({ ...category, tokens: 0 })),
      notes: ["Route is not eligible for token flow analysis."],
    };
  }

  const usage = extractTokenUsageTotals(responseBody);
  const estimatedInput = estimateInputCategoryTokens(source);
  const estimatedOutput = estimateOutputCategoryTokens(responseBody);

  const hasExactSides = usage.inputTokens !== null && usage.outputTokens !== null;
  if (hasExactSides) {
    const inputExact = usage.inputTokens as number;
    const outputExact = usage.outputTokens as number;
    const inputBuckets = scaleCategoryTokens(INPUT_TOKEN_CATEGORIES, estimatedInput, inputExact);
    const outputBuckets = scaleCategoryTokens(OUTPUT_TOKEN_CATEGORIES, estimatedOutput, outputExact);
    const totalTokens = usage.totalTokens ?? inputExact + outputExact;
    return {
      eligible: true,
      method: "exact_totals_estimated_categories",
      totals: {
        inputTokens: inputExact,
        outputTokens: outputExact,
        totalTokens,
      },
      input: inputBuckets,
      output: outputBuckets,
      notes: [
        "Input/output totals are exact from response usage.",
        "Category slices are estimated from captured content structure.",
      ],
    };
  }

  const rawInputTotal = sumTokenMapValues(estimatedInput);
  const rawOutputTotal = sumTokenMapValues(estimatedOutput);
  let estimatedInputTotal = rawInputTotal;
  let estimatedOutputTotal = rawOutputTotal;
  if (usage.totalTokens !== null && usage.totalTokens > 0 && rawInputTotal + rawOutputTotal > 0) {
    const split = splitTotalByWeights(usage.totalTokens, [rawInputTotal, rawOutputTotal]);
    estimatedInputTotal = split[0];
    estimatedOutputTotal = split[1];
  }

  const inputBuckets =
    estimatedInputTotal !== rawInputTotal
      ? scaleCategoryTokens(INPUT_TOKEN_CATEGORIES, estimatedInput, estimatedInputTotal)
      : mapTokensToBuckets(INPUT_TOKEN_CATEGORIES, estimatedInput);
  const outputBuckets =
    estimatedOutputTotal !== rawOutputTotal
      ? scaleCategoryTokens(OUTPUT_TOKEN_CATEGORIES, estimatedOutput, estimatedOutputTotal)
      : mapTokensToBuckets(OUTPUT_TOKEN_CATEGORIES, estimatedOutput);

  return {
    eligible: true,
    method: "estimated_only",
    totals: {
      inputTokens: estimatedInputTotal,
      outputTokens: estimatedOutputTotal,
      totalTokens: usage.totalTokens ?? estimatedInputTotal + estimatedOutputTotal,
    },
    input: inputBuckets,
    output: outputBuckets,
    notes: [
      "Input/output totals are estimated from captured content.",
      "Category slices are estimated from captured content structure.",
    ],
  };
}

function extractTokenUsageTotals(responseBody: unknown): {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
} {
  const body = asRecord(responseBody);
  const usage = asRecord(body?.usage);
  if (!usage) {
    return { inputTokens: null, outputTokens: null, totalTokens: null };
  }

  const promptTokens = toNullableInt(usage.prompt_tokens);
  const completionTokens = toNullableInt(usage.completion_tokens);
  const inputTokens = toNullableInt(usage.input_tokens);
  const outputTokens = toNullableInt(usage.output_tokens);
  const totalTokens = toNullableInt(usage.total_tokens);

  const normalizedInput = promptTokens ?? inputTokens;
  const normalizedOutput = completionTokens ?? outputTokens;
  const normalizedTotal =
    totalTokens ?? (normalizedInput !== null && normalizedOutput !== null ? normalizedInput + normalizedOutput : null);

  return {
    inputTokens: normalizedInput,
    outputTokens: normalizedOutput,
    totalTokens: normalizedTotal,
  };
}

function estimateInputCategoryTokens(source: Record<string, unknown> | null | undefined): Record<string, number> {
  const tokens = initCategoryTokenMap(INPUT_TOKEN_CATEGORIES);
  if (!source) {
    return tokens;
  }

  if (typeof source.instructions === "string") {
    tokens.instructions += roughTokenEstimate(source.instructions);
  }

  if (Array.isArray(source.messages)) {
    for (const message of source.messages) {
      const record = asRecord(message);
      if (!record) continue;
      const role = normalizeRole(record.role);
      const text = extractTextContent(record.content);
      if (role === "system") tokens.system += roughTokenEstimate(text);
      else if (role === "developer") tokens.developer += roughTokenEstimate(text);
      else if (role === "user") tokens.user += roughTokenEstimate(text);
      else if (role === "assistant") tokens.assistant_history += roughTokenEstimate(text);
      else if (role === "tool") tokens.tool_results += roughTokenEstimate(text);
      else tokens.unattributed_input += roughTokenEstimate(text);

      if (role === "assistant" && typeof record.reasoning_content === "string") {
        tokens.assistant_history += roughTokenEstimate(record.reasoning_content);
      }
      const toolCalls = extractToolCalls(record.tool_calls);
      for (const toolCall of toolCalls) {
        tokens.assistant_history += roughTokenEstimate(`${toolCall.function?.name ?? ""} ${toolCall.function?.arguments ?? ""}`.trim());
      }
    }
  }

  if (Array.isArray(source.input)) {
    for (const item of source.input) {
      const record = asRecord(item);
      if (!record) {
        if (typeof item === "string") {
          tokens.user += roughTokenEstimate(item);
        } else {
          tokens.unattributed_input += roughTokenEstimate(stringifyMaybe(item));
        }
        continue;
      }
      const type = typeof record.type === "string" ? record.type : "";
      if (type === "message") {
        const role = normalizeRole(record.role);
        const text = extractTextContent(record.content);
        if (role === "system") tokens.system += roughTokenEstimate(text);
        else if (role === "developer") tokens.developer += roughTokenEstimate(text);
        else if (role === "user") tokens.user += roughTokenEstimate(text);
        else if (role === "assistant") tokens.assistant_history += roughTokenEstimate(text);
        else if (role === "tool") tokens.tool_results += roughTokenEstimate(text);
        else tokens.unattributed_input += roughTokenEstimate(text);
      } else if (type === "function_call_output") {
        tokens.tool_results += roughTokenEstimate(stringifyMaybe(record.output));
      } else if (type === "function_call") {
        tokens.assistant_history += roughTokenEstimate(`${record.name ?? ""} ${record.arguments ?? ""}`.trim());
      } else {
        tokens.unattributed_input += roughTokenEstimate(stringifyMaybe(record));
      }
    }
  }

  if (Array.isArray(source.tools)) {
    for (const tool of source.tools) {
      const record = asRecord(tool);
      if (!record) continue;
      const fn = asRecord(record.function);
      const name = typeof fn?.name === "string" ? fn.name : "";
      const description = typeof fn?.description === "string" ? fn.description : "";
      const parameters = fn?.parameters ? stringifyMaybe(fn.parameters) : "";
      tokens.tool_definitions += roughTokenEstimate(`${name}\n${description}\n${parameters}`.trim());
    }
  }

  return tokens;
}

function estimateOutputCategoryTokens(responseBody: unknown): Record<string, number> {
  const tokens = initCategoryTokenMap(OUTPUT_TOKEN_CATEGORIES);
  const body = asRecord(responseBody);
  if (!body) {
    tokens.unattributed_output += roughTokenEstimate(stringifyMaybe(responseBody));
    return tokens;
  }

  const error = asRecord(body.error);
  if (error) {
    tokens.errors += roughTokenEstimate(
      typeof error.message === "string" ? error.message : stringifyMaybe(error)
    );
  }

  if (body.$type === "stream") {
    if (typeof body.text === "string") {
      tokens.assistant_text += roughTokenEstimate(body.text);
    } else if (typeof body.note === "string") {
      tokens.unattributed_output += roughTokenEstimate(body.note);
    }
    return tokens;
  }

  if (Array.isArray(body.output)) {
    for (const item of body.output) {
      const record = asRecord(item);
      if (!record) continue;
      const type = typeof record.type === "string" ? record.type : "";
      if (type === "message") {
        tokens.assistant_text += roughTokenEstimate(extractTextContentFromResponseItem(record));
      } else if (type === "reasoning") {
        tokens.reasoning += roughTokenEstimate(extractReasoningItemText(record));
      } else if (type === "function_call") {
        tokens.tool_calls += roughTokenEstimate(`${record.name ?? ""} ${record.arguments ?? ""}`.trim());
      } else if (type === "function_call_output") {
        tokens.tool_results += roughTokenEstimate(stringifyMaybe(record.output));
      } else {
        tokens.unattributed_output += roughTokenEstimate(stringifyMaybe(record));
      }
    }
    return tokens;
  }

  if (Array.isArray(body.choices)) {
    for (const choice of body.choices) {
      const choiceRecord = asRecord(choice);
      const message = asRecord(choiceRecord?.message);
      if (!message) continue;
      tokens.assistant_text += roughTokenEstimate(extractTextContent(message.content));
      if (typeof message.reasoning_content === "string") {
        tokens.reasoning += roughTokenEstimate(message.reasoning_content);
      }
      const toolCalls = extractToolCalls(message.tool_calls);
      for (const toolCall of toolCalls) {
        tokens.tool_calls += roughTokenEstimate(`${toolCall.function?.name ?? ""} ${toolCall.function?.arguments ?? ""}`.trim());
      }
    }
    return tokens;
  }

  tokens.unattributed_output += roughTokenEstimate(stringifyMaybe(body));
  return tokens;
}

function initCategoryTokenMap(categories: Array<{ key: string }>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const category of categories) {
    out[category.key] = 0;
  }
  return out;
}

function mapTokensToBuckets(
  categories: Array<{ key: string; label: string }>,
  values: Record<string, number>
): CaptureTokenFlowBucket[] {
  return categories.map((category) => ({
    key: category.key,
    label: category.label,
    tokens: Math.max(0, Math.round(values[category.key] ?? 0)),
  }));
}

function scaleCategoryTokens(
  categories: Array<{ key: string; label: string }>,
  values: Record<string, number>,
  targetTotal: number
): CaptureTokenFlowBucket[] {
  const sanitizedTarget = Math.max(0, Math.round(targetTotal));
  if (sanitizedTarget === 0) {
    return categories.map((category) => ({ key: category.key, label: category.label, tokens: 0 }));
  }
  const weights = categories.map((category) => Math.max(0, values[category.key] ?? 0));
  const scaled = splitTotalByWeights(sanitizedTarget, weights);
  return categories.map((category, idx) => ({
    key: category.key,
    label: category.label,
    tokens: scaled[idx] ?? 0,
  }));
}

function splitTotalByWeights(total: number, weights: number[]): number[] {
  const sanitizedTotal = Math.max(0, Math.round(total));
  const normalizedWeights = weights.map((value) => Math.max(0, value));
  const sum = normalizedWeights.reduce((acc, value) => acc + value, 0);
  if (sanitizedTotal === 0) return normalizedWeights.map(() => 0);
  if (sum <= 0) {
    const equal = Math.floor(sanitizedTotal / normalizedWeights.length);
    let remainder = sanitizedTotal - equal * normalizedWeights.length;
    return normalizedWeights.map((_value, idx) => equal + (remainder-- > 0 ? 1 : 0));
  }

  const rawShares = normalizedWeights.map((value) => (value / sum) * sanitizedTotal);
  const floors = rawShares.map((value) => Math.floor(value));
  let remainder = sanitizedTotal - floors.reduce((acc, value) => acc + value, 0);
  const order = rawShares
    .map((value, idx) => ({ idx, frac: value - floors[idx] }))
    .sort((a, b) => b.frac - a.frac);
  for (let i = 0; i < order.length && remainder > 0; i += 1) {
    floors[order[i].idx] += 1;
    remainder -= 1;
  }
  return floors;
}

function sumTokenMapValues(values: Record<string, number>): number {
  return Object.values(values).reduce((acc, value) => acc + Math.max(0, Math.round(value)), 0);
}

function toNullableInt(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.max(0, Math.round(value));
}

function roughTokenEstimate(value: string): number {
  if (!value) return 0;
  return Math.ceil(Buffer.byteLength(value, "utf8") / 4);
}

function normalizeRole(value: unknown): CaptureTimelineEntry["role"] | undefined {
  if (
    value === "system" ||
    value === "user" ||
    value === "assistant" ||
    value === "tool" ||
    value === "developer"
  ) {
    return value;
  }
  return undefined;
}

function stringifyMaybe(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function utcDateString(timestamp: string): string {
  return timestamp.slice(0, 10);
}

function hydrateCaptureRecord(record: CaptureRecord): CaptureRecord {
  const analysis = buildAnalysisProjection(record.route, record.request.body, record.response.body, record.request.derived);
  return {
    ...record,
    analysis: {
      ...record.analysis,
      ...analysis,
      tools: record.analysis?.tools?.length ? record.analysis.tools : analysis.tools,
      mcpToolDescriptions: record.analysis?.mcpToolDescriptions?.length
        ? record.analysis.mcpToolDescriptions
        : analysis.mcpToolDescriptions,
      agentsMdHints: record.analysis?.agentsMdHints?.length ? record.analysis.agentsMdHints : analysis.agentsMdHints,
      rawSections: record.analysis?.rawSections?.length ? record.analysis.rawSections : analysis.rawSections,
    },
  };
}

async function buildPreviewBody(
  paths: StoragePaths,
  value: unknown,
  artifacts: CaptureArtifact[]
): Promise<unknown> {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    return previewString(value);
  }
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const item of value) {
      out.push(await buildPreviewBody(paths, item, artifacts));
    }
    return out;
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (typeof v === "string") {
        const dataMatch = v.match(DATA_URL_RE);
        if (dataMatch) {
          out[key] = await storeDataUrlArtifact(paths, v, artifacts);
          continue;
        }
      }
      out[key] = await buildPreviewBody(paths, v, artifacts);
    }
    return out;
  }
  return value;
}

function previewString(input: string): unknown {
  if (input.length <= 4000) return input;
  return {
    $type: "long_text",
    length: input.length,
    preview: `${input.slice(0, 320)}…`,
  };
}

async function storeDataUrlArtifact(
  paths: StoragePaths,
  value: string,
  artifacts: CaptureArtifact[]
): Promise<unknown> {
  const match = value.match(DATA_URL_RE);
  if (!match) return previewString(value);
  const mime = match[1].toLowerCase();
  let buffer: Buffer;
  try {
    buffer = Buffer.from(match[2], "base64");
  } catch {
    return {
      $type: "data_url",
      mime,
      error: "invalid_base64",
    };
  }
  const hash = createHash("sha256").update(buffer).digest("hex");
  const ext = mimeToExt(mime);
  const blobFile = `${hash}.${ext}`;
  const blobPath = path.join(captureBlobsDir(paths), blobFile);
  try {
    await fs.access(blobPath);
  } catch {
    await fs.writeFile(blobPath, buffer);
  }
  const artifact: CaptureArtifact = {
    hash,
    mime,
    bytes: buffer.byteLength,
    blobRef: `/admin/capture/blobs/${hash}`,
    kind: mime.startsWith("image/")
      ? "image"
      : mime.startsWith("audio/")
        ? "audio"
        : "binary",
  };
  if (!artifacts.some((item) => item.hash === hash)) {
    artifacts.push(artifact);
  }
  return {
    $type: "data_url_ref",
    mime,
    bytes: buffer.byteLength,
    blobRef: artifact.blobRef,
  };
}

function mimeToExt(mime: string): string {
  if (mime === "image/png") return "png";
  if (mime === "image/jpeg") return "jpg";
  if (mime === "image/webp") return "webp";
  if (mime === "image/gif") return "gif";
  if (mime === "audio/mpeg") return "mp3";
  if (mime === "audio/wav") return "wav";
  if (mime === "audio/ogg") return "ogg";
  if (mime === "audio/webm") return "webm";
  return "bin";
}

function extToMime(ext: string): string {
  if (ext === "png") return "image/png";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "webp") return "image/webp";
  if (ext === "gif") return "image/gif";
  if (ext === "mp3") return "audio/mpeg";
  if (ext === "wav") return "audio/wav";
  if (ext === "ogg") return "audio/ogg";
  if (ext === "webm") return "audio/webm";
  return "application/octet-stream";
}

async function readCaptureIndex(
  paths: StoragePaths,
  options?: { pruneMissing?: boolean }
): Promise<CaptureIndexEntry[]> {
  try {
    const raw = await fs.readFile(captureIndexPath(paths), "utf8");
    const entries = raw
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as CaptureIndexEntry)
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    if (!options?.pruneMissing) {
      return entries;
    }

    const existing: CaptureIndexEntry[] = [];
    let removed = false;
    for (const entry of entries) {
      try {
        await fs.access(path.join(captureDir(paths), entry.file));
        existing.push(entry);
      } catch {
        removed = true;
      }
    }
    if (removed) {
      const content = existing.map((entry) => JSON.stringify(entry)).join("\n");
      await fs.writeFile(captureIndexPath(paths), content ? `${content}\n` : "", "utf8");
    }
    return existing;
  } catch {
    return [];
  }
}

async function applyCaptureRetention(paths: StoragePaths, config: CaptureConfig): Promise<void> {
  const cutoff = Date.now() - config.retentionDays * 24 * 60 * 60 * 1000;
  let entries = await readCaptureIndex(paths);
  if (entries.length === 0) return;

  entries = entries.filter((entry) => {
    const ts = new Date(entry.timestamp).getTime();
    if (!Number.isFinite(ts) || ts < cutoff) {
      return false;
    }
    return true;
  });

  let total = await dirSize(captureDir(paths));
  if (total > config.maxBytes) {
    const sorted = [...entries].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    while (total > config.maxBytes && sorted.length > 0) {
      const oldest = sorted.shift();
      if (!oldest) break;
      const recPath = path.join(captureDir(paths), oldest.file);
      try {
        await fs.unlink(recPath);
      } catch {
        // noop
      }
      entries = entries.filter((entry) => entry.id !== oldest.id);
      total = await dirSize(captureDir(paths));
    }
  } else {
    const existingIds = new Set(entries.map((entry) => entry.id));
    const allEntries = await readCaptureIndex(paths);
    for (const item of allEntries) {
      if (existingIds.has(item.id)) continue;
      try {
        await fs.unlink(path.join(captureDir(paths), item.file));
      } catch {
        // noop
      }
    }
  }

  await cleanupOrphanBlobs(paths, entries);
  const content = entries.map((entry) => JSON.stringify(entry)).join("\n");
  await fs.writeFile(captureIndexPath(paths), content ? `${content}\n` : "", "utf8");
}

async function cleanupOrphanBlobs(paths: StoragePaths, entries: CaptureIndexEntry[]): Promise<void> {
  const referenced = new Set<string>();
  for (const entry of entries) {
    try {
      const raw = await fs.readFile(path.join(captureDir(paths), entry.file), "utf8");
      const record = JSON.parse(raw) as CaptureRecord;
      for (const artifact of record.artifacts ?? []) {
        referenced.add(artifact.hash);
      }
    } catch {
      // noop
    }
  }
  let files: string[];
  try {
    files = await fs.readdir(captureBlobsDir(paths));
  } catch {
    return;
  }
  for (const file of files) {
    const hash = file.split(".")[0];
    if (!referenced.has(hash)) {
      try {
        await fs.unlink(path.join(captureBlobsDir(paths), file));
      } catch {
        // noop
      }
    }
  }
}

async function dirSize(root: string): Promise<number> {
  let total = 0;
  async function walk(dir: string): Promise<void> {
    let entries: Array<import("fs").Dirent>;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        try {
          const stat = await fs.stat(full);
          total += stat.size;
        } catch {
          // noop
        }
      }
    }
  }
  await walk(root);
  return total;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null;
  return value as Record<string, unknown>;
}
