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
    
    // DEBUG: Log request details
    console.log("[responses] Request:", {
      model: body?.model,
      hasTools: !!body?.tools,
      toolCount: body?.tools?.length,
      stream: body?.stream,
      inputType: typeof body?.input
    });
    
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
    
    // DEBUG: Log incoming tools
    if (body.tools) {
      console.log("[responses] Incoming tools:", JSON.stringify(body.tools).substring(0, 500));
    }
    
    const transformedTools = body.tools ? transformTools(body.tools) : undefined;
    
    // DEBUG: Log transformed tools
    if (transformedTools) {
      console.log("[responses] Transformed tools:", JSON.stringify(transformedTools).substring(0, 500));
    }
    
    // Track if client wants streaming - we'll convert the response to SSE format
    const clientWantsStreaming = body.stream ?? false;
    
    // Always fetch non-streaming from upstream, then convert to SSE if needed
    const chatPayload = {
      model: body.model,
      messages,
      stream: false,
      temperature: body.temperature,
      max_tokens: body.max_tokens,
      tools: transformedTools,
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

      const upstreamBody = await readBody(outcome.attempt.response);
      
      // Transform response to Responses API format
      const responsesFormat = transformToResponsesFormat(upstreamBody.payload, requestId);
      
      // If client wants streaming, send as proper SSE events (Codex format)
      if (clientWantsStreaming) {
        await sendAsSSE(reply, responsesFormat as ResponsesApiResponse);
        await logRequest(paths, buildLog(
          requestId,
          body.model,
          outcome,
          Date.now() - start,
          true,
          upstreamBody.totalTokens
        ));
        return;
      }
      
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

function transformToMessages(body: ResponsesApiRequest): Array<{ role: string; content: string | unknown[] }> {
  const messages: Array<{ role: string; content: string | unknown[] }> = [];
  
  // Add system message from instructions if present
  if (body.instructions) {
    messages.push({ role: "system", content: body.instructions });
  }
  
  // Transform input
  if (typeof body.input === "string") {
    messages.push({ role: "user", content: body.input });
  } else if (Array.isArray(body.input)) {
    // Transform each message, fixing content part types
    for (const msg of body.input) {
      if (msg && typeof msg === "object" && "role" in msg && "content" in msg) {
        const content = transformMessageContent(msg.content);
        messages.push({ role: msg.role as string, content });
      } else {
        messages.push(msg);
      }
    }
  }
  
  return messages;
}

/**
 * Transform message content, fixing Codex content part types to OpenAI format.
 * Codex sends: { type: "input_text", text: "..." }
 * OpenAI expects: { type: "text", text: "..." }
 */
function transformMessageContent(content: unknown): string | unknown[] {
  if (typeof content === "string") {
    return content;
  }
  
  if (Array.isArray(content)) {
    return content.map(part => {
      if (part && typeof part === "object") {
        const p = part as Record<string, unknown>;
        // Fix Codex input_text → OpenAI text
        if (p.type === "input_text") {
          return { ...p, type: "text" };
        }
      }
      return part;
    });
  }
  
  // Fallback: return as array containing the original content
  return [content];
}

/**
 * Transform Codex-style tools to OpenAI function calling format.
 * 
 * Codex sends tools like:
 *   { type: "function", name: "...", description: "...", parameters: {...} }
 * 
 * OpenAI expects:
 *   { type: "function", function: { name: "...", description: "...", parameters: {...} } }
 * 
 * Special case: web_search tools are filtered out as they're not supported by OpenAI format.
 */
function transformTools(tools: unknown[]): unknown[] {
  return tools
    .filter(tool => {
      // Filter out web_search tools - not supported in OpenAI function calling format
      if (tool && typeof tool === "object") {
        const t = tool as Record<string, unknown>;
        if (t.type === "web_search") {
          return false;
        }
      }
      return true;
    })
    .map(tool => {
      if (!tool || typeof tool !== "object") return tool;
      
      const t = tool as Record<string, unknown>;
      
      // If already in OpenAI format (has 'function' property), return as-is
      if (t.function) return tool;
      
      // If has type="function" but no 'function' wrapper, wrap it
      if (t.type === "function") {
        const { type, ...functionDef } = t;
        return {
          type,
          function: functionDef
        };
      }
      
      // Otherwise return unchanged
      return tool;
    });
}

/**
 * Response object structure for SSE serialization
 */
interface ResponsesApiResponse {
  id: string;
  object: string;
  created_at: number;
  model?: string;
  output: Array<{
    type: string;
    role?: string;
    content?: Array<{ type: string; text?: string }>;
    id?: string;
    name?: string;
    arguments?: string;
    call_id?: string;
  }>;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
  };
}

function transformToResponsesFormat(chatResponse: unknown, requestId: string): ResponsesApiResponse {
  if (!chatResponse || typeof chatResponse !== "object") {
    return {
      id: requestId,
      object: "response",
      created_at: Math.floor(Date.now() / 1000),
      output: []
    };
  }
  
  const chat = chatResponse as {
    id?: string;
    choices?: Array<{ 
      message?: { 
        content?: string; 
        role?: string;
        tool_calls?: Array<{
          id: string;
          type: string;
          function: { name: string; arguments: string };
        }>;
      } 
    }>;
    usage?: { total_tokens?: number; prompt_tokens?: number; completion_tokens?: number };
    model?: string;
    created?: number;
  };
  
  const firstChoice = chat.choices?.[0];
  const message = firstChoice?.message;
  const output: ResponsesApiResponse["output"] = [];
  
  // Handle tool calls if present
  if (message?.tool_calls && message.tool_calls.length > 0) {
    for (const toolCall of message.tool_calls) {
      output.push({
        type: "function_call",
        id: toolCall.id,
        call_id: toolCall.id,
        name: toolCall.function.name,
        arguments: toolCall.function.arguments
      });
    }
  }
  
  // Handle text content
  const textContent = message?.content ?? "";
  if (textContent || output.length === 0) {
    output.push({
      type: "message",
      role: message?.role ?? "assistant",
      // Codex expects "output_text" type, not "text"
      content: [{ type: "output_text", text: textContent }]
    });
  }
  
  return {
    id: chat.id ?? requestId,
    object: "response",
    created_at: chat.created ?? Math.floor(Date.now() / 1000),
    model: chat.model,
    output,
    usage: chat.usage ? {
      input_tokens: chat.usage.prompt_tokens ?? 0,
      output_tokens: chat.usage.completion_tokens ?? 0,
      total_tokens: chat.usage.total_tokens ?? 0
    } : undefined
  };
}

/**
 * Send response as Server-Sent Events in Codex format.
 * 
 * Codex expects:
 * - event: response.created
 * - event: response.output_item.done (for each output item)
 * - event: response.completed
 * 
 * Each event has:
 * - event: <event_type>
 * - data: {"type":"<event_type>", ...payload}
 */
async function sendAsSSE(reply: FastifyReply, response: ResponsesApiResponse): Promise<void> {
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive"
  });

  // Helper to send an SSE event
  const sendEvent = (eventType: string, data: unknown) => {
    reply.raw.write(`event: ${eventType}\n`);
    reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  // 1. response.created
  sendEvent("response.created", {
    type: "response.created",
    response: {
      id: response.id,
      object: response.object,
      created_at: response.created_at,
      model: response.model,
      output: [],
      usage: null
    }
  });

  // 2. response.output_item.done for each output item
  for (let i = 0; i < response.output.length; i++) {
    const item = response.output[i];
    sendEvent("response.output_item.done", {
      type: "response.output_item.done",
      output_index: i,
      item
    });
  }

  // 3. response.completed
  sendEvent("response.completed", {
    type: "response.completed",
    response: {
      id: response.id,
      object: response.object,
      created_at: response.created_at,
      model: response.model,
      output: response.output,
      usage: response.usage
    }
  });

  reply.raw.end();
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
