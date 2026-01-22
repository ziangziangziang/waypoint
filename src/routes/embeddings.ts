import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { randomUUID } from "crypto";
import { routeRequest } from "../routing/router";
import { logRequest } from "../storage/repositories";
import { RequestLog } from "../types";
import { StoragePaths } from "../storage/files";

interface EmbeddingsBody {
  model: string;
  input: string | string[];
  [key: string]: unknown;
}

export async function registerEmbeddingsRoutes(app: FastifyInstance, paths: StoragePaths): Promise<void> {
  app.post("/v1/embeddings", async (req: FastifyRequest, reply: FastifyReply) => {
    const body = req.body as EmbeddingsBody | undefined;
    if (!body?.model) {
      reply.code(400).send({ error: { message: "model is required" } });
      return;
    }

    const requestId = randomUUID();
    const start = Date.now();
    const controller = new AbortController();

    req.raw.on("close", () => controller.abort());

    try {
      const outcome = await routeRequest(
        paths,
        body.model,
        "/v1/embeddings",
        body as Record<string, unknown>,
        req.headers as Record<string, string | string[] | undefined>,
        controller.signal
      );

      const upstreamBody = await readBody(outcome.attempt.response);
      setHeaders(reply, outcome.attempt.response.headers);
      reply.code(outcome.attempt.response.statusCode).send(upstreamBody.payload);
      await logRequest(paths, buildLog(requestId, body, outcome, Date.now() - start, upstreamBody.totalTokens));
    } catch (error) {
      const errorType = (error as { type?: string }).type ?? (error as Error).name;
      await logRequest(paths, {
        requestId,
        ts: new Date(),
        route: { publicModel: body?.model ?? "unknown" },
        request: { stream: false },
        result: {
          errorType,
          errorMessage: (error as Error).message
        }
      });
      const status = errorType === "no_endpoints" ? 400 : 502;
      reply.code(status).send({ error: { message: "Upstream unavailable" } });
    }
  });
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

async function readBody(response: { body: NodeJS.ReadableStream; headers: Record<string, string | string[]> }): Promise<{ payload: unknown; totalTokens: number | null }> {
  const chunks: Buffer[] = [];
  for await (const chunk of response.body) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const buffer = Buffer.concat(chunks);
  const contentType = normalizeHeaders(response.headers)["content-type"] ?? "";
  if (contentType.includes("application/json")) {
    try {
      const payload = JSON.parse(buffer.toString("utf8"));
      const usage = typeof payload === "object" && payload && (payload as { usage?: { total_tokens?: number } }).usage;
      return { payload, totalTokens: usage?.total_tokens ?? null };
    } catch {
      return { payload: buffer, totalTokens: null };
    }
  }
  return { payload: buffer, totalTokens: null };
}

function buildLog(
  requestId: string,
  body: EmbeddingsBody,
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
    request: { stream: false },
    result: {
      statusCode: outcome.attempt.response.statusCode,
      latencyMs,
      totalTokens: totalTokens ?? null
    }
  };
}
