import { promises as fs } from "fs";
import path from "path";
import sharp from "sharp";
import { routeRequest } from "../routing/router";
import { selectPoolCandidates } from "../pools/scheduler";
import { pickBestProviderModelByCapabilities } from "../providers/modelRegistry";
import { StoragePaths } from "../storage/files";

const DEFAULT_INSTRUCTION =
  "Analyze this image. Return OCR text, key objects, scene summary, and notable details.";
const MAX_IMAGE_PIXELS = 1080 * 720 - 1;
const RESIZE_QUALITY = 85;

export interface ImageUnderstandingRequest {
  image_path?: string;
  image_url?: string;
  instruction?: string;
  model?: string;
  max_tokens?: number;
  temperature?: number;
}

export interface ImageAnalysis {
  answer: string;
  ocr_text: string;
  objects: string[];
  scene: string;
  notable_details: string[];
  safety_notes: string[];
}

export interface ImageGeometry {
  original_width: number;
  original_height: number;
  uploaded_width: number;
  uploaded_height: number;
  scale_x: number;
  scale_y: number;
  resized: boolean;
}

export interface ImageUnderstandingResult {
  model: string;
  analysis: ImageAnalysis;
  raw_text: string;
  image_geometry?: ImageGeometry;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

interface ResolvedImageInput {
  imageUrl: string;
  imageGeometry?: ImageGeometry;
}

export async function runImageUnderstanding(
  paths: StoragePaths,
  input: ImageUnderstandingRequest,
  signal: AbortSignal
): Promise<ImageUnderstandingResult> {
  const model = await resolveVisionTextModel(paths, input.model);
  if (!model) {
    throw typedError("no_vision_model", "No vision-capable text model available.");
  }

  const resolvedImage = await resolveImageInput(input);
  const instruction = input.instruction?.trim() ? input.instruction : DEFAULT_INSTRUCTION;
  const messages: Array<Record<string, unknown>> = [];
  if (resolvedImage.imageGeometry) {
    messages.push({
      role: "system",
      content: buildImageGeometrySystemMessage(resolvedImage.imageGeometry),
    });
  }
  messages.push({
    role: "user",
    content: [
      { type: "image_url", image_url: { url: resolvedImage.imageUrl } },
      { type: "text", text: instruction },
    ],
  });

  const payload: Record<string, unknown> = {
    model,
    stream: false,
    messages,
  };
  if (typeof input.max_tokens === "number") {
    payload.max_tokens = input.max_tokens;
  }
  if (typeof input.temperature === "number") {
    payload.temperature = input.temperature;
  }

  const outcome = await routeRequest(
    paths,
    model,
    "/v1/chat/completions",
    payload,
    {},
    signal,
    {
      requiredInput: ["text", "image"],
      requiredOutput: ["text"],
    }
  );
  const responsePayload = await readBody(outcome.attempt.response);
  const rawText = extractAssistantText(responsePayload.payload);
  const analysis = parseImageUnderstandingText(rawText);
  return {
    model,
    analysis,
    raw_text: rawText,
    image_geometry: resolvedImage.imageGeometry,
    usage: {
      prompt_tokens: responsePayload.usage?.prompt_tokens ?? 0,
      completion_tokens: responsePayload.usage?.completion_tokens ?? 0,
      total_tokens: responsePayload.usage?.total_tokens ?? 0,
    },
  };
}

export async function resolveImageInputToUrl(input: ImageUnderstandingRequest): Promise<string> {
  const resolved = await resolveImageInput(input);
  return resolved.imageUrl;
}

export async function resolveImageInput(input: ImageUnderstandingRequest): Promise<ResolvedImageInput> {
  if (input.image_path) {
    return imageDataUrlWithGeometryFromPath(input.image_path);
  }
  if (input.image_url && isValidImageUrl(input.image_url)) {
    return { imageUrl: input.image_url };
  }
  throw typedError(
    "invalid_request",
    "Exactly one image source is required: image_path or image_url."
  );
}

export async function imageDataUrlFromPath(imagePath: string): Promise<string> {
  const resolved = await imageDataUrlWithGeometryFromPath(imagePath);
  return resolved.imageUrl;
}

export async function imageDataUrlWithGeometryFromPath(
  imagePath: string
): Promise<ResolvedImageInput> {
  const abs = path.resolve(imagePath);
  let data: Buffer;
  try {
    data = await fs.readFile(abs);
  } catch {
    throw typedError("invalid_request", `image_path not readable: ${imagePath}`);
  }
  let mimeType = mimeFromExt(abs);

  const image = sharp(data);
  const meta = await image.metadata();
  if (!meta.width || !meta.height) {
    throw typedError("invalid_request", "Unable to read image dimensions.");
  }

  const originalWidth = meta.width;
  const originalHeight = meta.height;
  let uploadedWidth = originalWidth;
  let uploadedHeight = originalHeight;

  const area = meta.width * meta.height;
  if (area > MAX_IMAGE_PIXELS) {
    const scale = Math.sqrt(MAX_IMAGE_PIXELS / area);
    const targetWidth = Math.max(1, Math.floor(meta.width * scale));
    const targetHeight = Math.max(1, Math.floor(meta.height * scale));
    uploadedWidth = targetWidth;
    uploadedHeight = targetHeight;
    let resized = image.resize(targetWidth, targetHeight, { fit: "fill" });
    const format = (meta.format ?? "").toLowerCase();
    if (format === "jpeg" || format === "jpg") {
      resized = resized.jpeg({ quality: RESIZE_QUALITY });
      mimeType = "image/jpeg";
    } else if (format === "png") {
      resized = resized.png();
      mimeType = "image/png";
    } else if (format === "webp") {
      resized = resized.webp({ quality: RESIZE_QUALITY });
      mimeType = "image/webp";
    } else {
      resized = resized.png();
      mimeType = "image/png";
    }
    data = await resized.toBuffer();
  }

  return {
    imageUrl: `data:${mimeType};base64,${data.toString("base64")}`,
    imageGeometry: {
      original_width: originalWidth,
      original_height: originalHeight,
      uploaded_width: uploadedWidth,
      uploaded_height: uploadedHeight,
      scale_x: originalWidth / uploadedWidth,
      scale_y: originalHeight / uploadedHeight,
      resized: originalWidth !== uploadedWidth || originalHeight !== uploadedHeight,
    },
  };
}

export function buildImageGeometrySystemMessage(imageGeometry: ImageGeometry): string {
  return [
    "If you return coordinates or bounding boxes, express them in the original image pixel space.",
    `Original image size: ${imageGeometry.original_width}x${imageGeometry.original_height}.`,
    `Uploaded image size: ${imageGeometry.uploaded_width}x${imageGeometry.uploaded_height}.`,
    `Scale factors from uploaded to original: x=${imageGeometry.scale_x}, y=${imageGeometry.scale_y}.`,
    "Do not return coordinates in resized-image pixels.",
  ].join(" ");
}

export function parseImageUnderstandingText(rawText: string): ImageAnalysis {
  const trimmed = rawText.trim();
  const parsedJson = parseEmbeddedJson(trimmed);
  if (parsedJson) {
    return fromJsonAnalysis(parsedJson, trimmed);
  }

  const answer = trimmed || "No textual response returned.";
  const lines = answer.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return {
    answer,
    ocr_text: extractKeyValue(lines, "ocr_text") ?? extractKeyValue(lines, "ocr") ?? "",
    objects: splitList(extractKeyValue(lines, "objects") ?? ""),
    scene: extractKeyValue(lines, "scene") ?? "",
    notable_details: splitList(extractKeyValue(lines, "notable_details") ?? extractKeyValue(lines, "notable details") ?? ""),
    safety_notes: splitList(extractKeyValue(lines, "safety_notes") ?? extractKeyValue(lines, "safety notes") ?? ""),
  };
}

async function resolveVisionTextModel(paths: StoragePaths, requestedModel?: string): Promise<string | null> {
  if (requestedModel) {
    return requestedModel;
  }

  const smart = await selectPoolCandidates(
    paths,
    "smart",
    {
      requiredInput: ["text", "image"],
      requiredOutput: ["text"],
    },
    {
      operation: "chat_completions",
      stream: false,
    }
  );
  if (smart && smart.candidates.length > 0) {
    return "smart";
  }

  return pickBestProviderModelByCapabilities(
    paths,
    { requiredInput: ["text", "image"], requiredOutput: ["text"] },
    "llm"
  );
}

async function readBody(response: {
  statusCode?: number;
  body: NodeJS.ReadableStream;
  headers: Record<string, string | string[]>;
}): Promise<{
  payload: unknown;
  usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null;
}> {
  const chunks: Buffer[] = [];
  for await (const chunk of response.body) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const buffer = Buffer.concat(chunks);
  const contentType = normalizeContentType(response.headers);
  const rawText = buffer.toString("utf8");
  let payload: {
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  };
  try {
    payload = JSON.parse(rawText);
  } catch {
    const status = typeof response.statusCode === "number" ? response.statusCode : 0;
    const snippet = summarizeBodySnippet(rawText);
    throw typedError(
      "upstream_error",
      `Expected JSON from chat completion. status=${status} content-type=${contentType || "unknown"} body=${snippet}`
    );
  }
  return { payload, usage: payload.usage ?? null };
}

function extractAssistantText(payload: unknown): string {
  if (!payload || typeof payload !== "object") {
    return "";
  }
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    return "";
  }
  const first = choices[0] as { message?: { content?: unknown } };
  const content = first?.message?.content;
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    const texts = content
      .map((part) => {
        if (!part || typeof part !== "object") return "";
        const type = (part as { type?: unknown }).type;
        if (type !== "text") return "";
        return (part as { text?: string }).text ?? "";
      })
      .filter(Boolean);
    return texts.join("\n").trim();
  }
  return "";
}

function parseEmbeddedJson(text: string): Record<string, unknown> | null {
  const fencedMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const candidate = fencedMatch ? fencedMatch[1] : text;
  try {
    const parsed = JSON.parse(candidate);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function fromJsonAnalysis(json: Record<string, unknown>, fallbackRaw: string): ImageAnalysis {
  const analysis = (json.analysis && typeof json.analysis === "object"
    ? (json.analysis as Record<string, unknown>)
    : json) as Record<string, unknown>;

  const answer =
    asString(analysis.answer) ??
    asString(json.answer) ??
    asString(json.raw_text) ??
    asString(fallbackRaw) ??
    "No textual response returned.";
  return {
    answer,
    ocr_text: asString(analysis.ocr_text) ?? "",
    objects: asStringArray(analysis.objects),
    scene: asString(analysis.scene) ?? "",
    notable_details: asStringArray(analysis.notable_details),
    safety_notes: asStringArray(analysis.safety_notes),
  };
}

function asString(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  return null;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter(Boolean);
}

function splitList(value: string): string[] {
  if (!value) return [];
  return value
    .split(/[,\n]/)
    .map((item) => item.replace(/^[-*]\s*/, "").trim())
    .filter(Boolean);
}

function extractKeyValue(lines: string[], key: string): string | null {
  const pattern = new RegExp(`^${escapeRegExp(key)}\\s*:\\s*(.+)$`, "i");
  for (const line of lines) {
    const match = line.match(pattern);
    if (match) {
      return match[1].trim();
    }
  }
  return null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isValidImageUrl(url: string): boolean {
  if (url.startsWith("data:")) {
    return /^data:[^;]+;base64,/i.test(url);
  }
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function normalizeContentType(headers: Record<string, string | string[]>): string {
  const ct = headers["content-type"] ?? headers["Content-Type"];
  if (Array.isArray(ct)) return ct.join(", ");
  return ct ?? "";
}

function summarizeBodySnippet(body: string): string {
  const trimmed = body.replace(/\s+/g, " ").trim();
  if (!trimmed) {
    return "<empty>";
  }
  const max = 1024;
  if (trimmed.length <= max) {
    return trimmed;
  }
  return `${trimmed.slice(0, max)}…`;
}

function mimeFromExt(filePath: string): string {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  const map: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    bmp: "image/bmp",
    svg: "image/svg+xml",
    tif: "image/tiff",
    tiff: "image/tiff",
  };
  return map[ext] ?? "application/octet-stream";
}

function typedError(type: string, message: string): Error & { type: string; retryable: boolean } {
  const error = new Error(message) as Error & { type: string; retryable: boolean };
  error.type = type;
  error.retryable = false;
  return error;
}
