import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { randomUUID } from "crypto";
import { StoragePaths } from "../storage/files";
import { CaptureRoutingInfo, isCaptureEnabled, persistCaptureRecord } from "../storage/captureRepository";

interface CaptureContext {
  id: string;
  startedAt: number;
  enabled: boolean;
  requestBody?: unknown;
  responseBody?: unknown;
  responseHeaders?: Record<string, string | string[] | undefined>;
  routing?: CaptureRoutingInfo;
  derivedRequest?: Record<string, unknown>;
  error?: { type?: string; message?: string };
}

const captureContexts = new WeakMap<FastifyRequest, CaptureContext>();

interface ReplyCaptureMeta {
  captureRouting?: CaptureRoutingInfo;
  captureDerivedRequest?: Record<string, unknown>;
  captureResponseOverride?: {
    body: unknown;
    headers?: Record<string, string | string[] | undefined>;
  };
  captureError?: { type?: string; message?: string };
}

function meta(reply: FastifyReply): ReplyCaptureMeta {
  return reply as unknown as ReplyCaptureMeta;
}

export async function registerRequestCaptureMiddleware(
  app: FastifyInstance,
  paths: StoragePaths
): Promise<void> {
  app.addHook("onRequest", async (req: FastifyRequest) => {
    if (!req.url.startsWith("/v1/")) return;
    let enabled = false;
    try {
      enabled = await isCaptureEnabled(paths);
    } catch {
      enabled = false;
    }
    captureContexts.set(req, {
      id: randomUUID(),
      startedAt: Date.now(),
      enabled,
    });
  });

  app.addHook("preHandler", async (req: FastifyRequest) => {
    const context = captureContexts.get(req);
    if (!context?.enabled) return;
    context.requestBody = safeClone(req.body);
  });

  app.addHook("onSend", async (req: FastifyRequest, reply: FastifyReply, payload: unknown) => {
    const context = captureContexts.get(req);
    if (!context?.enabled) return payload;
    if (!meta(reply).captureResponseOverride) {
      context.responseBody = payloadToBody(payload);
      context.responseHeaders = reply.getHeaders() as Record<string, string | string[] | undefined>;
    }
    return payload;
  });

  app.addHook("onResponse", async (req: FastifyRequest, reply: FastifyReply) => {
    const context = captureContexts.get(req);
    if (!context) return;
    try {
      if (!context.enabled) return;
      const replyMeta = meta(reply);
      context.routing = replyMeta.captureRouting;
      context.derivedRequest = replyMeta.captureDerivedRequest;
      context.error = replyMeta.captureError;
      if (replyMeta.captureResponseOverride) {
        context.responseBody = replyMeta.captureResponseOverride.body;
        context.responseHeaders = replyMeta.captureResponseOverride.headers;
      }

      await persistCaptureRecord(paths, {
        route: req.url,
        method: req.method,
        statusCode: reply.statusCode,
        latencyMs: Date.now() - context.startedAt,
        requestHeaders: req.headers as Record<string, string | string[] | undefined>,
        responseHeaders:
          context.responseHeaders ??
          (reply.getHeaders() as Record<string, string | string[] | undefined>),
        requestBody: context.requestBody,
        responseBody: context.responseBody,
        derivedRequest: context.derivedRequest,
        routing: context.routing,
        error: context.error,
      });
    } catch (error) {
      app.log.warn({ err: error }, "Failed to persist request capture");
    } finally {
      captureContexts.delete(req);
    }
  });
}

export function setCaptureRouting(reply: FastifyReply, routing: CaptureRoutingInfo): void {
  meta(reply).captureRouting = routing;
}

export function setCaptureDerivedRequest(reply: FastifyReply, payload: Record<string, unknown>): void {
  meta(reply).captureDerivedRequest = payload;
}

export function setCaptureResponseOverride(
  reply: FastifyReply,
  body: unknown,
  headers?: Record<string, string | string[] | undefined>
): void {
  meta(reply).captureResponseOverride = { body, headers };
}

export function setCaptureError(reply: FastifyReply, error: { type?: string; message?: string }): void {
  meta(reply).captureError = error;
}

function safeClone<T>(value: T): T {
  try {
    return JSON.parse(JSON.stringify(value)) as T;
  } catch {
    return value;
  }
}

function payloadToBody(payload: unknown): unknown {
  if (payload === null || payload === undefined) return payload;
  if (Buffer.isBuffer(payload)) {
    return { $type: "buffer", base64: payload.toString("base64"), bytes: payload.byteLength };
  }
  if (typeof payload === "string") {
    try {
      return JSON.parse(payload);
    } catch {
      return payload;
    }
  }
  return payload;
}

