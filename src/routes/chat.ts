import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { randomUUID } from "crypto";
import { pipeline } from "stream";
import { routeRequest } from "../routing/router";
import { logRequest } from "../storage/repositories";
import { RequestLog } from "../types";
import { StoragePaths } from "../storage/files";
import { selectPoolCandidates } from "../pools/scheduler";
import { pickBestProviderModelByCapabilities } from "../providers/modelRegistry";
import { normalizeMessagesForUpstream, scanMessageModalities } from "../utils/messageMedia";
import {
  appendCaptureStreamChunk,
  setCaptureDerivedRequest,
  setCaptureError,
  setCaptureResponseOverride,
  setCaptureRouting,
  startCaptureStreamResponse,
} from "../middleware/requestCapture";
import { setStatsPayload } from "../middleware/requestStats";
import { Transform } from "stream";

interface ChatBody {
  model: string;
  stream?: boolean;
  max_tokens?: number;
  [key: string]: unknown;
}

export async function registerChatRoutes(app: FastifyInstance, paths: StoragePaths): Promise<void> {
  app.post("/v1/chat/completions", async (req: FastifyRequest, reply: FastifyReply) => {
    let body = req.body as ChatBody | undefined;
    if (!body?.model) {
      const fallback = await pickDefaultModel(paths);
      if (!fallback) {
        reply.code(400).send({ error: { message: "model is required" } });
        return;
      }
      body = { ...(body ?? {}), model: fallback };
    }

    const requestId = randomUUID();
    const start = Date.now();
    const controller = new AbortController();

    req.raw.on("close", () => controller.abort());

    try {
      const messages = (body as unknown as { messages?: unknown }).messages;
      const normalizedMessages = await normalizeMessagesForUpstream(paths, messages);
      const bodyWithNormalizedMessages: Record<string, unknown> = {
        ...(body as Record<string, unknown>),
        messages: normalizedMessages,
      };
      setCaptureDerivedRequest(reply, { normalizedRequest: bodyWithNormalizedMessages });
      const media = scanMessageModalities(normalizedMessages);
      const outcome = await routeRequest(
        paths,
        body.model,
        "/v1/chat/completions",
        bodyWithNormalizedMessages,
        req.headers as Record<string, string | string[] | undefined>,
        controller.signal,
        {
          requiredInput: media.hasAudio
            ? media.hasImage
              ? ["text", "image", "audio"]
              : ["text", "audio"]
            : media.hasImage
              ? ["text", "image"]
              : ["text"],
          requiredOutput: ["text"],
        }
      );

      if (body.stream) {
        setCaptureRouting(reply, {
          publicModel: body.model,
          endpointId: outcome.attempt.endpoint.id,
          endpointName: outcome.attempt.endpoint.name,
          upstreamModel: outcome.attempt.upstreamModel,
        });
        setStatsPayload(reply, {
          endpointId: outcome.attempt.endpoint.id,
          endpointName: outcome.attempt.endpoint.name,
          upstreamModel: outcome.attempt.upstreamModel,
        });
        await streamResponse(reply, outcome.attempt.response);
        await logRequest(paths, buildLog(requestId, body, outcome, Date.now() - start));
        return;
      }

      const upstreamBody = await readBody(outcome.attempt.response);
      setCaptureResponseOverride(reply, upstreamBody.payload, outcome.attempt.response.headers);
      setHeaders(reply, outcome.attempt.response.headers);
      reply.code(outcome.attempt.response.statusCode).send(upstreamBody.payload);
      setCaptureRouting(reply, {
        publicModel: body.model,
        endpointId: outcome.attempt.endpoint.id,
        endpointName: outcome.attempt.endpoint.name,
        upstreamModel: outcome.attempt.upstreamModel,
      });
      setStatsPayload(reply, {
        endpointId: outcome.attempt.endpoint.id,
        endpointName: outcome.attempt.endpoint.name,
        upstreamModel: outcome.attempt.upstreamModel,
        totalTokens: upstreamBody.totalTokens,
        promptTokens: upstreamBody.promptTokens,
        completionTokens: upstreamBody.completionTokens,
      });
      await logRequest(paths, buildLog(requestId, body, outcome, Date.now() - start, upstreamBody.totalTokens));
    } catch (error) {
      const errorType = (error as { type?: string }).type ?? (error as Error).name;
      setCaptureError(reply, { type: errorType, message: (error as Error).message });
      await logRequest(paths, {
        requestId,
        ts: new Date(),
        route: { publicModel: body?.model ?? "unknown" },
        request: { stream: Boolean(body?.stream), maxTokens: body?.max_tokens },
        result: {
          errorType,
          errorMessage: (error as Error).message
        }
      });
      // Don't try to send error if headers already sent (streaming started)
      if (reply.raw.headersSent) {
        req.log.warn({ err: error }, "Error after streaming started");
        reply.raw.end();
        return;
      }
      const status =
        errorType === "no_endpoints" ||
        errorType === "protocol_stream_unsupported" ||
        errorType === "unsupported_protocol" ||
        errorType === "invalid_protocol_config"
          ? 400
          : errorType === "rate_limited"
            ? 429
            : 502;
      if (errorType === "invalid_request") {
        reply.code(400).send({ error: { message: (error as Error).message } });
        return;
      }
      if (errorType === "tls_verify_failed") {
        reply.code(502).send({ error: { message: (error as Error).message } });
        return;
      }
      reply.code(status).send({ error: { message: "Upstream unavailable" } });
    }
  });
}

async function pickDefaultModel(paths: StoragePaths): Promise<string | null> {
  const smart = await selectPoolCandidates(paths, "smart", {
    requiredInput: ["text"],
    requiredOutput: ["text"],
  }, {
    operation: "chat_completions",
    stream: false,
  });
  if (smart && smart.candidates.length > 0) {
    return "smart";
  }

  const byCapabilities = await pickBestProviderModelByCapabilities(
    paths,
    { requiredInput: ["text"], requiredOutput: ["text"] },
    "llm"
  );
  if (byCapabilities) {
    return byCapabilities;
  }
  return null;
}

async function streamResponse(
  reply: FastifyReply,
  response: { statusCode: number; headers: Record<string, string | string[]>; body: NodeJS.ReadableStream }
): Promise<{ bytes: number; text?: string; contentType: string }> {
  const headers = normalizeHeaders(response.headers);
  if (!headers["content-type"]) {
    headers["content-type"] = "text/event-stream";
  }
  headers["cache-control"] = headers["cache-control"] ?? "no-cache";
  const contentType = headers["content-type"] ?? "application/octet-stream";
  startCaptureStreamResponse(reply, headers, contentType);

  const chunks: Buffer[] = [];
  const captureTap = new Transform({
    transform(chunk, _enc, cb) {
      const asBuffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      chunks.push(asBuffer);
      appendCaptureStreamChunk(reply, asBuffer, { contentType, headers });
      cb(null, chunk);
    },
  });

  reply.raw.writeHead(response.statusCode, headers);
  await new Promise<void>((resolve, reject) => {
    pipeline(response.body, captureTap, reply.raw, (err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
  const buffer = Buffer.concat(chunks);
  const isText = contentType.includes("text/") || contentType.includes("json") || contentType.includes("event-stream");
  setCaptureResponseOverride(
    reply,
    {
      $type: "stream",
      contentType,
      bytes: buffer.byteLength,
      text: isText ? buffer.toString("utf8") : undefined,
    },
    headers
  );
  return {
    bytes: buffer.byteLength,
    text: isText ? buffer.toString("utf8") : undefined,
    contentType,
  };
}

function setHeaders(reply: FastifyReply, headers: Record<string, string | string[]>): void {
  const normalized = normalizeHeaders(headers);
  for (const [key, value] of Object.entries(normalized)) {
    reply.header(key, value);
  }
}

function normalizeHeaders(headers: Record<string, string | string[]>): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      normalized[key.toLowerCase()] = value.join(", ");
    } else {
      normalized[key.toLowerCase()] = value;
    }
  }
  return normalized;
}

async function readBody(
  response: { body: NodeJS.ReadableStream; headers: Record<string, string | string[]> }
): Promise<{
  payload: unknown;
  totalTokens: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
}> {
  const chunks: Buffer[] = [];
  for await (const chunk of response.body) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const buffer = Buffer.concat(chunks);
  const contentType = normalizeHeaders(response.headers)["content-type"] ?? "";
  if (contentType.includes("application/json")) {
    try {
      const payload = JSON.parse(buffer.toString("utf8"));
      const usage = typeof payload === "object" && payload && (
        payload as { usage?: { total_tokens?: number; prompt_tokens?: number; completion_tokens?: number } }
      ).usage;
      return {
        payload,
        totalTokens: usage?.total_tokens ?? null,
        promptTokens: usage?.prompt_tokens ?? null,
        completionTokens: usage?.completion_tokens ?? null,
      };
    } catch {
      return { payload: buffer, totalTokens: null, promptTokens: null, completionTokens: null };
    }
  }
  return { payload: buffer, totalTokens: null, promptTokens: null, completionTokens: null };
}

function buildLog(
  requestId: string,
  body: ChatBody,
  outcome: { attempt: { endpoint: { id: string; name: string }; upstreamModel: string; response: { statusCode: number } } },
  latencyMs: number,
  totalTokens?: number | null
): RequestLog {
  return {
    requestId,
    ts: new Date(),
    route: {
      publicModel: body.model,
      endpointId: outcome.attempt.endpoint.id,
      endpointName: outcome.attempt.endpoint.name,
      upstreamModel: outcome.attempt.upstreamModel
    },
    request: { stream: Boolean(body.stream), maxTokens: body.max_tokens },
    result: {
      statusCode: outcome.attempt.response.statusCode,
      latencyMs,
      totalTokens: totalTokens ?? null
    }
  };
}
