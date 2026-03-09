import path from "path";
import { StoragePaths } from "../storage/files";
import { getMediaEntry, getMediaPath } from "../storage/imageCache";

export interface MessageMediaScan {
  hasImage: boolean;
  hasAudio: boolean;
}

export function scanMessageModalities(messages: unknown): MessageMediaScan {
  const result: MessageMediaScan = { hasImage: false, hasAudio: false };
  if (!Array.isArray(messages)) {
    return result;
  }

  for (const message of messages) {
    if (!message || typeof message !== "object") {
      continue;
    }
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) {
      continue;
    }
    for (const part of content) {
      if (!part || typeof part !== "object") {
        continue;
      }
      const type = (part as { type?: unknown }).type;
      if (type === "image_url" || type === "input_image" || type === "image") {
        result.hasImage = true;
      }
      if (type === "input_audio" || type === "audio") {
        result.hasAudio = true;
      }
    }
  }

  return result;
}

export async function normalizeMessagesForUpstream(
  paths: StoragePaths,
  messages: unknown
): Promise<unknown> {
  if (!Array.isArray(messages)) {
    return messages;
  }

  const normalized: unknown[] = [];
  for (const message of messages) {
    if (!message || typeof message !== "object") {
      normalized.push(message);
      continue;
    }

    const nextMessage: Record<string, unknown> = { ...(message as Record<string, unknown>) };
    const content = nextMessage.content;
    if (!Array.isArray(content)) {
      normalized.push(nextMessage);
      continue;
    }

    const nextContent: unknown[] = [];
    for (const rawPart of content) {
      if (!rawPart || typeof rawPart !== "object") {
        nextContent.push(rawPart);
        continue;
      }
      const part = { ...(rawPart as Record<string, unknown>) };
      const type = part.type;

      if (type === "video") {
        throw invalidRequestError("Video content is not supported in v1 omni mode.");
      }

      if (type === "image" && typeof part.image === "string") {
        nextContent.push({ type: "image_url", image_url: { url: part.image } });
        continue;
      }

      if (type === "image_url") {
        nextContent.push(await normalizeImageUrlPart(paths, part));
        continue;
      }

      if (type === "audio" && typeof part.audio === "string") {
        nextContent.push(await normalizeAudioValue(paths, part.audio));
        continue;
      }

      if (type === "input_audio") {
        nextContent.push(await normalizeInputAudioPart(paths, part));
        continue;
      }

      nextContent.push(part);
    }

    nextMessage.content = nextContent;
    normalized.push(nextMessage);
  }

  return normalized;
}

async function normalizeImageUrlPart(
  paths: StoragePaths,
  part: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const imageUrlObject = (part.image_url ?? {}) as { url?: unknown };
  const value = imageUrlObject.url;
  if (typeof value !== "string" || value.length === 0) {
    return part;
  }

  if (value.startsWith("data:")) {
    return part;
  }

  const hash = extractLocalHash(value);
  if (!hash) {
    return part;
  }

  const mediaPath = await getMediaPath(paths, hash);
  const mediaEntry = await getMediaEntry(paths, hash);
  if (!mediaPath || !mediaEntry) {
    throw invalidRequestError("Referenced image not found in cache.");
  }
  const file = await import("fs/promises");
  const buffer = await file.readFile(mediaPath);
  const dataUrl = `data:${mediaEntry.mimeType};base64,${buffer.toString("base64")}`;

  return {
    ...part,
    type: "image_url",
    image_url: {
      ...imageUrlObject,
      url: dataUrl,
    },
  };
}

async function normalizeInputAudioPart(
  paths: StoragePaths,
  part: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const inputAudio = (part.input_audio ?? {}) as Record<string, unknown>;
  const data = inputAudio.data;
  const url = inputAudio.url;

  if (typeof data === "string" && data.length > 0) {
    return {
      ...part,
      type: "input_audio",
      input_audio: {
        ...inputAudio,
      },
    };
  }

  if (typeof url === "string" && url.length > 0) {
    const resolved = await resolveLocalMediaUrl(paths, url);
    return {
      ...part,
      type: "input_audio",
      input_audio: resolved,
    };
  }

  throw invalidRequestError("input_audio requires either data or a local media url.");
}

async function normalizeAudioValue(paths: StoragePaths, value: string): Promise<Record<string, unknown>> {
  if (value.startsWith("data:")) {
    const parsed = parseDataUrl(value);
    return {
      type: "input_audio",
      input_audio: {
        data: parsed.base64,
        format: parsed.format,
      },
    };
  }

  if (looksLikeBase64(value)) {
    return {
      type: "input_audio",
      input_audio: {
        data: value,
      },
    };
  }

  const resolved = await resolveLocalMediaUrl(paths, value);
  return {
    type: "input_audio",
    input_audio: resolved,
  };
}

async function resolveLocalMediaUrl(
  paths: StoragePaths,
  url: string
): Promise<{ data: string; format?: string }> {
  const hash = extractLocalHash(url);
  if (!hash) {
    throw invalidRequestError("Only local /admin/media or /admin/images URLs are allowed for input_audio.");
  }

  const mediaPath = await getMediaPath(paths, hash);
  const mediaEntry = await getMediaEntry(paths, hash);
  if (!mediaPath || !mediaEntry) {
    throw invalidRequestError("Referenced media not found in cache.");
  }

  const file = await import("fs/promises");
  const buffer = await file.readFile(mediaPath);
  return {
    data: buffer.toString("base64"),
    format: audioFormatFromMime(mediaEntry.mimeType, mediaPath),
  };
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
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
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

function parseDataUrl(value: string): { base64: string; format?: string } {
  const match = value.match(/^data:([^;]+);base64,(.+)$/i);
  if (!match) {
    throw invalidRequestError("Invalid data URL for audio input.");
  }
  return {
    base64: match[2].replace(/\s+/g, ""),
    format: audioFormatFromMime(match[1]),
  };
}

function audioFormatFromMime(mimeType: string, filePath?: string): string | undefined {
  const lower = mimeType.toLowerCase();
  if (lower.includes("wav")) return "wav";
  if (lower.includes("mpeg") || lower.includes("mp3")) return "mp3";
  if (lower.includes("ogg")) return "ogg";
  if (lower.includes("webm")) return "webm";
  if (lower.includes("mp4") || lower.includes("m4a")) return "m4a";
  if (filePath) {
    const ext = path.extname(filePath).slice(1).toLowerCase();
    if (ext) return ext;
  }
  return undefined;
}

function looksLikeBase64(value: string): boolean {
  if (value.length < 32) {
    return false;
  }
  return /^[A-Za-z0-9+/=\s]+$/.test(value);
}

function invalidRequestError(message: string): Error & { type: string; retryable: boolean } {
  const error = new Error(message) as Error & { type: string; retryable: boolean };
  error.type = "invalid_request";
  error.retryable = false;
  return error;
}
