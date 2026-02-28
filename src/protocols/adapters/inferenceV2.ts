import { promises as fs } from "fs";
import { Readable } from "stream";
import { getMediaPath } from "../../storage/imageCache";
import {
  PreparedUpstreamRequest,
  ProtocolAdapter,
  ProtocolBuildRequestContext,
  ProtocolNormalizeResponseContext,
  ProtocolSupportContext,
} from "../types";
import { UpstreamError, UpstreamResult } from "../../types";

const DEFAULT_RESPONSE_TEXT_PATHS = [
  "outputs.0.outputs.text",
  "outputs.0.text",
  "outputs.0.generated_text",
];

export const inferenceV2ProtocolAdapter: ProtocolAdapter = {
  id: "inference_v2",
  supportedOperations: ["chat_completions"],
  streamSupportedOperations: [],
  supports(context: ProtocolSupportContext) {
    if (context.operation !== "chat_completions") {
      return { supported: false, reason: "unsupported_operation" };
    }
    if (context.stream) {
      return { supported: false, reason: "stream_unsupported" };
    }
    return { supported: true };
  },
  async buildRequest(context: ProtocolBuildRequestContext): Promise<PreparedUpstreamRequest> {
    const router = typeof context.config?.router === "string" ? context.config.router.trim() : "";
    if (!router) {
      throw protocolError(
        "invalid_protocol_config",
        "inference_v2 protocol requires provider protocolConfig.router.",
        false
      );
    }

    const { text, image } = await extractPromptAndImage(
      context.paths,
      context.payload
    );

    const inferInputs: Record<string, unknown> = {
      text,
      max_new_tokens: numberOrUndefined(context.payload.max_tokens),
      temperature: numberOrUndefined(context.payload.temperature),
      top_p: numberOrUndefined(context.payload.top_p),
    };
    if (image) {
      inferInputs.image = image;
    }

    const payload: Record<string, unknown> = {
      inputs: [
        {
          model_name: context.upstreamModel,
          inputs: compactObject(inferInputs),
        },
      ],
    };

    const requestPath = `/v2/models/${encodeURIComponent(router)}/infer`;
    const auth = buildAuth(context, requestPath);
    return {
      path: auth.path,
      payload,
      headers: auth.headers,
      skipDefaultAuth: auth.skipDefaultAuth,
    };
  },
  async normalizeResponse(
    context: ProtocolNormalizeResponseContext
  ): Promise<UpstreamResult> {
    const responseJson = await readJsonBody(context.upstreamResult);
    const textPaths = normalizeTextPaths(context.config?.responseTextPaths);
    const content = firstStringByPaths(responseJson, textPaths);
    if (!content) {
      throw protocolError(
        "invalid_upstream_response",
        "Inference v2 response does not contain assistant text at configured paths.",
        true
      );
    }

    const promptTokens = numberFromPath(responseJson, "usage.prompt_tokens");
    const completionTokens = numberFromPath(responseJson, "usage.completion_tokens");
    const totalTokensCandidate = numberFromPath(responseJson, "usage.total_tokens");
    const totalTokens =
      totalTokensCandidate ??
      (promptTokens !== undefined && completionTokens !== undefined
        ? promptTokens + completionTokens
        : undefined);

    const normalized = {
      id: `chatcmpl-infer-${Date.now().toString(36)}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: context.publicModel,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content,
          },
          finish_reason: "stop",
        },
      ],
      usage:
        promptTokens !== undefined || completionTokens !== undefined || totalTokens !== undefined
          ? {
              prompt_tokens: promptTokens ?? 0,
              completion_tokens: completionTokens ?? 0,
              total_tokens: totalTokens ?? 0,
            }
          : undefined,
      waypoint_adapter: {
        protocol: "inference_v2",
      },
    };

    const buffer = Buffer.from(JSON.stringify(normalized), "utf8");
    const headers = {
      ...context.upstreamResult.headers,
      "content-type": "application/json",
    };
    return {
      statusCode: context.upstreamResult.statusCode,
      headers,
      body: Readable.from([buffer]),
      rawBody: buffer,
    };
  },
};

async function extractPromptAndImage(
  paths: ProtocolBuildRequestContext["paths"],
  payload: Record<string, unknown>
): Promise<{ text: string; image?: string }> {
  const messages = Array.isArray(payload.messages)
    ? payload.messages
    : [];
  const message =
    [...messages]
      .reverse()
      .find(
        (item) =>
          item &&
          typeof item === "object" &&
          (item as { role?: unknown }).role === "user"
      ) ?? messages[messages.length - 1];

  if (!message || typeof message !== "object") {
    return { text: "" };
  }

  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") {
    return { text: content };
  }
  if (!Array.isArray(content)) {
    return { text: "" };
  }

  const textParts: string[] = [];
  let image: string | undefined;

  for (const part of content) {
    if (!part || typeof part !== "object") {
      continue;
    }
    const typed = part as Record<string, unknown>;
    const type = typeof typed.type === "string" ? typed.type : "";
    if (type === "text" || type === "input_text" || type === "output_text") {
      const text = typed.text;
      if (typeof text === "string" && text.length > 0) {
        textParts.push(text);
      }
      continue;
    }
    if (!image && type === "image_url") {
      const imageUrl = typed.image_url as { url?: unknown } | undefined;
      if (typeof imageUrl?.url === "string") {
        image = await resolveImageToBase64(paths, imageUrl.url);
      }
      continue;
    }
    if (!image && type === "image") {
      const value = typed.image;
      if (typeof value === "string") {
        image = await resolveImageToBase64(paths, value);
      }
      continue;
    }
    if (!image && type === "input_image") {
      const imageValue = typed.image ?? (typed.image_url as { url?: unknown } | undefined)?.url;
      if (typeof imageValue === "string") {
        image = await resolveImageToBase64(paths, imageValue);
      }
    }
  }

  return {
    text: textParts.join("\n").trim(),
    image,
  };
}

async function resolveImageToBase64(
  paths: ProtocolBuildRequestContext["paths"],
  value: string
): Promise<string> {
  if (value.startsWith("data:")) {
    const match = value.match(/^data:[^;]+;base64,(.+)$/i);
    if (!match) {
      throw protocolError("invalid_request", "Invalid data URL for image input.", false);
    }
    return match[1].replace(/\s+/g, "");
  }
  if (looksLikeBase64(value)) {
    return value.replace(/\s+/g, "");
  }

  const hash = extractLocalMediaHash(value);
  if (!hash) {
    throw protocolError(
      "invalid_request",
      "Only local /admin/media or /admin/images URLs are allowed for image input.",
      false
    );
  }
  const mediaPath = await getMediaPath(paths, hash);
  if (!mediaPath) {
    throw protocolError("invalid_request", "Referenced image not found in cache.", false);
  }
  const buffer = await fs.readFile(mediaPath);
  return buffer.toString("base64");
}

function normalizeTextPaths(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    const values = raw.filter((value): value is string => typeof value === "string" && value.length > 0);
    if (values.length > 0) {
      return values;
    }
  }
  return DEFAULT_RESPONSE_TEXT_PATHS;
}

function firstStringByPaths(source: unknown, paths: string[]): string | undefined {
  for (const path of paths) {
    const value = getByPath(source, path);
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function numberFromPath(source: unknown, path: string): number | undefined {
  const value = getByPath(source, path);
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  return undefined;
}

function getByPath(source: unknown, path: string): unknown {
  const segments = path
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
  let cursor: unknown = source;
  for (const segment of segments) {
    if (cursor === null || cursor === undefined) {
      return undefined;
    }
    if (Array.isArray(cursor)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0 || index >= cursor.length) {
        return undefined;
      }
      cursor = cursor[index];
      continue;
    }
    if (typeof cursor !== "object") {
      return undefined;
    }
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

function compactObject(input: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) {
      output[key] = value;
    }
  }
  return output;
}

function numberOrUndefined(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  return undefined;
}

function looksLikeBase64(value: string): boolean {
  if (value.length < 32) {
    return false;
  }
  return /^[A-Za-z0-9+/=\s]+$/.test(value);
}

function extractLocalMediaHash(url: string): string | null {
  const normalized = normalizeLocalUrl(url);
  if (!normalized) {
    return null;
  }
  const match = normalized.match(/^\/admin\/(media|images)\/([a-f0-9]{16})$/i);
  return match ? match[2] : null;
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

function buildAuth(
  context: ProtocolBuildRequestContext,
  defaultPath: string
): {
  path: string;
  headers?: Record<string, string>;
  skipDefaultAuth?: boolean;
} {
  const authType = context.auth?.type ?? "bearer";
  if (authType === "none") {
    return { path: defaultPath, skipDefaultAuth: true };
  }

  if (authType === "query") {
    const keyParam = context.auth?.keyParam ?? "api_key";
    const apiKey = context.endpoint.apiKey;
    if (!apiKey) {
      return { path: defaultPath, skipDefaultAuth: true };
    }
    const parsed = new URL(defaultPath, "http://placeholder.local");
    parsed.searchParams.set(keyParam, apiKey);
    return { path: `${parsed.pathname}${parsed.search}`, skipDefaultAuth: true };
  }

  if (authType === "header") {
    const headerName =
      context.auth?.headerName ?? context.auth?.keyParam ?? "x-api-key";
    const apiKey = context.endpoint.apiKey;
    if (!apiKey) {
      return { path: defaultPath, skipDefaultAuth: true };
    }
    const prefix = context.auth?.keyPrefix ? `${context.auth.keyPrefix} ` : "";
    return {
      path: defaultPath,
      headers: {
        [headerName]: `${prefix}${apiKey}`,
      },
      skipDefaultAuth: true,
    };
  }

  return { path: defaultPath, skipDefaultAuth: false };
}

async function readJsonBody(result: UpstreamResult): Promise<unknown> {
  if (result.rawBody) {
    return safeJsonParse(result.rawBody.toString("utf8"));
  }
  const chunks: Buffer[] = [];
  for await (const chunk of result.body) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const buffer = Buffer.concat(chunks);
  return safeJsonParse(buffer.toString("utf8"));
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw protocolError(
      "invalid_upstream_response",
      `Inference v2 response is not valid JSON: ${(error as Error).message}`,
      true
    );
  }
}

function protocolError(
  type: string,
  message: string,
  retryable: boolean
): UpstreamError {
  const error = new Error(message) as UpstreamError;
  error.type = type;
  error.retryable = retryable;
  return error;
}

