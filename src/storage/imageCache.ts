import { promises as fs } from "fs";
import path from "path";
import crypto from "crypto";
import { StoragePaths, ensureStorageDir } from "./files";

/**
 * Image Cache
 * 
 * Stores AIGC-generated images locally with LRU eviction.
 * Images are stored in ~/.cache/waypoint/images/
 */

export interface ImageCacheEntry {
  hash: string;
  filename: string;
  size: number;
  createdAt: Date;
  model?: string;
}

interface CacheIndex {
  entries: ImageCacheEntry[];
  totalSize: number;
}

const DEFAULT_MAX_SIZE_BYTES = 1024 * 1024 * 1024; // 1GB

export function resolveImagesDir(paths: StoragePaths): string {
  return path.join(paths.baseDir, "images");
}

function cacheIndexPath(paths: StoragePaths): string {
  return path.join(resolveImagesDir(paths), "index.json");
}

async function ensureImagesDir(paths: StoragePaths): Promise<void> {
  await ensureStorageDir(paths);
  const imagesDir = resolveImagesDir(paths);
  await fs.mkdir(imagesDir, { recursive: true });
}

async function loadCacheIndex(paths: StoragePaths): Promise<CacheIndex> {
  const indexPath = cacheIndexPath(paths);
  try {
    const raw = await fs.readFile(indexPath, "utf8");
    const data = JSON.parse(raw) as CacheIndex;
    data.entries = data.entries.map((e) => ({
      ...e,
      createdAt: new Date(e.createdAt),
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
  const indexPath = cacheIndexPath(paths);
  await fs.writeFile(indexPath, JSON.stringify(index, null, 2), "utf8");
}

/**
 * Store an image in the cache.
 * Returns the local file path if successful.
 */
export async function storeImage(
  paths: StoragePaths,
  data: Buffer | string,
  options?: { model?: string; maxSizeBytes?: number }
): Promise<{ filePath: string; hash: string; evicted: string[] }> {
  await ensureImagesDir(paths);
  
  const buffer = typeof data === "string" ? Buffer.from(data, "base64") : data;
  const hash = crypto.createHash("sha256").update(buffer).digest("hex").slice(0, 16);
  const ext = detectImageExtension(buffer);
  const filename = `${hash}.${ext}`;
  const filePath = path.join(resolveImagesDir(paths), filename);
  
  // Check if already cached
  const index = await loadCacheIndex(paths);
  const existing = index.entries.find((e) => e.hash === hash);
  if (existing) {
    // Move to end (most recently used)
    index.entries = index.entries.filter((e) => e.hash !== hash);
    existing.createdAt = new Date();
    index.entries.push(existing);
    await saveCacheIndex(paths, index);
    return { filePath, hash, evicted: [] };
  }
  
  // Write the image
  await fs.writeFile(filePath, buffer);
  
  const entry: ImageCacheEntry = {
    hash,
    filename,
    size: buffer.length,
    createdAt: new Date(),
    model: options?.model,
  };
  
  index.entries.push(entry);
  index.totalSize += buffer.length;
  
  // Evict old entries if over limit
  const maxSize = options?.maxSizeBytes ?? DEFAULT_MAX_SIZE_BYTES;
  const evicted: string[] = [];
  
  while (index.totalSize > maxSize && index.entries.length > 1) {
    const oldest = index.entries.shift();
    if (oldest) {
      const oldPath = path.join(resolveImagesDir(paths), oldest.filename);
      try {
        await fs.unlink(oldPath);
        evicted.push(oldest.hash);
      } catch {
        // File might already be deleted
      }
      index.totalSize -= oldest.size;
    }
  }
  
  await saveCacheIndex(paths, index);
  
  return { filePath, hash, evicted };
}

/**
 * Get the file path for a cached image by hash.
 */
export async function getImagePath(paths: StoragePaths, hash: string): Promise<string | null> {
  const index = await loadCacheIndex(paths);
  const entry = index.entries.find((e) => e.hash === hash);
  if (!entry) return null;
  return path.join(resolveImagesDir(paths), entry.filename);
}

/**
 * Get cache statistics.
 */
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

/**
 * Clear all cached images.
 */
export async function clearCache(paths: StoragePaths): Promise<number> {
  const index = await loadCacheIndex(paths);
  let deleted = 0;
  
  for (const entry of index.entries) {
    const filePath = path.join(resolveImagesDir(paths), entry.filename);
    try {
      await fs.unlink(filePath);
      deleted++;
    } catch {
      // File might already be deleted
    }
  }
  
  await saveCacheIndex(paths, { entries: [], totalSize: 0 });
  return deleted;
}

/**
 * Detect image extension from buffer magic bytes.
 */
function detectImageExtension(buffer: Buffer): string {
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return "png";
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "jpg";
  }
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) {
    return "gif";
  }
  if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46) {
    return "webp";
  }
  return "png"; // Default to PNG
}
