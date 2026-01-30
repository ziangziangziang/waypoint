import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { randomUUID } from "crypto";
import { pipeline } from "stream";
import { routeRequest } from "../routing/router";
import { logRequest, listEligibleEndpoints, sortEndpointsForRouting } from "../storage/repositories";
import { RequestLog, ResponsesApiRequest } from "../types";
import { StoragePaths } from "../storage/files";

/**
 * Responses API compatibility shim.
 * 
 * Some newer SDK flows prefer the "Responses API" pattern. This endpoint
 * translates those requests to /v1/chat/completions internally.
 * 
 * Input formats supported:
 * - { input: "string" } → single user message
 * - { input: [{ role, content }] } → message array
 * - { instructions: "..." } → system message prepended
 */
export async function registerResponsesRoutes(app: FastifyInstance, paths: StoragePaths): Promise<void> {
  app.post("/v1/responses", async (req: FastifyRequest, reply: FastifyReply) => {
    const body = req.body as ResponsesApiRequest | undefined;
    
    if (!body?.model) {
      const fallback = await pickDefaultModel(paths);
      if (!fallback) {
        reply.code(400).send({ error: { message: "model is required" } });
        return;
      }
      if (body) body.model = fallback;
    }

    if (!body?.input) {
      reply.code(400).send({ error: { message: "input is required" } });
      return;
    }

    // Transform to chat completions format
    const messages = transformToMessages(body);
    const chatPayload = {
      model: body.model,
      messages,
      stream: body.stream ?? false,
      temperature: body.temperature,
      max_tokens: body.max_tokens,
      tools: body.tools,
      tool_choice: body.tool_choice
    };

    const requestId = randomUUID();
    const start = Date.now();
    const controller = new AbortController();

    req.raw.on("close", () => controller.abort());

    try {
      const outcome = await routeRequest(
        paths,
        body.model,
        "/v1/chat/completions",
        chatPayload as Record<string, unknown>,
        req.headers as Record<string, string | string[] | undefined>,
        controller.signal
      );

      if (chatPayload.stream) {
        await streamResponse(reply, outcome.attempt.response);
        await logRequest(paths, buildLog(requestId, body.model, outcome, Date.now() - start, true));
        return;
      }

      const upstreamBody = await readBody(outcome.attempt.response);
      
      // Transform response to Responses API format
      const responsesFormat = transformToResponsesFormat(upstreamBody.payload, requestId);
      
      setHeaders(reply, outcome.attempt.response.headers);
      reply.code(outcome.attempt.response.statusCode).send(responsesFormat);
      
      await logRequest(paths, buildLog(
        requestId,
        body.model,
        outcome,
        Date.now() - start,
        false,
        upstreamBody.totalTokens
      ));
    } catch (error) {
      const errorType = (error as { type?: string }).type ?? (error as Error).name;
      await logRequest(paths, {
        requestId,
        ts: new Date(),
        route: { publicModel: body?.model ?? "unknown" },
        request: { stream: Boolean(body?.stream) },
        result: { errorType, errorMessage: (error as Error).message }
      });
      // Don't try to send error if headers already sent (streaming started)
      if (reply.raw.headersSent) {
        req.log.warn({ err: error }, "Error after streaming started");
        reply.raw.end();
        return;
      }
      const status = errorType === "no_endpoints" ? 400 : 502;
      reply.code(status).send({ error: { message: "Upstream unavailable" } });
    }
  });
}

function transformToMessages(body: ResponsesApiRequest): Array<{ role: string; content: string }> {
  const messages: Array<{ role: string; content: string }> = [];
  
  // Add system message from instructions if present
  if (body.instructions) {
    messages.push({ role: "system", content: body.instructions });
  }
  
  // Transform input
  if (typeof body.input === "string") {
    messages.push({ role: "user", content: body.input });
  } else if (Array.isArray(body.input)) {
    messages.push(...body.input);
  }
  
  return messages;
}

function transformToResponsesFormat(chatResponse: unknown, requestId: string): unknown {
  if (!chatResponse || typeof chatResponse !== "object") {
    return chatResponse;
  }
  
  const chat = chatResponse as {
    id?: string;
    choices?: Array<{ message?: { content?: string; role?: string } }>;
    usage?: { total_tokens?: number; prompt_tokens?: number; completion_tokens?: number };
    model?: string;
    created?: number;
  };
  
  const firstChoice = chat.choices?.[0];
  const output = firstChoice?.message?.content ?? "";
  
  return {
    id: chat.id ?? requestId,
    object: "response",
    created_at: chat.created ?? Math.floor(Date.now() / 1000),
    model: chat.model,
    output: [{
      type: "message",
      role: firstChoice?.message?.role ?? "assistant",
      content: [{ type: "text", text: output }]
    }],
    usage: chat.usage ? {
      input_tokens: chat.usage.prompt_tokens ?? 0,
      output_tokens: chat.usage.completion_tokens ?? 0,
      total_tokens: chat.usage.total_tokens ?? 0
    } : undefined
  };
}

async function pickDefaultModel(paths: StoragePaths): Promise<string | null> {
  const endpoints = sortEndpointsForRouting(await listEligibleEndpoints(paths));
  for (const endpoint of endpoints) {
    if (endpoint.type === "llm") {
      const model = endpoint.models[0]?.publicName;
      if (model) return model;
    }
  }
  return null;
}

async function streamResponse(
  reply: FastifyReply,
  response: { statusCode: number; headers: Record<string, string | string[]>; body: NodeJS.ReadableStream }
): Promise<void> {
  const headers = normalizeHeaders(response.headers);
  if (!headers["content-type"]) {
    headers["content-type"] = "text/event-stream";
  }
  headers["cache-control"] = headers["cache-control"] ?? "no-cache";

  reply.raw.writeHead(response.statusCode, headers);
  await new Promise<void>((resolve, reject) => {
    pipeline(response.body, reply.raw, (err) => {
      if (err) reject(err);
      else resolve();
    });
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
    normalized[key.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
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
  model: string,
  outcome: { attempt: { endpoint: { id: string; name: string }; upstreamModel: string; response: { statusCode: number } } },
  latencyMs: number,
  stream: boolean,
  totalTokens?: number | null
): RequestLog {
  return {
    requestId,
    ts: new Date(),
    route: {
      publicModel: model,
      endpointId: outcome.attempt.endpoint.id,
      endpointName: outcome.attempt.endpoint.name,
      upstreamModel: outcome.attempt.upstreamModel
    },
    request: { stream },
    result: {
      statusCode: outcome.attempt.response.statusCode,
      latencyMs,
      totalTokens: totalTokens ?? null
    }
  };
}
