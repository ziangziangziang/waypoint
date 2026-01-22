import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { listEndpoints, createEndpoint, updateEndpoint, getEndpointByIdOrName } from "../storage/repositories";
import { EndpointDoc, ModelMapping } from "../types";
import { Agent, request } from "undici";
import { StoragePaths } from "../storage/files";
import { resolveModelMappings } from "../utils/modelDiscovery";

interface AdminEnv {
  adminToken?: string;
}

interface EndpointPayload {
  name: string;
  baseUrl: string;
  apiKey?: string;
  insecureTls?: boolean;
  priority?: number;
  weight?: number;
  type?: EndpointDoc["type"];
  models?: ModelMapping[];
  limits?: EndpointDoc["limits"];
}

export async function registerAdminRoutes(app: FastifyInstance, paths: StoragePaths, env: AdminEnv): Promise<void> {
  app.addHook("onRequest", async (req, reply) => {
    if (!req.url.startsWith("/admin")) {
      return;
    }
    if (!isAuthorized(req, env.adminToken)) {
      reply.code(401).send({ error: { message: "Unauthorized" } });
      return reply;
    }
  });

  app.get("/admin/endpoints", async (_req, reply) => {
    const endpoints = await listEndpoints(paths);
    reply.send(endpoints);
  });

  app.post("/admin/endpoints", async (req, reply) => {
    const body = req.body as EndpointPayload | undefined;
    if (!body?.name || !body.baseUrl) {
      reply.code(400).send({ error: { message: "name and baseUrl are required" } });
      return;
    }
    const models = await resolveModelMappings(
      {
        baseUrl: body.baseUrl,
        apiKey: body.apiKey,
        insecureTls: body.insecureTls ?? false
      },
      body.models ?? []
    );
    const endpoint = await createEndpoint(paths, {
      name: body.name,
      baseUrl: body.baseUrl,
      apiKey: body.apiKey,
      insecureTls: body.insecureTls ?? false,
      priority: body.priority ?? 0,
      weight: body.weight,
      type: body.type ?? "llm",
      models,
      limits: body.limits
    });
    reply.code(201).send(endpoint);
  });

  app.patch("/admin/endpoints/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as Partial<EndpointPayload> | undefined;
    if (!body) {
      reply.code(400).send({ error: { message: "payload required" } });
      return;
    }
    const endpoint = await updateEndpoint(paths, id, body as Partial<EndpointDoc>);
    if (!endpoint) {
      reply.code(404).send({ error: { message: "endpoint not found" } });
      return;
    }
    reply.send(endpoint);
  });

  app.post("/admin/endpoints/:id/test", async (req, reply) => {
    const { id } = req.params as { id: string };
    const endpoint = await getEndpointByIdOrName(paths, id);
    if (!endpoint) {
      reply.code(404).send({ error: { message: "endpoint not found" } });
      return;
    }
    const start = Date.now();
    try {
      const dispatcher = endpoint.insecureTls
        ? new Agent({ connect: { rejectUnauthorized: false } })
        : undefined;
      const response = await request(new URL("/v1/models", endpoint.baseUrl).toString(), {
        method: "GET",
        headersTimeout: 3000,
        bodyTimeout: 3000,
        dispatcher
      });
      response.body.resume();
      const latency = Date.now() - start;
      reply.send({ status: response.statusCode, latencyMs: latency });
    } catch (error) {
      reply.code(502).send({ error: { message: (error as Error).message } });
    }
  });

  app.get("/admin/health", async (_req, reply) => {
    const endpoints = await listEndpoints(paths);
    reply.send(
      endpoints.map((endpoint) => ({
        id: endpoint.id,
        name: endpoint.name,
        status: endpoint.health.status,
        downUntil: endpoint.health.downUntil,
        lastCheckedAt: endpoint.health.lastCheckedAt,
        latencyMsEwma: endpoint.health.latencyMsEwma
      }))
    );
  });
}

function isAuthorized(req: FastifyRequest, token?: string): boolean {
  if (token) {
    const header = req.headers.authorization ?? "";
    return header === `Bearer ${token}`;
  }
  const remote = req.socket.remoteAddress ?? "";
  return remote === "127.0.0.1" || remote === "::1";
}
