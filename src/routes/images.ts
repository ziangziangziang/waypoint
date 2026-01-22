import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { randomUUID } from "crypto";
import { pipeline } from "stream";
import { routeRequest } from "../routing/router";
import { logRequest, listEligibleEndpoints, sortEndpointsForRouting } from "../storage/repositories";
import { ImageGenerationRequest, RequestLog } from "../types";
import { StoragePaths } from "../storage/files";

export async function registerImageRoutes(app: FastifyInstance, paths: StoragePaths): Promise<void> {
  // POST /v1/images/generations
  app.post("/v1/images/generations", async (req: FastifyRequest, reply: FastifyReply) => {
    const body = req.body as ImageGenerationRequest | undefined;
    
    if (!body?.prompt) {
      reply.code(400).send({ error: { message: "prompt is required" } });
      return;
    }

    const model = body.model ?? await pickDefaultDiffusionModel(paths);
    if (!model) {
      reply.code(400).send({ error: { message: "No diffusion model available. Please add a diffusion endpoint." } });
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
        "/v1/images/generations",
        { ...body, model } as Record<string, unknown>,
        req.headers as Record<string, string | string[] | undefined>,
        controller.signal,
        "diffusion"
      );

      const upstreamBody = await readBody(outcome.attempt.response);
      setHeaders(reply, outcome.attempt.response.headers);
      reply.code(outcome.attempt.response.statusCode).send(upstreamBody.payload);
      
      await logRequest(paths, buildLog(
        requestId,
        model,
        outcome,
        Date.now() - start,
        false
      ));
    } catch (error) {
      const errorType = (error as { type?: string }).type ?? (error as Error).name;
      await logRequest(paths, {
        requestId,
        ts: new Date(),
        route: { publicModel: model },
        request: { stream: false },
        result: {
          errorType,
          errorMessage: (error as Error).message
        }
      });
      const status = errorType === "no_endpoints" ? 400 : 502;
      reply.code(status).send({ error: { message: "Image generation unavailable", type: errorType } });
    }
  });

  // POST /v1/images/edits (passthrough)
  app.post("/v1/images/edits", async (req: FastifyRequest, reply: FastifyReply) => {
    const body = req.body as { model?: string; prompt: string } | undefined;
    
    if (!body?.prompt) {
      reply.code(400).send({ error: { message: "prompt is required" } });
      return;
    }

    const model = body.model ?? await pickDefaultDiffusionModel(paths);
    if (!model) {
      reply.code(400).send({ error: { message: "No diffusion model available" } });
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
        "/v1/images/edits",
        body as Record<string, unknown>,
        req.headers as Record<string, string | string[] | undefined>,
        controller.signal,
        "diffusion"
      );

      const upstreamBody = await readBody(outcome.attempt.response);
      setHeaders(reply, outcome.attempt.response.headers);
      reply.code(outcome.attempt.response.statusCode).send(upstreamBody.payload);
      
      await logRequest(paths, buildLog(requestId, model, outcome, Date.now() - start, false));
    } catch (error) {
      const errorType = (error as { type?: string }).type ?? (error as Error).name;
      await logRequest(paths, {
        requestId,
        ts: new Date(),
        route: { publicModel: model },
        request: { stream: false },
        result: { errorType, errorMessage: (error as Error).message }
      });
      reply.code(502).send({ error: { message: "Image edit unavailable" } });
    }
  });

  // POST /v1/images/variations (passthrough)
  app.post("/v1/images/variations", async (req: FastifyRequest, reply: FastifyReply) => {
    const body = req.body as { model?: string } | undefined;

    const model = body?.model ?? await pickDefaultDiffusionModel(paths);
    if (!model) {
      reply.code(400).send({ error: { message: "No diffusion model available" } });
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
        "/v1/images/variations",
        (body ?? {}) as Record<string, unknown>,
        req.headers as Record<string, string | string[] | undefined>,
        controller.signal,
        "diffusion"
      );

      const upstreamBody = await readBody(outcome.attempt.response);
      setHeaders(reply, outcome.attempt.response.headers);
      reply.code(outcome.attempt.response.statusCode).send(upstreamBody.payload);
      
      await logRequest(paths, buildLog(requestId, model, outcome, Date.now() - start, false));
    } catch (error) {
      const errorType = (error as { type?: string }).type ?? (error as Error).name;
      await logRequest(paths, {
        requestId,
        ts: new Date(),
        route: { publicModel: model },
        request: { stream: false },
        result: { errorType, errorMessage: (error as Error).message }
      });
      reply.code(502).send({ error: { message: "Image variation unavailable" } });
    }
  });
}

async function pickDefaultDiffusionModel(paths: StoragePaths): Promise<string | null> {
  const endpoints = sortEndpointsForRouting(await listEligibleEndpoints(paths));
  for (const endpoint of endpoints) {
    if (endpoint.type === "diffusion") {
      const model = endpoint.models[0]?.publicName;
      if (model) {
        return model;
      }
    }
  }
  return null;
}

function setHeaders(reply: FastifyReply, headers: Record<string, string | string[]>): void {
  for (const [key, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      reply.header(key.toLowerCase(), value.join(", "));
    } else {
      reply.header(key.toLowerCase(), value);
    }
  }
}

async function readBody(response: { body: NodeJS.ReadableStream; headers: Record<string, string | string[]> }): Promise<{ payload: unknown }> {
  const chunks: Buffer[] = [];
  for await (const chunk of response.body) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const buffer = Buffer.concat(chunks);
  const contentType = normalizeContentType(response.headers);
  if (contentType.includes("application/json")) {
    try {
      return { payload: JSON.parse(buffer.toString("utf8")) };
    } catch {
      return { payload: buffer };
    }
  }
  return { payload: buffer };
}

function normalizeContentType(headers: Record<string, string | string[]>): string {
  const ct = headers["content-type"] ?? headers["Content-Type"];
  if (Array.isArray(ct)) return ct.join(", ");
  return ct ?? "";
}

function buildLog(
  requestId: string,
  model: string,
  outcome: { attempt: { endpoint: { id: string; name: string }; upstreamModel: string; response: { statusCode: number } } },
  latencyMs: number,
  stream: boolean
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
      totalTokens: null
    }
  };
}
