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
    const windowDays = parseWindowDays(req.query.window ?? "7d");
    
    if (windowDays === null) {
      reply.code(400).send({ error: { message: "Invalid window format" } });
      return;
    }

    try {
      const stats = await readStatsForWindow(paths, windowDays);
      const latencies = stats.map((s) => s.latencyMs).sort((a, b) => a - b);
      
      if (latencies.length === 0) {
        reply.send({ 
          window: `${windowDays}d`,
          count: 0,
          distribution: null 
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
        window: `${windowDays}d`,
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
    const windowDays = parseWindowDays(req.query.window ?? "7d");
    
    if (windowDays === null) {
      reply.code(400).send({ error: { message: "Invalid window format" } });
      return;
    }

    try {
      const stats = await readStatsForWindow(paths, windowDays);
      
      // Group by day
      const byDay: Record<string, { count: number; tokens: number; estimated: number }> = {};
      
      for (const stat of stats) {
        const day = stat.timestamp.toISOString().split("T")[0];
        if (!byDay[day]) {
          byDay[day] = { count: 0, tokens: 0, estimated: 0 };
        }
        byDay[day].count++;
        if (stat.totalTokens !== null && stat.totalTokens !== undefined) {
          byDay[day].tokens += stat.totalTokens;
        } else {
          byDay[day].estimated++;
        }
      }

      const days = Object.entries(byDay)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, data]) => ({ date, ...data }));

      const totalTokens = stats.reduce((sum, s) => sum + (s.totalTokens ?? 0), 0);
      
      reply.send({
        window: `${windowDays}d`,
        totalTokens,
        totalRequests: stats.length,
        avgTokensPerRequest: stats.length > 0 ? Math.round(totalTokens / stats.length) : 0,
        byDay: days
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
