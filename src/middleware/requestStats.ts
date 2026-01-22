import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { randomUUID } from "crypto";
import { RequestStats } from "../types";
import { appendStats } from "../storage/statsRepository";
import { StoragePaths } from "../storage/files";

/**
 * Request Statistics Middleware
 * 
 * Captures metrics for all /v1/* requests:
 * - Latency (start/end timestamps)
 * - Request/response sizes
 * - Token usage (from upstream response or estimated)
 * - Error classification
 * 
 * Does NOT break streaming responses.
 */

interface RequestContext {
  requestId: string;
  startTime: number;
  requestBytes: number;
  route: string;
  method: string;
  publicModel?: string;
}

// WeakMap to store request context without polluting request object
const requestContexts = new WeakMap<FastifyRequest, RequestContext>();

export async function registerRequestStatsMiddleware(
  app: FastifyInstance,
  paths: StoragePaths
): Promise<void> {
  // Decorate request with stats context
  app.decorateRequest("statsContext", null);

  // Hook: onRequest - capture start time and request size
  app.addHook("onRequest", async (req: FastifyRequest) => {
    // Only track /v1/* routes
    if (!req.url.startsWith("/v1/")) {
      return;
    }

    const context: RequestContext = {
      requestId: randomUUID(),
      startTime: Date.now(),
      requestBytes: 0,
      route: req.url,
      method: req.method
    };

    // Estimate request size from content-length header
    const contentLength = req.headers["content-length"];
    if (contentLength) {
      context.requestBytes = parseInt(contentLength, 10) || 0;
    }

    requestContexts.set(req, context);
  });

  // Hook: preHandler - extract model from parsed body
  app.addHook("preHandler", async (req: FastifyRequest) => {
    const context = requestContexts.get(req);
    if (!context) return;

    const body = req.body as { model?: string } | undefined;
    if (body?.model) {
      context.publicModel = body.model;
    }
  });

  // Hook: onResponse - log the stats
  app.addHook("onResponse", async (req: FastifyRequest, reply: FastifyReply) => {
    const context = requestContexts.get(req);
    if (!context) return;

    const latencyMs = Date.now() - context.startTime;
    const statusCode = reply.statusCode;

    // Try to get response size from content-length header
    let responseBytes = 0;
    const respContentLength = reply.getHeader("content-length");
    if (respContentLength) {
      responseBytes = typeof respContentLength === "number" 
        ? respContentLength 
        : parseInt(String(respContentLength), 10) || 0;
    }

    // Determine if there was an error
    let errorType: string | undefined;
    if (statusCode >= 400) {
      if (statusCode >= 500) {
        errorType = "server_error";
      } else if (statusCode === 429) {
        errorType = "rate_limit";
      } else if (statusCode === 401 || statusCode === 403) {
        errorType = "auth_error";
      } else {
        errorType = "client_error";
      }
    }

    // Extract token info from reply (if stored during route handling)
    const statsPayload = (reply as unknown as { statsPayload?: StatsPayload }).statsPayload;
    
    const stats: RequestStats = {
      requestId: context.requestId,
      timestamp: new Date(),
      route: context.route,
      method: context.method,
      publicModel: context.publicModel,
      endpointId: statsPayload?.endpointId,
      endpointName: statsPayload?.endpointName,
      upstreamModel: statsPayload?.upstreamModel,
      requestBytes: context.requestBytes,
      responseBytes,
      latencyMs,
      statusCode,
      errorType,
      totalTokens: statsPayload?.totalTokens ?? estimateTokens(context.requestBytes, responseBytes),
      promptTokens: statsPayload?.promptTokens ?? null,
      completionTokens: statsPayload?.completionTokens ?? null
    };

    // Append stats asynchronously (don't block response)
    appendStats(paths, stats).catch((err) => {
      app.log.error({ err }, "Failed to append request stats");
    });

    // Cleanup
    requestContexts.delete(req);
  });
}

interface StatsPayload {
  endpointId?: string;
  endpointName?: string;
  upstreamModel?: string;
  totalTokens?: number | null;
  promptTokens?: number | null;
  completionTokens?: number | null;
}

/**
 * Helper to set stats payload from route handlers
 */
export function setStatsPayload(reply: FastifyReply, payload: StatsPayload): void {
  (reply as unknown as { statsPayload?: StatsPayload }).statsPayload = payload;
}

/**
 * Estimate token count from byte sizes when actual usage is not available.
 * Uses rough approximation: ~4 characters per token, ~1 byte per character for English.
 * This is intentionally conservative.
 */
function estimateTokens(requestBytes: number, responseBytes: number): number | null {
  if (requestBytes === 0 && responseBytes === 0) {
    return null;
  }
  // Rough estimate: 4 bytes per token average
  return Math.ceil((requestBytes + responseBytes) / 4);
}
