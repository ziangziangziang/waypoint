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
  systemMessages: string[];
  userMessages: string[];
  assistantMessages: string[];
  tools: Array<{ name: string; description?: string }>;
  mcpToolDescriptions: string[];
  agentsMdHints: string[];
  rawSections: string[];
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
    analysis: buildAnalysisProjection(input.requestBody, input.derivedRequest),
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
  limit = 5
): Promise<CaptureIndexEntry[]> {
  await ensureCaptureStore(paths);
  const entries = await readCaptureIndex(paths);
  return entries.slice(-Math.max(1, limit)).reverse();
}

export async function getCaptureRecordById(
  paths: StoragePaths,
  id: string
): Promise<CaptureRecord | null> {
  const entries = await readCaptureIndex(paths);
  const match = entries.find((entry) => entry.id === id);
  if (!match) {
    return null;
  }
  const absolute = path.join(captureDir(paths), match.file);
  try {
    const raw = await fs.readFile(absolute, "utf8");
    return JSON.parse(raw) as CaptureRecord;
  } catch {
    return null;
  }
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
  requestBody: unknown,
  derived?: Record<string, unknown>
): CaptureAnalysisProjection {
  const source = (derived?.normalizedRequest as Record<string, unknown> | undefined) ?? asRecord(requestBody);
  const messages = Array.isArray(source?.messages) ? source.messages : [];
  const toolsRaw = Array.isArray(source?.tools) ? source.tools : [];
  const systemMessages: string[] = [];
  const userMessages: string[] = [];
  const assistantMessages: string[] = [];
  const tools: Array<{ name: string; description?: string }> = [];
  const mcpToolDescriptions: string[] = [];
  const hints = new Set<string>();
  const rawSections: string[] = [];

  if (source?.messages) rawSections.push("request.body.messages");
  if (source?.tools) rawSections.push("request.body.tools");
  if (source?.input) rawSections.push("request.body.input");
  if (source?.instructions) rawSections.push("request.body.instructions");

  for (const message of messages) {
    const m = asRecord(message);
    if (!m) continue;
    const role = typeof m.role === "string" ? m.role : "unknown";
    const text = extractTextSummary(m.content);
    if (!text) continue;
    if (role === "system") systemMessages.push(text);
    if (role === "user") userMessages.push(text);
    if (role === "assistant") assistantMessages.push(text);
    if (/(agents\.md|guardrail|mcp|tool|policy)/i.test(text)) {
      hints.add(text.slice(0, 240));
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
        hints.add(description.slice(0, 240));
      }
    }
  }

  return {
    systemMessages,
    userMessages,
    assistantMessages,
    tools,
    mcpToolDescriptions,
    agentsMdHints: Array.from(hints),
    rawSections,
  };
}

function extractTextSummary(content: unknown): string {
  if (typeof content === "string") {
    return content.slice(0, 1200);
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
  return chunks.join(" ").slice(0, 1200);
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

async function readCaptureIndex(paths: StoragePaths): Promise<CaptureIndexEntry[]> {
  try {
    const raw = await fs.readFile(captureIndexPath(paths), "utf8");
    return raw
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as CaptureIndexEntry)
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
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
