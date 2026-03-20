import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { randomUUID } from "crypto";
import { pipeline } from "stream";
import { routeRequest } from "../routing/router";
import { logRequest } from "../storage/repositories";
import { RequestLog, ResponsesApiRequest } from "../types";
import { StoragePaths } from "../storage/files";
import { selectPoolCandidates } from "../pools/scheduler";
import { pickBestProviderModelByCapabilities } from "../providers/modelRegistry";
import { normalizeMessagesForUpstream, scanMessageModalities } from "../utils/messageMedia";
import { setCaptureDerivedRequest, setCaptureError, setCaptureResponseOverride, setCaptureRouting } from "../middleware/requestCapture";
import { setStatsPayload } from "../middleware/requestStats";

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
    
    const transformedTools = body.tools ? transformTools(body.tools) : undefined;
    
    // Track if client wants streaming
    const clientWantsStreaming = body.stream ?? false;
    
    const normalizedMessages = await normalizeMessagesForUpstream(paths, messages);
    const media = scanMessageModalities(normalizedMessages);

    const chatPayload = {
      model: body.model,
      messages: normalizedMessages,
      stream: clientWantsStreaming, // Pass through streaming preference
      temperature: body.temperature,
      max_tokens: body.max_tokens,
      tools: transformedTools,
      tool_choice: body.tool_choice
    };
    setCaptureDerivedRequest(reply, {
      originalRequest: body,
      normalizedRequest: chatPayload,
    });

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

      // Handle streaming response
      if (clientWantsStreaming) {
        await streamResponsesAPI(reply, outcome.attempt.response, requestId, body.model);
        setCaptureResponseOverride(
          reply,
          {
            $type: "stream",
            contentType: "text/event-stream",
            note: "Responses API SSE stream captured as metadata",
          },
          outcome.attempt.response.headers
        );
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
        await logRequest(paths, buildLog(
          requestId,
          body.model,
          outcome,
          Date.now() - start,
          true,
          0 // Token count not available in streaming
        ));
        return;
      }

      // Non-streaming response
      const upstreamBody = await readBody(outcome.attempt.response);
      
      // Transform response to Responses API format
      const responsesFormat = transformToResponsesFormat(upstreamBody.payload, requestId);
      
      setHeaders(reply, outcome.attempt.response.headers);
      reply.code(outcome.attempt.response.statusCode).send(responsesFormat);
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
      setCaptureError(reply, { type: errorType, message: (error as Error).message });
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
      if (errorType === "invalid_request") {
        reply.code(400).send({ error: { message: (error as Error).message } });
        return;
      }
      if (errorType === "tls_verify_failed") {
        reply.code(502).send({ error: { message: (error as Error).message } });
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
      reply.code(status).send({ error: { message: "Upstream unavailable" } });
    }
  });
}

/**
 * Transform Responses-style input to OpenAI chat completions messages.
 * 
 * Some clients send a variety of item types:
 * - { type: "message", role: "user/assistant/developer", content: [...] }
 * - { type: "function_call", name: "...", arguments: "...", call_id: "..." }
 * - { type: "function_call_output", call_id: "...", output: "..." }
 * 
 * OpenAI chat completions expects:
 * - { role: "user/assistant/system", content: "..." }
 * - Assistant messages can have tool_calls: [{ id, type: "function", function: { name, arguments } }]
 * - { role: "tool", tool_call_id: "...", content: "..." }
 */
function transformToMessages(body: ResponsesApiRequest): Array<Record<string, unknown>> {
  const messages: Array<Record<string, unknown>> = [];
  
  // Add system message from instructions if present
  if (body.instructions) {
    messages.push({ role: "system", content: body.instructions });
  }
  
  // Transform input
  if (typeof body.input === "string") {
    messages.push({ role: "user", content: body.input });
  } else if (Array.isArray(body.input)) {
    // Process items, grouping consecutive function_calls into a single assistant message
    let pendingToolCalls: Array<{ id: string; type: string; function: { name: string; arguments: string } }> = [];
    
    for (const item of body.input) {
      if (!item || typeof item !== "object") continue;
      
      const itemObj = item as Record<string, unknown>;
      const itemType = itemObj.type as string;
      
      // Handle function_call items - need to be grouped into an assistant message
      if (itemType === "function_call") {
        pendingToolCalls.push({
          id: (itemObj.call_id as string) || (itemObj.id as string) || "",
          type: "function",
          function: {
            name: itemObj.name as string,
            arguments: itemObj.arguments as string
          }
        });
        continue;
      }
      
      // Before processing other items, flush any pending tool calls
      if (pendingToolCalls.length > 0) {
        messages.push({
          role: "assistant",
          content: null,
          tool_calls: pendingToolCalls
        });
        pendingToolCalls = [];
      }
      
      // Handle function_call_output items - become tool role messages
      if (itemType === "function_call_output") {
        messages.push({
          role: "tool",
          tool_call_id: itemObj.call_id as string,
          content: typeof itemObj.output === "string" ? itemObj.output : JSON.stringify(itemObj.output)
        });
        continue;
      }
      
      // Handle regular message items
      if (itemType === "message" && "role" in itemObj && "content" in itemObj) {
        const role = itemObj.role as string;
        // Map developer role to system
        const mappedRole = role === "developer" ? "system" : role;
        const content = transformMessageContent(itemObj.content);
        messages.push({ role: mappedRole, content });
        continue;
      }
      
      // Handle items with role/content directly (legacy format)
      if ("role" in itemObj && "content" in itemObj) {
        const role = itemObj.role as string;
        const mappedRole = role === "developer" ? "system" : role;
        const content = transformMessageContent(itemObj.content);
        messages.push({ role: mappedRole, content });
        continue;
      }
    }
    
    // Flush any remaining pending tool calls
    if (pendingToolCalls.length > 0) {
      messages.push({
        role: "assistant",
        content: null,
        tool_calls: pendingToolCalls
      });
    }
  }
  
  return messages;
}

/**
 * Transform message content, normalizing response content part types to OpenAI format.
 * Some clients send: { type: "input_text", text: "..." } for user messages
 * Some clients send: { type: "output_text", text: "..." } for assistant messages
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
        // Normalize input_text/output_text to OpenAI text
        // input_text is typically user content, output_text assistant content
        if (p.type === "input_text" || p.type === "output_text") {
          return { ...p, type: "text" };
        }
        if (p.type === "input_image" && p.image_url) {
          return { ...p, type: "image_url" };
        }
        // Accept shorthand {type:\"audio\", audio:\"...\"} and normalize downstream
        if (p.type === "input_audio" || p.type === "audio" || p.type === "video") {
          return p;
        }
      }
      return part;
    });
  }
  
  // Fallback: return as array containing the original content
  return [content];
}

/**
 * Transform Responses-style tools to OpenAI function-calling format.
 * 
 * Some clients send tools like:
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
      // Responses-style clients may expect output_text instead of text
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
 * Stream chat completions response and transform to Responses API SSE format.
 * 
 * This reads the upstream SSE stream (chat.completion.chunk format) and
 * transforms it to Responses API format in real-time.
 */
async function streamResponsesAPI(
  reply: FastifyReply, 
  upstreamResponse: { body: ReadableStream<Uint8Array> | NodeJS.ReadableStream | null },
  requestId: string,
  model: string
): Promise<void> {
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive"
  });

  const sendEvent = (eventType: string, data: unknown) => {
    reply.raw.write(`event: ${eventType}\n`);
    reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  // Send response.created immediately
  sendEvent("response.created", {
    type: "response.created",
    response: {
      id: requestId,
      object: "response",
      created_at: Math.floor(Date.now() / 1000),
      model,
      output: [],
      usage: null
    }
  });

  // Accumulate content and tool calls for the final response
  let accumulatedContent = "";
  let accumulatedToolCalls: Array<{
    id: string;
    name: string;
    arguments: string;
  }> = [];
  let usage: { input_tokens: number; output_tokens: number; total_tokens: number } | null = null;
  let currentToolCallIndex = -1;

  try {
    const body = upstreamResponse.body;
    if (!body) {
      throw new Error("No response body");
    }

    // Convert to async iterable
    const reader = 'getReader' in body 
      ? body.getReader() 
      : null;
    
    let buffer = "";
    
    const processChunk = (text: string) => {
      buffer += text;
      const lines = buffer.split("\n");
      buffer = lines.pop() || ""; // Keep incomplete line in buffer
      
      for (const line of lines) {
        if (line.startsWith("data: ")) {
          const data = line.slice(6).trim();
          if (data === "[DONE]") {
            continue;
          }
          try {
            const chunk = JSON.parse(data);
            const delta = chunk.choices?.[0]?.delta;
            
            if (delta) {
              // Handle reasoning/thinking content delta
              if (delta.reasoning_content || delta.reasoning) {
                const reasoningDelta = delta.reasoning_content || delta.reasoning;
                // Send reasoning delta event
                sendEvent("response.reasoning_text.delta", {
                  type: "response.reasoning_text.delta",
                  output_index: 0,
                  content_index: 0,
                  delta: reasoningDelta
                });
              }
              
              // Handle content delta
              if (delta.content) {
                accumulatedContent += delta.content;
                // Send content delta event
                sendEvent("response.output_text.delta", {
                  type: "response.output_text.delta",
                  output_index: 0,
                  content_index: 0,
                  delta: delta.content
                });
              }
              
              // Handle tool calls delta
              if (delta.tool_calls) {
                for (const toolCallDelta of delta.tool_calls) {
                  const idx = toolCallDelta.index;
                  if (idx !== currentToolCallIndex) {
                    currentToolCallIndex = idx;
                    accumulatedToolCalls[idx] = {
                      id: toolCallDelta.id || "",
                      name: toolCallDelta.function?.name || "",
                      arguments: ""
                    };
                  }
                  if (toolCallDelta.id) {
                    accumulatedToolCalls[idx].id = toolCallDelta.id;
                  }
                  if (toolCallDelta.function?.name) {
                    accumulatedToolCalls[idx].name = toolCallDelta.function.name;
                  }
                  if (toolCallDelta.function?.arguments) {
                    accumulatedToolCalls[idx].arguments += toolCallDelta.function.arguments;
                  }
                }
              }
            }
            
            // Capture usage from final chunk
            if (chunk.usage) {
              usage = {
                input_tokens: chunk.usage.prompt_tokens ?? 0,
                output_tokens: chunk.usage.completion_tokens ?? 0,
                total_tokens: chunk.usage.total_tokens ?? 0
              };
            }
          } catch (e) {
            // Ignore parse errors for malformed chunks
          }
        }
      }
    };

    if (reader) {
      // Web Streams API (ReadableStream)
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        processChunk(decoder.decode(value, { stream: true }));
      }
    } else {
      // Node.js stream
      const nodeStream = body as NodeJS.ReadableStream;
      for await (const chunk of nodeStream) {
        processChunk(chunk.toString());
      }
    }

    // Build final output
    const output: ResponsesApiResponse["output"] = [];
    
    // Add tool calls first
    for (const tc of accumulatedToolCalls) {
      if (tc) {
        output.push({
          type: "function_call",
          id: tc.id,
          call_id: tc.id,
          name: tc.name,
          arguments: tc.arguments
        });
        // Send output_item.done for each tool call
        sendEvent("response.output_item.done", {
          type: "response.output_item.done",
          output_index: output.length - 1,
          item: output[output.length - 1]
        });
      }
    }
    
    // Add message content if any
    if (accumulatedContent || output.length === 0) {
      output.push({
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: accumulatedContent }]
      });
      // Send output_item.done for the message
      sendEvent("response.output_item.done", {
        type: "response.output_item.done",
        output_index: output.length - 1,
        item: output[output.length - 1]
      });
    }

    // Send response.completed
    sendEvent("response.completed", {
      type: "response.completed",
      response: {
        id: requestId,
        object: "response",
        created_at: Math.floor(Date.now() / 1000),
        model,
        output,
        usage
      }
    });

  } catch (error) {
    console.error("[responses] Streaming error:", error);
    // Send error as part of the stream
    sendEvent("error", {
      type: "error",
      error: { message: (error as Error).message }
    });
  }

  reply.raw.end();
}

/**
 * Send response as Server-Sent Events in Responses format.
 * 
 * Responses-style clients expect:
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
