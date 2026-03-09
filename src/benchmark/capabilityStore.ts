import { createHash } from "crypto";
import { promises as fs } from "fs";
import path from "path";
import { StoragePaths } from "../storage/files";
import {
  BenchmarkCapabilityFreshness,
  BenchmarkCapabilityMatrix,
  BenchmarkCapabilityStatus,
  BenchmarkModelCapabilitySnapshot,
} from "./types";

const DEFAULT_TTL_DAYS = 7;

export interface CapabilityStoreListResult {
  generatedAt: string;
  ttlDays: number;
  models: BenchmarkModelCapabilitySnapshot[];
}

export function capabilityCacheDir(paths: StoragePaths): string {
  return path.join(paths.baseDir, "capabilities");
}

export function computeConfigFingerprint(input: unknown): string {
  const raw = JSON.stringify(input ?? {});
  return createHash("sha256").update(raw).digest("hex").slice(0, 16);
}

export async function writeCapabilitySnapshots(
  paths: StoragePaths,
  snapshots: BenchmarkModelCapabilitySnapshot[]
): Promise<void> {
  const dir = capabilityCacheDir(paths);
  await fs.mkdir(dir, { recursive: true });

  for (const snapshot of snapshots) {
    const filePath = path.join(dir, capabilityFileName(snapshot.providerId, snapshot.modelId));
    await fs.writeFile(filePath, JSON.stringify(snapshot, null, 2), "utf8");
  }
}

export async function listCapabilitySnapshots(
  paths: StoragePaths,
  ttlDays = DEFAULT_TTL_DAYS
): Promise<CapabilityStoreListResult> {
  const dir = capabilityCacheDir(paths);
  let files: string[] = [];
  try {
    files = await fs.readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        generatedAt: new Date().toISOString(),
        ttlDays,
        models: [],
      };
    }
    throw error;
  }

  const snapshots: BenchmarkModelCapabilitySnapshot[] = [];
  for (const file of files) {
    if (!file.endsWith(".json")) {
      continue;
    }

    try {
      const raw = await fs.readFile(path.join(dir, file), "utf8");
      const parsed = JSON.parse(raw) as Partial<BenchmarkModelCapabilitySnapshot>;
      const normalized = normalizeSnapshot(parsed, ttlDays);
      if (normalized) {
        snapshots.push(normalized);
      }
    } catch {
      // Ignore malformed cache entries.
    }
  }

  snapshots.sort((a, b) => `${a.providerId}/${a.modelId}`.localeCompare(`${b.providerId}/${b.modelId}`));

  return {
    generatedAt: new Date().toISOString(),
    ttlDays,
    models: snapshots,
  };
}

export async function getCapabilitySnapshotByModel(
  paths: StoragePaths,
  model: string,
  ttlDays = DEFAULT_TTL_DAYS
): Promise<BenchmarkModelCapabilitySnapshot | null> {
  const all = await listCapabilitySnapshots(paths, ttlDays);
  return all.models.find((item) => item.model === model || `${item.providerId}/${item.modelId}` === model) ?? null;
}

function capabilityFileName(providerId: string, modelId: string): string {
  return `${sanitizeSegment(providerId)}__${sanitizeSegment(modelId)}.json`;
}

function sanitizeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function normalizeSnapshot(
  input: Partial<BenchmarkModelCapabilitySnapshot>,
  ttlDays: number
): BenchmarkModelCapabilitySnapshot | null {
  if (!input || typeof input !== "object") {
    return null;
  }
  if (!input.providerId || !input.modelId || !input.model || !input.lastVerifiedAt) {
    return null;
  }

  const verifiedAtMs = Date.parse(input.lastVerifiedAt);
  if (!Number.isFinite(verifiedAtMs)) {
    return null;
  }

  const ttlMs = ttlDays * 24 * 60 * 60 * 1000;
  const expiresAt = input.expiresAt && Number.isFinite(Date.parse(input.expiresAt))
    ? input.expiresAt
    : new Date(verifiedAtMs + ttlMs).toISOString();
  const freshness = computeFreshness(expiresAt);

  return {
    model: input.model,
    providerId: input.providerId,
    modelId: input.modelId,
    configFingerprint: input.configFingerprint ?? "unknown",
    confidence: clamp01(input.confidence ?? 0),
    lastVerifiedAt: input.lastVerifiedAt,
    expiresAt,
    freshness,
    findings: (input.findings ?? {}) as BenchmarkModelCapabilitySnapshot["findings"],
  };
}

function computeFreshness(expiresAt: string): BenchmarkCapabilityFreshness {
  const expiryMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiryMs)) {
    return "stale";
  }
  return Date.now() <= expiryMs ? "fresh" : "stale";
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return Number(value.toFixed(3));
}

export function statusRank(status: BenchmarkCapabilityStatus): number {
  switch (status) {
    case "supported":
      return 4;
    case "unsupported":
      return 3;
    case "misconfigured":
      return 2;
    case "unknown":
      return 1;
  }
}

export function toCapabilityMatrix(result: CapabilityStoreListResult): BenchmarkCapabilityMatrix {
  return {
    generatedAt: result.generatedAt,
    ttlDays: result.ttlDays,
    models: result.models,
  };
}
