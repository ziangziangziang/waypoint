import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { randomUUID } from "crypto";
import { pipeline } from "stream";
import { routeRequest } from "../routing/router";
import { logRequest, listEligibleEndpoints, sortEndpointsForRouting } from "../storage/repositories";
import { RequestLog } from "../types";
import { StoragePaths } from "../storage/files";

export async function registerAudioRoutes(app: FastifyInstance, paths: StoragePaths): Promise<void> {
  // POST /v1/audio/transcriptions (speech-to-text)
  app.post("/v1/audio/transcriptions", async (req: FastifyRequest, reply: FastifyReply) => {
    // Multipart form data: file, model, language, prompt, response_format, temperature
    const body = req.body as Record<string, unknown> | undefined;
    
    const model = (body?.model as string) ?? await pickDefaultAudioModel(paths);
    if (!model) {
      reply.code(400).send({ error: { message: "No audio model available. Please add an audio endpoint." } });
      return;
    }

    const requestId = randomUUID();
    const start = Date.now();
    const controller = new AbortController();

    req.raw.on("close", () => controller.abort());

    try {
      const outcome = await routeRequest(
        paths,
        model,
        "/v1/audio/transcriptions",
        body as Record<string, unknown>,
        req.headers as Record<string, string | string[] | undefined>,
        controller.signal,
        "audio"
      );

      const upstreamBody = await readBody(outcome.attempt.response);
      setHeaders(reply, outcome.attempt.response.headers);
      reply.code(outcome.attempt.response.statusCode).send(upstreamBody.payload);
      
      await logRequest(paths, buildLog(
        requestId,
        model,
        outcome,
        Date.now() - start
      ));
    } catch (error) {
      const errorType = (error as { type?: string }).type ?? (error as Error).name;
      await logRequest(paths, {
        requestId,
        ts: new Date(),
        route: { publicModel: model },
        request: { stream: false },
        result: { errorType, errorMessage: (error as Error).message }
      });
      const status = errorType === "no_endpoints" ? 400 : 502;
      reply.code(status).send({ error: { message: "Transcription unavailable", type: errorType } });
    }
  });

  // POST /v1/audio/translations (translation to English)
  app.post("/v1/audio/translations", async (req: FastifyRequest, reply: FastifyReply) => {
    const body = req.body as Record<string, unknown> | undefined;
    
    const model = (body?.model as string) ?? await pickDefaultAudioModel(paths);
    if (!model) {
      reply.code(400).send({ error: { message: "No audio model available" } });
      return;
    }

    const requestId = randomUUID();
    const start = Date.now();
    const controller = new AbortController();

    req.raw.on("close", () => controller.abort());

    try {
      const outcome = await routeRequest(
        paths,
        model,
        "/v1/audio/translations",
        body as Record<string, unknown>,
        req.headers as Record<string, string | string[] | undefined>,
        controller.signal,
        "audio"
      );

      const upstreamBody = await readBody(outcome.attempt.response);
      setHeaders(reply, outcome.attempt.response.headers);
      reply.code(outcome.attempt.response.statusCode).send(upstreamBody.payload);
      
      await logRequest(paths, buildLog(requestId, model, outcome, Date.now() - start));
    } catch (error) {
      const errorType = (error as { type?: string }).type ?? (error as Error).name;
      await logRequest(paths, {
        requestId,
        ts: new Date(),
        route: { publicModel: model },
        request: { stream: false },
        result: { errorType, errorMessage: (error as Error).message }
      });
      reply.code(502).send({ error: { message: "Translation unavailable" } });
    }
  });

  // POST /v1/audio/speech (text-to-speech)
  app.post("/v1/audio/speech", async (req: FastifyRequest, reply: FastifyReply) => {
    const body = req.body as { model?: string; input: string; voice: string; response_format?: string; speed?: number } | undefined;
    
    if (!body?.input || !body?.voice) {
      reply.code(400).send({ error: { message: "input and voice are required" } });
      return;
    }

    const model = body.model ?? await pickDefaultTtsModel(paths);
    if (!model) {
      reply.code(400).send({ error: { message: "No TTS model available. Please add an audio endpoint." } });
      return;
    }

    const requestId = randomUUID();
    const start = Date.now();
    const controller = new AbortController();

    req.raw.on("close", () => controller.abort());

    try {
      const outcome = await routeRequest(
        paths,
        model,
        "/v1/audio/speech",
        { ...body, model } as Record<string, unknown>,
        req.headers as Record<string, string | string[] | undefined>,
        controller.signal,
        "audio"
      );

      // Speech returns binary audio - stream it directly
      await streamResponse(reply, outcome.attempt.response);
      
      await logRequest(paths, buildLog(requestId, model, outcome, Date.now() - start));
    } catch (error) {
      const errorType = (error as { type?: string }).type ?? (error as Error).name;
      await logRequest(paths, {
        requestId,
        ts: new Date(),
        route: { publicModel: model },
        request: { stream: false },
        result: { errorType, errorMessage: (error as Error).message }
      });
      const status = errorType === "no_endpoints" ? 400 : 502;
      reply.code(status).send({ error: { message: "Speech synthesis unavailable", type: errorType } });
    }
  });
}

async function pickDefaultAudioModel(paths: StoragePaths): Promise<string | null> {
  const endpoints = sortEndpointsForRouting(await listEligibleEndpoints(paths));
  for (const endpoint of endpoints) {
    if (endpoint.type === "audio") {
      // Look for whisper-like model names
      const model = endpoint.models.find(m => 
        m.publicName.toLowerCase().includes("whisper") ||
        m.publicName.toLowerCase().includes("transcription")
      )?.publicName ?? endpoint.models[0]?.publicName;
      if (model) {
        return model;
      }
    }
  }
  return null;
}

async function pickDefaultTtsModel(paths: StoragePaths): Promise<string | null> {
  const endpoints = sortEndpointsForRouting(await listEligibleEndpoints(paths));
  for (const endpoint of endpoints) {
    if (endpoint.type === "audio") {
      // Look for TTS-like model names
      const model = endpoint.models.find(m => 
        m.publicName.toLowerCase().includes("tts") ||
        m.publicName.toLowerCase().includes("speech")
      )?.publicName ?? endpoint.models[0]?.publicName;
      if (model) {
        return model;
      }
    }
  }
  return null;
}

async function streamResponse(
  reply: FastifyReply,
  response: { statusCode: number; headers: Record<string, string | string[]>; body: NodeJS.ReadableStream }
): Promise<void> {
  const headers = normalizeHeaders(response.headers);
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

async function readBody(response: { body: NodeJS.ReadableStream; headers: Record<string, string | string[]> }): Promise<{ payload: unknown }> {
  const chunks: Buffer[] = [];
  for await (const chunk of response.body) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const buffer = Buffer.concat(chunks);
  const contentType = normalizeHeaders(response.headers)["content-type"] ?? "";
  if (contentType.includes("application/json")) {
    try {
      return { payload: JSON.parse(buffer.toString("utf8")) };
    } catch {
      return { payload: buffer };
    }
  }
  return { payload: buffer };
}

function buildLog(
  requestId: string,
  model: string,
  outcome: { attempt: { endpoint: { id: string; name: string }; upstreamModel: string; response: { statusCode: number } } },
  latencyMs: number
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
    request: { stream: false },
    result: {
      statusCode: outcome.attempt.response.statusCode,
      latencyMs,
      totalTokens: null
    }
  };
}
