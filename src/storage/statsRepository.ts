import { promises as fs } from "fs";
import path from "path";
import { RequestStats, StatsAggregation } from "../types";
import { StoragePaths, ensureStorageDir } from "./files";

/**
 * Stats Repository
 * 
 * Manages request statistics with daily file rotation:
 * - stats-YYYY-MM-DD.jsonl for each day
 * - 7-day query window
 * - 30-day retention with auto-cleanup
 */

export interface ExtendedStoragePaths extends StoragePaths {
  statsDir: string;
}

export function resolveStatsDir(paths: StoragePaths): string {
  return path.join(paths.baseDir, "stats");
}

function formatDate(date: Date): string {
  return date.toISOString().split("T")[0];
}

function getStatsFilePath(statsDir: string, date: Date): string {
  return path.join(statsDir, `stats-${formatDate(date)}.jsonl`);
}

export async function ensureStatsDir(paths: StoragePaths): Promise<void> {
  const statsDir = resolveStatsDir(paths);
  await fs.mkdir(statsDir, { recursive: true });
}

export async function appendStats(paths: StoragePaths, stats: RequestStats): Promise<void> {
  await ensureStatsDir(paths);
  const statsDir = resolveStatsDir(paths);
  const filePath = getStatsFilePath(statsDir, stats.timestamp);
  const line = `${JSON.stringify(stats)}\n`;
  await fs.appendFile(filePath, line, "utf8");
}

export async function readStatsForWindow(
  paths: StoragePaths,
  windowDays: number = 7
): Promise<RequestStats[]> {
  await ensureStatsDir(paths);
  const statsDir = resolveStatsDir(paths);
  const stats: RequestStats[] = [];
  const now = new Date();
  const cutoff = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000);

  // Read files for the window period
  for (let i = 0; i <= windowDays; i++) {
    const date = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
    const filePath = getStatsFilePath(statsDir, date);
    
    try {
      const raw = await fs.readFile(filePath, "utf8");
      const lines = raw.split("\n").filter((line) => line.trim().length > 0);
      
      for (const line of lines) {
        try {
          const entry = JSON.parse(line) as RequestStats;
          entry.timestamp = new Date(entry.timestamp);
          if (entry.timestamp >= cutoff) {
            stats.push(entry);
          }
        } catch {
          // Skip malformed lines
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }

  return stats.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
}

export async function aggregateStats(
  paths: StoragePaths,
  windowMs: number = 7 * 24 * 60 * 60 * 1000
): Promise<StatsAggregation> {
  const windowDays = Math.ceil(windowMs / (24 * 60 * 60 * 1000));
  const stats = await readStatsForWindow(paths, windowDays);
  const cutoff = Date.now() - windowMs;
  const filtered = stats.filter((s) => s.timestamp.getTime() >= cutoff);

  if (filtered.length === 0) {
    return {
      window: formatWindowString(windowMs),
      total: 0,
      success: 0,
      errors: 0,
      avgLatencyMs: null,
      p50LatencyMs: null,
      p95LatencyMs: null,
      p99LatencyMs: null,
      totalTokens: 0,
      tokensPerHour: null,
      byModel: {},
      byEndpoint: {}
    };
  }

  const latencies = filtered.map((s) => s.latencyMs).sort((a, b) => a - b);
  const successCount = filtered.filter((s) => !s.errorType && s.statusCode >= 200 && s.statusCode < 400).length;
  const errorCount = filtered.filter((s) => s.errorType || s.statusCode >= 400).length;
  
  let totalTokens = 0;
  const byModel: Record<string, { count: number; sumLatency: number; tokens: number }> = {};
  const byEndpoint: Record<string, { count: number; sumLatency: number; tokens: number; errors: number; name: string }> = {};

  for (const stat of filtered) {
    const tokens = stat.totalTokens ?? 0;
    totalTokens += tokens;

    // Aggregate by model
    if (stat.publicModel) {
      if (!byModel[stat.publicModel]) {
        byModel[stat.publicModel] = { count: 0, sumLatency: 0, tokens: 0 };
      }
      byModel[stat.publicModel].count += 1;
      byModel[stat.publicModel].sumLatency += stat.latencyMs;
      byModel[stat.publicModel].tokens += tokens;
    }

    // Aggregate by endpoint
    if (stat.endpointId) {
      if (!byEndpoint[stat.endpointId]) {
        byEndpoint[stat.endpointId] = { count: 0, sumLatency: 0, tokens: 0, errors: 0, name: stat.endpointName ?? "unknown" };
      }
      byEndpoint[stat.endpointId].count += 1;
      byEndpoint[stat.endpointId].sumLatency += stat.latencyMs;
      byEndpoint[stat.endpointId].tokens += tokens;
      if (stat.errorType || stat.statusCode >= 400) {
        byEndpoint[stat.endpointId].errors += 1;
      }
    }
  }

  // Calculate percentiles
  const p50 = percentile(latencies, 50);
  const p95 = percentile(latencies, 95);
  const p99 = percentile(latencies, 99);
  const avgLatency = latencies.reduce((a, b) => a + b, 0) / latencies.length;

  // Calculate tokens per hour
  const windowHours = windowMs / (60 * 60 * 1000);
  const tokensPerHour = windowHours > 0 ? totalTokens / windowHours : null;

  // Transform aggregations to final format
  const byModelFinal: Record<string, { count: number; avgLatencyMs: number; tokens: number }> = {};
  for (const [model, data] of Object.entries(byModel)) {
    byModelFinal[model] = {
      count: data.count,
      avgLatencyMs: Math.round(data.sumLatency / data.count),
      tokens: data.tokens
    };
  }

  const byEndpointFinal: Record<string, { count: number; avgLatencyMs: number; tokens: number; errors: number }> = {};
  for (const [id, data] of Object.entries(byEndpoint)) {
    byEndpointFinal[id] = {
      count: data.count,
      avgLatencyMs: Math.round(data.sumLatency / data.count),
      tokens: data.tokens,
      errors: data.errors
    };
  }

  return {
    window: formatWindowString(windowMs),
    total: filtered.length,
    success: successCount,
    errors: errorCount,
    avgLatencyMs: Math.round(avgLatency),
    p50LatencyMs: p50,
    p95LatencyMs: p95,
    p99LatencyMs: p99,
    totalTokens,
    tokensPerHour: tokensPerHour !== null ? Math.round(tokensPerHour) : null,
    byModel: byModelFinal,
    byEndpoint: byEndpointFinal
  };
}

function percentile(sortedArr: number[], p: number): number | null {
  if (sortedArr.length === 0) return null;
  const index = Math.ceil((p / 100) * sortedArr.length) - 1;
  return Math.round(sortedArr[Math.max(0, index)]);
}

function formatWindowString(ms: number): string {
  const hours = ms / (60 * 60 * 1000);
  if (hours < 24) return `${Math.round(hours)}h`;
  return `${Math.round(hours / 24)}d`;
}

/**
 * Rotate stats files - delete files older than retentionDays
 */
export async function rotateStats(paths: StoragePaths, retentionDays: number = 30): Promise<number> {
  await ensureStatsDir(paths);
  const statsDir = resolveStatsDir(paths);
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  let deleted = 0;

  try {
    const files = await fs.readdir(statsDir);
    
    for (const file of files) {
      if (!file.startsWith("stats-") || !file.endsWith(".jsonl")) {
        continue;
      }
      
      // Extract date from filename: stats-YYYY-MM-DD.jsonl
      const match = file.match(/^stats-(\d{4}-\d{2}-\d{2})\.jsonl$/);
      if (!match) continue;
      
      const fileDate = new Date(match[1]);
      if (fileDate < cutoff) {
        await fs.unlink(path.join(statsDir, file));
        deleted += 1;
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  return deleted;
}
