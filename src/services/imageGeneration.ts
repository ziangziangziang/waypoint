import { routeRequest } from "../routing/router";
import { selectPoolCandidates } from "../pools/scheduler";
import { pickBestProviderModelByCapabilities } from "../providers/modelRegistry";
import { getMediaEntry, getMediaPath } from "../storage/imageCache";
import { StoragePaths } from "../storage/files";
import { ImageGenerationRequest } from "../types";
import { promises as fs } from "fs";
import path from "path";

export interface ImageGenerationRunResult {
  model: string;
  statusCode: number;
  headers: Record<string, string | string[]>;
  payload: unknown;
  route: {
    endpointId: string;
    endpointName: string;
    upstreamModel: string;
  };
}

export interface NormalizedGeneratedImage {
  index: number;
  url?: string;
  b64_json?: string;
  revised_prompt?: string;
}

export interface NormalizedImageGenerationResult {
  model: string;
  created: number;
  images: NormalizedGeneratedImage[];
}

export async function resolveGenerationModel(
  paths: StoragePaths,
  requestedModel?: string
): Promise<string | null> {
  if (requestedModel) {
    return requestedModel;
  }
  // Keep compatibility with existing /v1/images/generations fallback behavior.
  return pickDefaultDiffusionModel(paths);
}

export async function runImageGeneration(
  paths: StoragePaths,
  request: ImageGenerationRequest,
  headers: Record<string, string | string[] | undefined>,
  signal: AbortSignal
): Promise<ImageGenerationRunResult> {
  const model = request.model
    ? request.model
    : request.image_url
      ? await pickDefaultImageEditModel(paths)
      : await resolveGenerationModel(paths, request.model);
  if (!model) {
    const error = new Error("No diffusion model available. Add or enable a provider model.") as Error & {
      type: string;
      retryable: boolean;
    };
    error.type = "no_diffusion_model";
    error.retryable = false;
    throw error;
  }

  let body: { payload: unknown };
  let outcome: Awaited<ReturnType<typeof routeRequest>>;
  if (request.image_url) {
    const chatPayload = {
      model,
      stream: false,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: request.prompt },
            { type: "image_url", image_url: { url: request.image_url } },
          ],
        },
      ],
    } as Record<string, unknown>;
    try {
      outcome = await routeRequest(
        paths,
        model,
        "/v1/chat/completions",
        chatPayload,
        headers,
        signal,
        {
          requiredInput: ["text", "image"],
          requiredOutput: ["image"],
        }
      );
    } catch (error) {
      const typed = error as Error & { type?: string };
      if (typed.type !== "no_endpoints") {
        throw error;
      }
      outcome = await routeRequest(
        paths,
        model,
        "/v1/chat/completions",
        chatPayload,
        headers,
        signal,
        {
          requiredInput: ["text"],
          requiredOutput: ["image"],
        }
      );
    }
    body = await readBody(outcome.attempt.response);
    body.payload = normalizeChatImagePayload(body.payload);
  } else {
    outcome = await routeRequest(
      paths,
      model,
      "/v1/images/generations",
      { ...request, model } as Record<string, unknown>,
      headers,
      signal,
      {
        endpointType: "diffusion",
        requiredInput: ["text"],
        requiredOutput: ["image"],
      }
    );
    body = await readBody(outcome.attempt.response);
  }

  return {
    model,
    statusCode: outcome.attempt.response.statusCode,
    headers: outcome.attempt.response.headers,
    payload: body.payload,
    route: {
      endpointId: outcome.attempt.endpoint.id,
      endpointName: outcome.attempt.endpoint.name,
      upstreamModel: outcome.attempt.upstreamModel,
    },
  };
}

export async function normalizeImageGenerationPayload(
  paths: StoragePaths,
  payload: unknown,
  model: string
): Promise<NormalizedImageGenerationResult> {
  const asObject = (payload ?? {}) as { created?: unknown; data?: unknown };
  const created = typeof asObject.created === "number" ? asObject.created : Math.floor(Date.now() / 1000);
  const data = Array.isArray(asObject.data) ? asObject.data : [];
  const images: NormalizedGeneratedImage[] = [];

  for (let index = 0; index < data.length; index += 1) {
    const item = (data[index] ?? {}) as {
      url?: unknown;
      b64_json?: unknown;
      revised_prompt?: unknown;
    };
    const entry: NormalizedGeneratedImage = { index };
    if (typeof item.revised_prompt === "string" && item.revised_prompt.length > 0) {
      entry.revised_prompt = item.revised_prompt;
    }

    if (typeof item.b64_json === "string" && item.b64_json.length > 0) {
      entry.b64_json = item.b64_json;
    }
    if (typeof item.url === "string" && item.url.length > 0) {
      entry.url = item.url;
    }

    if (!entry.b64_json && entry.url) {
      const extracted = await tryExtractBase64FromUrl(paths, entry.url);
      if (extracted) {
        entry.b64_json = extracted.b64;
        if (!entry.url.startsWith("data:")) {
          entry.url = `data:${extracted.mimeType};base64,${extracted.b64}`;
        }
      }
    }

    if (!entry.url && entry.b64_json) {
      entry.url = `data:image/png;base64,${entry.b64_json}`;
    }

    images.push(entry);
  }

  return { model, created, images };
}

export function normalizeChatImagePayload(payload: unknown): unknown {
  const root = payload as {
    created?: unknown;
    choices?: unknown;
  };
  const created =
    typeof root?.created === "number" ? root.created : Math.floor(Date.now() / 1000);
  const choices = Array.isArray(root?.choices) ? root.choices : [];
  const firstChoice = (choices[0] ?? null) as
    | {
        message?: { content?: unknown };
      }
    | null;
  const content = firstChoice?.message?.content;

  const data: Array<{ url?: string; b64_json?: string; revised_prompt?: string }> = [];
  let revisedPrompt: string | undefined;

  if (Array.isArray(content)) {
    for (const item of content) {
      if (!item || typeof item !== "object") {
        continue;
      }
      const typed = item as Record<string, unknown>;
      const type = typeof typed.type === "string" ? typed.type : "";
      if (!revisedPrompt && type === "text" && typeof typed.text === "string") {
        revisedPrompt = typed.text.trim() || undefined;
      }
      if (type === "image_url") {
        const imageUrlObject = typed.image_url as { url?: unknown } | undefined;
        if (typeof imageUrlObject?.url === "string" && imageUrlObject.url.length > 0) {
          data.push({ url: imageUrlObject.url });
        }
      } else if (type === "image" && typeof typed.image === "string" && typed.image.length > 0) {
        data.push({ url: typed.image });
      }
    }
  }

  if (typeof content === "string" && content.startsWith("data:image/")) {
    data.push({ url: content });
  }

  if (data.length === 0) {
    const error = new Error("Upstream chat completion did not return any image output.") as Error & {
      type: string;
      retryable: boolean;
    };
    error.type = "invalid_upstream_response";
    error.retryable = true;
    throw error;
  }
  if (revisedPrompt) {
    data[0].revised_prompt = revisedPrompt;
  }

  return { created, data };
}

async function pickDefaultDiffusionModel(paths: StoragePaths): Promise<string | null> {
  const smart = await selectPoolCandidates(
    paths,
    "smart",
    {
      requiredInput: ["text"],
      requiredOutput: ["image"],
    },
    {
      operation: "images_generation",
      stream: false,
    }
  );
  if (smart && smart.candidates.length > 0) {
    return "smart";
  }

  const byCapabilities = await pickBestProviderModelByCapabilities(
    paths,
    { requiredInput: ["text"], requiredOutput: ["image"] },
    "diffusion"
  );
  if (byCapabilities) {
    return byCapabilities;
  }
  return null;
}

async function pickDefaultImageEditModel(paths: StoragePaths): Promise<string | null> {
  const smart = await selectPoolCandidates(
    paths,
    "smart",
    {
      requiredInput: ["image", "text"],
      requiredOutput: ["image"],
    },
    {
      operation: "images_edits",
      stream: false,
    }
  );
  if (smart && smart.candidates.length > 0) {
    return "smart";
  }

  const byCapabilities = await pickBestProviderModelByCapabilities(
    paths,
    { requiredInput: ["image"], requiredOutput: ["image"] },
    "diffusion"
  );
  if (byCapabilities) {
    return byCapabilities;
  }
  return pickDefaultDiffusionModel(paths);
}

async function readBody(response: {
  body: NodeJS.ReadableStream;
  headers: Record<string, string | string[]>;
}): Promise<{ payload: unknown }> {
  const chunks: Buffer[] = [];
  for await (const chunk of response.body) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const buffer = Buffer.concat(chunks);
  const contentType = normalizeContentType(response.headers);
  if (contentType.includes("application/json")) {
    try {
      return { payload: JSON.parse(buffer.toString("utf8")) };
    } catch {
      return { payload: buffer };
    }
  }
  return { payload: buffer };
}

function normalizeContentType(headers: Record<string, string | string[]>): string {
  const ct = headers["content-type"] ?? headers["Content-Type"];
  if (Array.isArray(ct)) return ct.join(", ");
  return ct ?? "";
}

async function tryExtractBase64FromUrl(
  paths: StoragePaths,
  url: string
): Promise<{ b64: string; mimeType: string } | null> {
  if (url.startsWith("data:")) {
    const match = url.match(/^data:([^;]+);base64,(.+)$/i);
    if (!match) return null;
    return { mimeType: match[1], b64: match[2].replace(/\s+/g, "") };
  }

  const hash = extractLocalHash(url);
  if (!hash) return null;

  const mediaPath = await getMediaPath(paths, hash);
  const mediaEntry = await getMediaEntry(paths, hash);
  if (!mediaPath) return null;
  const buffer = await fs.readFile(mediaPath);
  const mimeType = mediaEntry?.mimeType ?? mimeFromExt(mediaPath);
  return { mimeType, b64: buffer.toString("base64") };
}

function extractLocalHash(url: string): string | null {
  const normalized = normalizeLocalUrl(url);
  if (!normalized) {
    return null;
  }
  const mediaMatch = normalized.match(/^\/admin\/(media|images)\/([a-f0-9]{16})$/i);
  if (!mediaMatch) {
    return null;
  }
  return mediaMatch[2];
}

function normalizeLocalUrl(url: string): string | null {
  if (url.startsWith("/")) {
    return url;
  }
  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      return null;
    }
    if (!["localhost", "127.0.0.1", "::1"].includes(parsed.hostname)) {
      return null;
    }
    return parsed.pathname;
  } catch {
    return null;
  }
}

function mimeFromExt(filePath: string): string {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  const map: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
  };
  return map[ext] ?? "application/octet-stream";
}
