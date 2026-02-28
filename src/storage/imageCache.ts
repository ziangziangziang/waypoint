import { promises as fs } from "fs";
import path from "path";
import crypto from "crypto";
import { StoragePaths, ensureStorageDir } from "./files";

/**
 * Media Cache
 *
 * Stores generated and uploaded media locally with LRU eviction.
 * Backward-compatible with previous image-only APIs.
 */

export interface MediaCacheEntry {
  hash: string;
  filename: string;
  size: number;
  mimeType: string;
  createdAt: Date;
  model?: string;
}

interface CacheIndex {
  entries: MediaCacheEntry[];
  totalSize: number;
}

const DEFAULT_MAX_SIZE_BYTES = 1024 * 1024 * 1024; // 1GB

export function resolveMediaDir(paths: StoragePaths): string {
  return path.join(paths.baseDir, "media");
}

// Backward compatibility alias
export function resolveImagesDir(paths: StoragePaths): string {
  return resolveMediaDir(paths);
}

function cacheIndexPath(paths: StoragePaths): string {
  return path.join(resolveMediaDir(paths), "index.json");
}

async function ensureMediaDir(paths: StoragePaths): Promise<void> {
  await ensureStorageDir(paths);
  await fs.mkdir(resolveMediaDir(paths), { recursive: true });
}

async function loadCacheIndex(paths: StoragePaths): Promise<CacheIndex> {
  const indexPath = cacheIndexPath(paths);
  try {
    const raw = await fs.readFile(indexPath, "utf8");
    const data = JSON.parse(raw) as CacheIndex;
    data.entries = data.entries.map((entry) => ({
      ...entry,
      createdAt: new Date(entry.createdAt),
    }));
    return data;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { entries: [], totalSize: 0 };
    }
    throw error;
  }
}

async function saveCacheIndex(paths: StoragePaths, index: CacheIndex): Promise<void> {
  await fs.writeFile(cacheIndexPath(paths), JSON.stringify(index, null, 2), "utf8");
}

export async function storeMedia(
  paths: StoragePaths,
  data: Buffer | string,
  options?: { model?: string; maxSizeBytes?: number; mimeType?: string }
): Promise<{ filePath: string; hash: string; mimeType: string; evicted: string[] }> {
  await ensureMediaDir(paths);

  const normalized = normalizeMediaInput(data, options?.mimeType);
  const buffer = normalized.buffer;
  const mimeType = normalized.mimeType;
  const extension = extensionFromMime(mimeType, buffer);

  const hash = crypto.createHash("sha256").update(buffer).digest("hex").slice(0, 16);
  const filename = `${hash}.${extension}`;
  const filePath = path.join(resolveMediaDir(paths), filename);

  const index = await loadCacheIndex(paths);
  const existing = index.entries.find((entry) => entry.hash === hash);
  if (existing) {
    index.entries = index.entries.filter((entry) => entry.hash !== hash);
    existing.createdAt = new Date();
    index.entries.push(existing);
    await saveCacheIndex(paths, index);
    return { filePath, hash, mimeType: existing.mimeType, evicted: [] };
  }

  await fs.writeFile(filePath, buffer);

  const entry: MediaCacheEntry = {
    hash,
    filename,
    size: buffer.length,
    mimeType,
    createdAt: new Date(),
    model: options?.model,
  };
  index.entries.push(entry);
  index.totalSize += buffer.length;

  const maxSize = options?.maxSizeBytes ?? DEFAULT_MAX_SIZE_BYTES;
  const evicted: string[] = [];
  while (index.totalSize > maxSize && index.entries.length > 1) {
    const oldest = index.entries.shift();
    if (!oldest) {
      break;
    }
    try {
      await fs.unlink(path.join(resolveMediaDir(paths), oldest.filename));
      evicted.push(oldest.hash);
    } catch {
      // ignore missing file
    }
    index.totalSize -= oldest.size;
  }

  await saveCacheIndex(paths, index);

  return { filePath, hash, mimeType, evicted };
}

// Backward compatibility alias
export async function storeImage(
  paths: StoragePaths,
  data: Buffer | string,
  options?: { model?: string; maxSizeBytes?: number }
): Promise<{ filePath: string; hash: string; evicted: string[] }> {
  const stored = await storeMedia(paths, data, options);
  return { filePath: stored.filePath, hash: stored.hash, evicted: stored.evicted };
}

export async function getMediaPath(paths: StoragePaths, hash: string): Promise<string | null> {
  const index = await loadCacheIndex(paths);
  const entry = index.entries.find((item) => item.hash === hash);
  if (!entry) {
    return null;
  }
  return path.join(resolveMediaDir(paths), entry.filename);
}

export async function getMediaEntry(paths: StoragePaths, hash: string): Promise<MediaCacheEntry | null> {
  const index = await loadCacheIndex(paths);
  return index.entries.find((item) => item.hash === hash) ?? null;
}

// Backward compatibility alias
export async function getImagePath(paths: StoragePaths, hash: string): Promise<string | null> {
  return getMediaPath(paths, hash);
}

export async function getCacheStats(paths: StoragePaths): Promise<{
  count: number;
  totalSizeBytes: number;
  oldestEntry?: Date;
  newestEntry?: Date;
}> {
  const index = await loadCacheIndex(paths);
  if (index.entries.length === 0) {
    return { count: 0, totalSizeBytes: 0 };
  }

  const sorted = [...index.entries].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  return {
    count: index.entries.length,
    totalSizeBytes: index.totalSize,
    oldestEntry: sorted[0].createdAt,
    newestEntry: sorted[sorted.length - 1].createdAt,
  };
}

export async function clearCache(paths: StoragePaths): Promise<number> {
  const index = await loadCacheIndex(paths);
  let deleted = 0;

  for (const entry of index.entries) {
    try {
      await fs.unlink(path.join(resolveMediaDir(paths), entry.filename));
      deleted += 1;
    } catch {
      // ignore missing file
    }
  }

  await saveCacheIndex(paths, { entries: [], totalSize: 0 });
  return deleted;
}

function normalizeMediaInput(
  data: Buffer | string,
  hintedMime?: string
): { buffer: Buffer; mimeType: string } {
  if (Buffer.isBuffer(data)) {
    const mimeType = hintedMime ?? detectMimeType(data);
    return { buffer: data, mimeType };
  }

  const trimmed = data.trim();
  const dataUrlMatch = trimmed.match(/^data:([^;]+);base64,(.+)$/i);
  if (dataUrlMatch) {
    const mimeType = dataUrlMatch[1].toLowerCase();
    const base64Payload = dataUrlMatch[2].replace(/\s+/g, "");
    return { buffer: Buffer.from(base64Payload, "base64"), mimeType };
  }

  const buffer = Buffer.from(trimmed.replace(/\s+/g, ""), "base64");
  const mimeType = hintedMime ?? detectMimeType(buffer);
  return { buffer, mimeType };
}

function extensionFromMime(mimeType: string, buffer: Buffer): string {
  const map: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/gif": "gif",
    "image/webp": "webp",
    "audio/wav": "wav",
    "audio/x-wav": "wav",
    "audio/mpeg": "mp3",
    "audio/mp3": "mp3",
    "audio/ogg": "ogg",
    "audio/webm": "webm",
    "audio/mp4": "m4a",
  };
  if (map[mimeType]) {
    return map[mimeType];
  }

  // fallback by magic bytes
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return "png";
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "jpg";
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) return "gif";
  if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46) {
    if (buffer.length > 11) {
      const chunk = buffer.subarray(8, 12).toString("ascii");
      if (chunk === "WAVE") return "wav";
      if (chunk === "WEBP") return "webp";
    }
  }
  return "bin";
}

function detectMimeType(buffer: Buffer): string {
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return "image/png";
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) {
    return "image/gif";
  }
  if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46) {
    if (buffer.length > 11) {
      const chunk = buffer.subarray(8, 12).toString("ascii");
      if (chunk === "WAVE") return "audio/wav";
      if (chunk === "WEBP") return "image/webp";
    }
  }
  if (buffer.length > 3 && buffer[0] === 0x49 && buffer[1] === 0x44 && buffer[2] === 0x33) {
    return "audio/mpeg";
  }
  return "application/octet-stream";
}
