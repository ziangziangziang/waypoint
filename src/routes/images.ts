import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { randomUUID } from "crypto";
import { routeRequest } from "../routing/router";
import { logRequest } from "../storage/repositories";
import { ImageGenerationRequest, RequestLog } from "../types";
import { StoragePaths } from "../storage/files";
import { selectPoolCandidates } from "../pools/scheduler";
import { pickBestProviderModelByCapabilities } from "../providers/modelRegistry";
import { resolveGenerationModel, runImageGeneration } from "../services/imageGeneration";
import { setCaptureError, setCaptureRouting } from "../middleware/requestCapture";

export async function registerImageRoutes(app: FastifyInstance, paths: StoragePaths): Promise<void> {
  // POST /v1/images/generations
  app.post("/v1/images/generations", async (req: FastifyRequest, reply: FastifyReply) => {
    const body = req.body as ImageGenerationRequest | undefined;
    
    if (!body?.prompt) {
      reply.code(400).send({ error: { message: "prompt is required" } });
      return;
    }

    const model = await resolveGenerationModel(paths, body.model);
    if (!model) {
      reply.code(400).send({ error: { message: "No diffusion model available. Add or enable a provider model." } });
      return;
    }

    const requestId = randomUUID();
    const start = Date.now();
    const controller = new AbortController();

    req.raw.on("close", () => controller.abort());

    try {
      const generated = await runImageGeneration(
        paths,
        { ...body, model },
        req.headers as Record<string, string | string[] | undefined>,
        controller.signal
      );
      setHeaders(reply, generated.headers);
      reply.code(generated.statusCode).send(generated.payload);
      setCaptureRouting(reply, {
        publicModel: model,
        endpointId: generated.route.endpointId,
        endpointName: generated.route.endpointName,
        upstreamModel: generated.route.upstreamModel,
      });
      
      await logRequest(paths, buildLog(
        requestId,
        model,
        {
          attempt: {
            endpoint: {
              id: generated.route.endpointId,
              name: generated.route.endpointName,
            },
            upstreamModel: generated.route.upstreamModel,
            response: {
              statusCode: generated.statusCode,
            },
          },
        },
        Date.now() - start,
        false
      ));
    } catch (error) {
      const errorType = (error as { type?: string }).type ?? (error as Error).name;
      setCaptureError(reply, { type: errorType, message: (error as Error).message });
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
      if (errorType === "invalid_request") {
        reply.code(400).send({ error: { message: (error as Error).message } });
        return;
      }
      if (errorType === "tls_verify_failed") {
        reply.code(502).send({ error: { message: (error as Error).message, type: errorType } });
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
        {
          endpointType: "diffusion",
          requiredInput: ["image"],
          requiredOutput: ["image"],
        }
      );

      const upstreamBody = await readBody(outcome.attempt.response);
      setHeaders(reply, outcome.attempt.response.headers);
      reply.code(outcome.attempt.response.statusCode).send(upstreamBody.payload);
      setCaptureRouting(reply, {
        publicModel: model,
        endpointId: outcome.attempt.endpoint.id,
        endpointName: outcome.attempt.endpoint.name,
        upstreamModel: outcome.attempt.upstreamModel,
      });
      
      await logRequest(paths, buildLog(requestId, model, outcome, Date.now() - start, false));
    } catch (error) {
      const errorType = (error as { type?: string }).type ?? (error as Error).name;
      setCaptureError(reply, { type: errorType, message: (error as Error).message });
      await logRequest(paths, {
        requestId,
        ts: new Date(),
        route: { publicModel: model },
        request: { stream: false },
        result: { errorType, errorMessage: (error as Error).message }
      });
      if (errorType === "invalid_request") {
        reply.code(400).send({ error: { message: (error as Error).message } });
        return;
      }
      if (errorType === "tls_verify_failed") {
        reply.code(502).send({ error: { message: (error as Error).message, type: errorType } });
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
      reply.code(status).send({ error: { message: "Image edit unavailable", type: errorType } });
    }
  });

  // POST /v1/images/variations (passthrough)
  app.post("/v1/images/variations", async (req: FastifyRequest, reply: FastifyReply) => {
    const body = req.body as { model?: string } | undefined;

    const model = body?.model ?? await pickDefaultImageEditModel(paths);
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
        {
          endpointType: "diffusion",
          requiredInput: ["image"],
          requiredOutput: ["image"],
        }
      );

      const upstreamBody = await readBody(outcome.attempt.response);
      setHeaders(reply, outcome.attempt.response.headers);
      reply.code(outcome.attempt.response.statusCode).send(upstreamBody.payload);
      setCaptureRouting(reply, {
        publicModel: model,
        endpointId: outcome.attempt.endpoint.id,
        endpointName: outcome.attempt.endpoint.name,
        upstreamModel: outcome.attempt.upstreamModel,
      });
      
      await logRequest(paths, buildLog(requestId, model, outcome, Date.now() - start, false));
    } catch (error) {
      const errorType = (error as { type?: string }).type ?? (error as Error).name;
      setCaptureError(reply, { type: errorType, message: (error as Error).message });
      await logRequest(paths, {
        requestId,
        ts: new Date(),
        route: { publicModel: model },
        request: { stream: false },
        result: { errorType, errorMessage: (error as Error).message }
      });
      if (errorType === "invalid_request") {
        reply.code(400).send({ error: { message: (error as Error).message } });
        return;
      }
      if (errorType === "tls_verify_failed") {
        reply.code(502).send({ error: { message: (error as Error).message, type: errorType } });
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
      reply.code(status).send({ error: { message: "Image variation unavailable", type: errorType } });
    }
  });
}

async function pickDefaultDiffusionModel(paths: StoragePaths): Promise<string | null> {
  const smart = await selectPoolCandidates(paths, "smart", {
    requiredInput: ["text"],
    requiredOutput: ["image"],
  }, {
    operation: "images_generation",
    stream: false,
  });
  if (smart && smart.candidates.length > 0) {
    return "smart";
  }

  const byCapabilities = await pickBestProviderModelByCapabilities(
    paths,
    { requiredInput: ["text"], requiredOutput: ["image"] },
    "diffusion"
  );
  if (byCapabilities) {
    return byCapabilities;
  }
  return null;
}

async function pickDefaultImageEditModel(paths: StoragePaths): Promise<string | null> {
  const smart = await selectPoolCandidates(paths, "smart", {
    requiredInput: ["image", "text"],
    requiredOutput: ["image"],
  }, {
    operation: "images_edits",
    stream: false,
  });
  if (smart && smart.candidates.length > 0) {
    return "smart";
  }

  const byCapabilities = await pickBestProviderModelByCapabilities(
    paths,
    { requiredInput: ["image"], requiredOutput: ["image"] },
    "diffusion"
  );
  if (byCapabilities) {
    return byCapabilities;
  }
  return pickDefaultDiffusionModel(paths);
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
