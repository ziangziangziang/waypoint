import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { aggregateStats, readStatsForWindow } from "../storage/statsRepository";
import { StoragePaths } from "../storage/files";

/**
 * Stats API Routes
 * 
 * Provides endpoints for querying request statistics:
 * - GET /admin/stats - aggregated statistics for time window
 * - GET /admin/stats/raw - raw stats entries for detailed analysis
 */

interface StatsQuery {
  window?: string; // e.g., "1h", "24h", "7d"
  timeZone?: string;
}

export async function registerStatsRoutes(
  app: FastifyInstance,
  paths: StoragePaths
): Promise<void> {
  // GET /admin/stats - aggregated statistics
  app.get("/admin/stats", async (req: FastifyRequest<{ Querystring: StatsQuery }>, reply: FastifyReply) => {
    const windowMs = parseWindow(req.query.window ?? "24h");
    
    if (windowMs === null) {
      reply.code(400).send({ 
        error: { 
          message: "Invalid window format. Use format like '1h', '24h', '7d'" 
        } 
      });
      return;
    }

    try {
      const stats = await aggregateStats(paths, windowMs);
      reply.send(stats);
    } catch (error) {
      app.log.error({ error }, "Failed to aggregate stats");
      reply.code(500).send({ error: { message: "Failed to retrieve statistics" } });
    }
  });

  // GET /admin/stats/raw - raw stats entries
  app.get("/admin/stats/raw", async (req: FastifyRequest<{ Querystring: StatsQuery & { limit?: string } }>, reply: FastifyReply) => {
    const windowDays = parseWindowDays(req.query.window ?? "1d");
    const limit = Math.min(parseInt(req.query.limit ?? "1000", 10), 10000);
    
    if (windowDays === null) {
      reply.code(400).send({ 
        error: { message: "Invalid window format" } 
      });
      return;
    }

    try {
      const stats = await readStatsForWindow(paths, windowDays);
      // Return most recent entries up to limit
      const entries = stats.slice(-limit);
      reply.send({
        window: `${windowDays}d`,
        count: entries.length,
        totalInWindow: stats.length,
        entries
      });
    } catch (error) {
      app.log.error({ error }, "Failed to read raw stats");
      reply.code(500).send({ error: { message: "Failed to retrieve statistics" } });
    }
  });

  // GET /admin/stats/latency - latency distribution
  app.get("/admin/stats/latency", async (req: FastifyRequest<{ Querystring: StatsQuery }>, reply: FastifyReply) => {
    const windowMs = parseWindow(req.query.window ?? "7d");

    if (windowMs === null) {
      reply.code(400).send({ error: { message: "Invalid window format" } });
      return;
    }

    try {
      const stats = await selectStatsForWindow(paths, windowMs);
      const latencies = stats.map((s) => s.latencyMs).sort((a, b) => a - b);
      const window = formatWindowString(windowMs);
      
      if (latencies.length === 0) {
        reply.send({ 
          window,
          count: 0,
          min: null,
          max: null,
          avg: null,
          p50: null,
          p95: null,
          p99: null,
          histogram: {}
        });
        return;
      }

      // Create histogram buckets
      const buckets = [50, 100, 200, 500, 1000, 2000, 5000, 10000];
      const histogram: Record<string, number> = {};
      
      for (const bucket of buckets) {
        histogram[`<${bucket}ms`] = 0;
      }
      histogram[">10000ms"] = 0;

      for (const latency of latencies) {
        let assigned = false;
        for (const bucket of buckets) {
          if (latency < bucket) {
            histogram[`<${bucket}ms`]++;
            assigned = true;
            break;
          }
        }
        if (!assigned) {
          histogram[">10000ms"]++;
        }
      }

      reply.send({
        window,
        count: latencies.length,
        min: latencies[0],
        max: latencies[latencies.length - 1],
        avg: Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length),
        p50: percentile(latencies, 50),
        p95: percentile(latencies, 95),
        p99: percentile(latencies, 99),
        histogram
      });
    } catch (error) {
      app.log.error({ error }, "Failed to compute latency distribution");
      reply.code(500).send({ error: { message: "Failed to retrieve statistics" } });
    }
  });

  // GET /admin/stats/tokens - token usage over time
  app.get("/admin/stats/tokens", async (req: FastifyRequest<{ Querystring: StatsQuery }>, reply: FastifyReply) => {
    const windowMs = parseWindow(req.query.window ?? "7d");
    const timeZone = normalizeTimeZone(req.query.timeZone);

    if (windowMs === null) {
      reply.code(400).send({ error: { message: "Invalid window format" } });
      return;
    }

    try {
      const stats = await selectStatsForWindow(paths, windowMs);
      const bucketGranularity = windowMs <= 24 * 60 * 60 * 1000 ? "hour" : "day";
      const byDay: Record<string, {
        count: number;
        tokens: number;
        estimated: number;
        inputTokens: number;
        outputTokens: number;
        splitUnknown: number;
      }> = {};
      let tokenEstimatedCount = 0;
      let splitUnknownCount = 0;
      let totalInputTokens = 0;
      let totalOutputTokens = 0;

      for (const stat of stats) {
        const bucket = formatTokenBucket(stat.timestamp, bucketGranularity, timeZone);
        if (!byDay[bucket]) {
          byDay[bucket] = {
            count: 0,
            tokens: 0,
            estimated: 0,
            inputTokens: 0,
            outputTokens: 0,
            splitUnknown: 0,
          };
        }
        byDay[bucket].count++;
        if (stat.totalTokens !== null && stat.totalTokens !== undefined) {
          byDay[bucket].tokens += stat.totalTokens;
        } else {
          byDay[bucket].estimated++;
          tokenEstimatedCount += 1;
        }

        const promptTokens = stat.promptTokens;
        const completionTokens = stat.completionTokens;
        const hasSplit =
          promptTokens !== null &&
          promptTokens !== undefined &&
          completionTokens !== null &&
          completionTokens !== undefined;
        if (hasSplit) {
          byDay[bucket].inputTokens += promptTokens;
          byDay[bucket].outputTokens += completionTokens;
          totalInputTokens += promptTokens;
          totalOutputTokens += completionTokens;
        } else {
          byDay[bucket].splitUnknown++;
          splitUnknownCount += 1;
        }
      }

      const days = Object.entries(byDay)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, data]) => ({ date, ...data }));

      const totalTokens = stats.reduce((sum, s) => sum + (s.totalTokens ?? 0), 0);
      
      reply.send({
        window: formatWindowString(windowMs),
        totalTokens,
        totalInputTokens,
        totalOutputTokens,
        totalRequests: stats.length,
        avgTokensPerRequest: stats.length > 0 ? Math.round(totalTokens / stats.length) : 0,
        byDay: days,
        tokenEstimatedCount,
        tokenEstimatedRate: stats.length > 0 ? tokenEstimatedCount / stats.length : 0,
        splitUnknownCount,
        splitUnknownRate: stats.length > 0 ? splitUnknownCount / stats.length : 0,
        bucketGranularity,
        bucketTimeZone: timeZone,
      });
    } catch (error) {
      app.log.error({ error }, "Failed to compute token usage");
      reply.code(500).send({ error: { message: "Failed to retrieve statistics" } });
    }
  });
}

function parseWindow(window: string): number | null {
  const match = window.match(/^(\d+)(h|d|m)$/);
  if (!match) return null;
  
  const value = parseInt(match[1], 10);
  const unit = match[2];
  
  switch (unit) {
    case "m": return value * 60 * 1000;
    case "h": return value * 60 * 60 * 1000;
    case "d": return value * 24 * 60 * 60 * 1000;
    default: return null;
  }
}

function parseWindowDays(window: string): number | null {
  const ms = parseWindow(window);
  if (ms === null) return null;
  return Math.ceil(ms / (24 * 60 * 60 * 1000));
}

function percentile(sortedArr: number[], p: number): number {
  if (sortedArr.length === 0) return 0;
  const index = Math.ceil((p / 100) * sortedArr.length) - 1;
  return sortedArr[Math.max(0, index)];
}

async function selectStatsForWindow(paths: StoragePaths, windowMs: number) {
  const windowDays = Math.ceil(windowMs / (24 * 60 * 60 * 1000));
  const stats = await readStatsForWindow(paths, windowDays);
  const cutoff = Date.now() - windowMs;
  return stats.filter((s) => s.timestamp.getTime() >= cutoff);
}

function formatWindowString(ms: number): string {
  const hours = ms / (60 * 60 * 1000);
  if (hours < 24) return `${Math.round(hours)}h`;
  return `${Math.round(hours / 24)}d`;
}

function formatTokenBucket(timestamp: Date, granularity: "hour" | "day", timeZone: string): string {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    ...(granularity === "hour"
      ? {
          hour: "2-digit",
          hourCycle: "h23" as const,
        }
      : {}),
  });
  const parts = formatter.formatToParts(timestamp);
  const year = parts.find((part) => part.type === "year")?.value ?? "0000";
  const month = parts.find((part) => part.type === "month")?.value ?? "00";
  const day = parts.find((part) => part.type === "day")?.value ?? "00";
  if (granularity === "day") {
    return `${year}-${month}-${day}`;
  }
  const hour = parts.find((part) => part.type === "hour")?.value ?? "00";
  return `${year}-${month}-${day}T${hour}:00`;
}

function normalizeTimeZone(input: string | undefined): string {
  if (!input) return "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: input });
    return input;
  } catch {
    return "UTC";
  }
}
