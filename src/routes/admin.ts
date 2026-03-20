import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { StoragePaths } from "../storage/files";
import {
  deleteProvider,
  deleteProviderModel,
  getEffectiveModelInsecureTls,
  getProviderById,
  listProviderModels,
  listProviders,
  setProviderEnabled,
  setProviderModelEnabled,
  updateProviderModel,
  updateProvider,
  upsertProvider,
  upsertProviderModel,
} from "../providers/repository";
import { ProviderModelRecord, ProviderRecord } from "../providers/types";
import { listPools } from "../pools/repository";
import { rebuildDefaultPools } from "../pools/builder";
import { BenchmarkCliOptions } from "../benchmark/types";
import { listBenchmarkExamples } from "../benchmark/runner";
import {
  getArtifactBenchmarkRun,
  getBenchmarkRun,
  hasRunningBenchmarkRun,
  listBenchmarkRunEvents,
  listBenchmarkRuns,
  startBenchmarkRun,
  subscribeBenchmarkRunEvents,
} from "../benchmark/jobs";
import { getCapabilitySnapshotByModel, listCapabilitySnapshots, toCapabilityMatrix } from "../benchmark/capabilityStore";
import { discoverUpstreamModels } from "../utils/modelDiscovery";
import {
  findCaptureBlobPath,
  getCaptureCalendarMonth,
  getCaptureConfig,
  getCaptureRecordById,
  listCaptureRecords,
  updateCaptureConfig,
} from "../storage/captureRepository";
import { promises as fs } from "fs";

interface AdminEnv {
  adminToken?: string;
  version?: string;
}

interface ProviderModelPayload {
  providerModelId?: string;
  modelId?: string;
  upstreamModel?: string;
  baseUrl?: string;
  apiKey?: string;
  insecureTls?: boolean;
  enabled?: boolean;
  aliases?: string[];
  free?: boolean;
  modalities?: string[];
  capabilities?: ProviderModelRecord["capabilities"];
  endpointType?: ProviderModelRecord["endpointType"];
  limits?: ProviderModelRecord["limits"];
}

interface ProviderModelDiscoveryPayload {
  baseUrl?: string;
  apiKey?: string;
  insecureTls?: boolean;
}

interface ProviderPayload {
  id?: string;
  name?: string;
  description?: string;
  docs?: string;
  protocol?: ProviderRecord["protocol"];
  protocolRaw?: string;
  protocolConfig?: ProviderRecord["protocolConfig"];
  baseUrl?: string;
  insecureTls?: boolean;
  autoInsecureTlsDomains?: string[];
  enabled?: boolean;
  supportsRouting?: boolean;
  auth?: ProviderRecord["auth"];
  envVar?: string;
  apiKey?: string;
  limits?: ProviderRecord["limits"];
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

  app.get("/admin/meta", async (_req, reply) => {
    reply.send({
      name: "waypoint",
      version: env.version ?? "0.0.0",
      now: new Date().toISOString(),
    });
  });

  app.get("/admin/providers", async (_req, reply) => {
    const providers = await listProviders(paths);
    reply.send(providers);
  });

  app.get("/admin/providers/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const provider = await getProviderById(paths, id);
    if (!provider) {
      reply.code(404).send({ error: { message: "provider not found" } });
      return;
    }
    reply.send(provider);
  });

  app.post("/admin/providers", async (req, reply) => {
    const body = req.body as ProviderPayload | undefined;
    if (!body?.id || !body?.baseUrl || !body?.protocol) {
      reply.code(400).send({ error: { message: "id, baseUrl, and protocol are required" } });
      return;
    }
    const provider: ProviderRecord = {
      id: body.id,
      name: body.name ?? body.id,
      description: body.description,
      docs: body.docs,
      protocol: body.protocol,
      protocolRaw: body.protocolRaw,
      protocolConfig: body.protocolConfig,
      baseUrl: body.baseUrl,
      insecureTls: body.insecureTls,
      autoInsecureTlsDomains: body.autoInsecureTlsDomains ?? [],
      enabled: body.enabled ?? true,
      supportsRouting: body.supportsRouting ?? true,
      auth: body.auth,
      envVar: body.envVar,
      apiKey: body.apiKey,
      limits: body.limits,
      models: [],
      importedAt: new Date().toISOString(),
    };
    const saved = await upsertProvider(paths, provider);
    await rebuildDefaultPools(paths);
    reply.code(201).send(saved);
  });

  app.patch("/admin/providers/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as ProviderPayload | undefined;
    if (!body) {
      reply.code(400).send({ error: { message: "payload required" } });
      return;
    }
    const updated = await updateProvider(paths, id, body as Partial<ProviderRecord>);
    if (!updated) {
      reply.code(404).send({ error: { message: "provider not found" } });
      return;
    }
    await rebuildDefaultPools(paths);
    reply.send(updated);
  });

  app.delete("/admin/providers/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const removed = await deleteProvider(paths, id);
    if (!removed) {
      reply.code(404).send({ error: { message: "provider not found" } });
      return;
    }
    await rebuildDefaultPools(paths);
    reply.send({ deleted: removed.id });
  });

  app.post("/admin/providers/:id/enable", async (req, reply) => {
    const { id } = req.params as { id: string };
    const provider = await setProviderEnabled(paths, id, true);
    if (!provider) {
      reply.code(404).send({ error: { message: "provider not found" } });
      return;
    }
    await rebuildDefaultPools(paths);
    reply.send(provider);
  });

  app.post("/admin/providers/:id/disable", async (req, reply) => {
    const { id } = req.params as { id: string };
    const provider = await setProviderEnabled(paths, id, false);
    if (!provider) {
      reply.code(404).send({ error: { message: "provider not found" } });
      return;
    }
    await rebuildDefaultPools(paths);
    reply.send(provider);
  });

  app.get("/admin/providers/:id/models", async (req, reply) => {
    const { id } = req.params as { id: string };
    const models = await listProviderModels(paths, id);
    if (!models) {
      reply.code(404).send({ error: { message: "provider not found" } });
      return;
    }
    reply.send(models);
  });

  app.post("/admin/providers/:id/models/discover", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as ProviderModelDiscoveryPayload | undefined;
    const provider = await getProviderById(paths, id);
    if (!provider) {
      reply.code(404).send({ error: { message: "provider not found" } });
      return;
    }

    const baseUrl = body?.baseUrl?.trim() || provider.baseUrl;
    if (!baseUrl) {
      reply.code(400).send({ error: { message: "baseUrl is required" } });
      return;
    }

    try {
      const models = await discoverUpstreamModels({
        baseUrl,
        apiKey: body?.apiKey?.trim() || provider.apiKey,
        insecureTls:
          body?.insecureTls === true
            ? true
            : getEffectiveModelInsecureTls(provider, { insecureTls: undefined }),
        auth: provider.auth,
      });
      reply.send({ baseUrl, models });
    } catch (error) {
      const message = error instanceof Error && error.message ? error.message : "model discovery failed";
      reply.code(502).send({ error: { message } });
    }
  });

  app.post("/admin/providers/:id/models", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as ProviderModelPayload | undefined;
    if (!body?.modelId || !body?.upstreamModel || !body?.endpointType || !body?.capabilities) {
      reply.code(400).send({
        error: {
          message:
            "modelId, upstreamModel, endpointType, and capabilities are required",
        },
      });
      return;
    }
    const provider = await getProviderById(paths, id);
    if (!provider) {
      reply.code(404).send({ error: { message: "provider not found" } });
      return;
    }
    const record: ProviderModelRecord = {
      providerModelId: body.providerModelId ?? `${id}/${body.modelId}`,
      providerId: id,
      modelId: body.modelId,
      upstreamModel: body.upstreamModel,
      baseUrl: body.baseUrl || provider.baseUrl,
      apiKey: body.apiKey,
      insecureTls: body.insecureTls,
      enabled: body.enabled ?? true,
      aliases: body.aliases ?? [],
      free: body.free ?? true,
      modalities: body.modalities ?? [],
      capabilities: body.capabilities,
      endpointType: body.endpointType,
      limits: body.limits,
    };
    const result = await upsertProviderModel(paths, id, record);
    if (!result) {
      reply.code(500).send({ error: { message: "failed to add model" } });
      return;
    }
    await rebuildDefaultPools(paths);
    reply.code(result.created ? 201 : 200).send(record);
  });

  app.patch("/admin/providers/:id/models/:modelRef", async (req, reply) => {
    const { id, modelRef } = req.params as { id: string; modelRef: string };
    const body = req.body as ProviderModelPayload | undefined;
    if (!body) {
      reply.code(400).send({ error: { message: "payload required" } });
      return;
    }
    const updated = await updateProviderModel(paths, id, modelRef, body as Partial<ProviderModelRecord>);
    if (!updated) {
      reply.code(404).send({ error: { message: "model not found" } });
      return;
    }
    await rebuildDefaultPools(paths);
    reply.send(updated);
  });

  app.delete("/admin/providers/:id/models/:modelRef", async (req, reply) => {
    const { id, modelRef } = req.params as { id: string; modelRef: string };
    const removed = await deleteProviderModel(paths, id, modelRef);
    if (!removed) {
      reply.code(404).send({ error: { message: "model not found" } });
      return;
    }
    await rebuildDefaultPools(paths);
    reply.send({ deleted: removed.providerModelId });
  });

  app.post("/admin/providers/:id/models/:modelRef/enable", async (req, reply) => {
    const { id, modelRef } = req.params as { id: string; modelRef: string };
    const model = await setProviderModelEnabled(paths, id, modelRef, true);
    if (!model) {
      reply.code(404).send({ error: { message: "model not found" } });
      return;
    }
    await rebuildDefaultPools(paths);
    reply.send(model);
  });

  app.post("/admin/providers/:id/models/:modelRef/disable", async (req, reply) => {
    const { id, modelRef } = req.params as { id: string; modelRef: string };
    const model = await setProviderModelEnabled(paths, id, modelRef, false);
    if (!model) {
      reply.code(404).send({ error: { message: "model not found" } });
      return;
    }
    await rebuildDefaultPools(paths);
    reply.send(model);
  });

  app.get("/admin/pools", async (_req, reply) => {
    const pools = await listPools(paths);
    reply.send(pools);
  });

  app.post("/admin/pools/rebuild", async (_req, reply) => {
    const pools = await rebuildDefaultPools(paths);
    reply.send({ rebuilt: pools.length, pools });
  });

  app.post(
    "/admin/benchmarks/runs",
    async (req: FastifyRequest<{ Body: BenchmarkCliOptions }>, reply: FastifyReply) => {
      if (hasRunningBenchmarkRun()) {
        reply.code(409).send({
          error: { message: "A benchmark run is already in progress" },
        });
        return;
      }
      const body = req.body ?? {};
      const run = await startBenchmarkRun(paths, {
        suite: body.suite,
        scenarioPath: body.scenarioPath,
        modelOverride: body.modelOverride,
        outPath: body.outPath,
        configPath: body.configPath,
        profile: body.profile,
        baselinePath: body.baselinePath,
        updateCapCache: body.updateCapCache,
        capTtlDays: body.capTtlDays,
      });
      reply.code(202).send(run);
    }
  );

  app.get("/admin/benchmarks/runs", async (_req, reply) => {
    const items = await listBenchmarkRuns(paths);
    reply.send({
      object: "list",
      data: items,
    });
  });

  app.get("/admin/benchmarks/examples", async (req, reply) => {
    const suite = ((req.query as { suite?: string } | undefined)?.suite ?? "showcase").trim() || "showcase";
    reply.send({
      object: "list",
      suite,
      data: listBenchmarkExamples(suite),
    });
  });

  app.get("/admin/benchmarks/runs/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const run = getBenchmarkRun(id);
    if (run) {
      reply.send(run);
      return;
    }
    const historical = await getArtifactBenchmarkRun(paths, id);
    if (!historical) {
      reply.code(404).send({ error: { message: "benchmark run not found" } });
      return;
    }
    reply.send(historical);
  });

  app.get("/admin/benchmarks/runs/:id/events", async (req, reply) => {
    const { id } = req.params as { id: string };
    const run = getBenchmarkRun(id);
    if (!run) {
      reply.code(404).send({ error: { message: "benchmark run not found" } });
      return;
    }

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    const sendEvent = (event: unknown): void => {
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    for (const event of listBenchmarkRunEvents(id)) {
      sendEvent(event);
    }

    const unsubscribe = subscribeBenchmarkRunEvents(id, (event) => {
      sendEvent(event);
    });

    const heartbeat = setInterval(() => {
      reply.raw.write(": ping\n\n");
    }, 15_000);

    req.raw.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
      reply.raw.end();
    });
  });

  app.get("/admin/benchmarks/capabilities", async (req, reply) => {
    const ttlParam = Number((req.query as { ttlDays?: string } | undefined)?.ttlDays);
    const ttlDays = Number.isFinite(ttlParam) && ttlParam > 0 ? Math.floor(ttlParam) : 7;
    const data = await listCapabilitySnapshots(paths, ttlDays);
    reply.send(toCapabilityMatrix(data));
  });

  app.get("/admin/benchmarks/capabilities/:modelId", async (req, reply) => {
    const { modelId } = req.params as { modelId: string };
    const ttlParam = Number((req.query as { ttlDays?: string } | undefined)?.ttlDays);
    const ttlDays = Number.isFinite(ttlParam) && ttlParam > 0 ? Math.floor(ttlParam) : 7;
    const model = await getCapabilitySnapshotByModel(paths, modelId, ttlDays);
    if (!model) {
      reply.code(404).send({ error: { message: "capability snapshot not found" } });
      return;
    }
    reply.send(model);
  });

  app.get("/admin/capture/config", async (_req, reply) => {
    const config = await getCaptureConfig(paths);
    reply.send(config);
  });

  app.put(
    "/admin/capture/config",
    async (req: FastifyRequest<{ Body: { enabled?: boolean; retentionDays?: number; maxBytes?: number } }>, reply) => {
      const next = await updateCaptureConfig(paths, req.body ?? {});
      reply.send(next);
    }
  );

  app.get("/admin/capture/records", async (req, reply) => {
    const query = req.query as { limit?: string; offset?: string; date?: string } | undefined;
    const parsed = Number(query?.limit);
    const limit = Number.isFinite(parsed) ? Math.max(1, Math.min(50, Math.floor(parsed))) : 5;
    const offsetParsed = Number(query?.offset);
    const offset = Number.isFinite(offsetParsed) ? Math.max(0, Math.floor(offsetParsed)) : 0;
    const result = await listCaptureRecords(paths, {
      limit,
      offset,
      date: typeof query?.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(query.date) ? query.date : undefined,
    });
    reply.send({ object: "list", data: result.data, total: result.total });
  });

  app.get("/admin/capture/calendar", async (req, reply) => {
    const query = req.query as { month?: string } | undefined;
    const month =
      typeof query?.month === "string" && /^\d{4}-\d{2}$/.test(query.month)
        ? query.month
        : new Date().toISOString().slice(0, 7);
    const days = await getCaptureCalendarMonth(paths, month);
    reply.send({ month, days });
  });

  app.get("/admin/capture/records/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const record = await getCaptureRecordById(paths, id);
    if (!record) {
      reply.code(404).send({ error: { message: "capture record not found" } });
      return;
    }
    reply.send(record);
  });

  app.get("/admin/capture/blobs/:hash", async (req, reply) => {
    const { hash } = req.params as { hash: string };
    const located = await findCaptureBlobPath(paths, hash);
    if (!located) {
      reply.code(404).send({ error: { message: "capture blob not found" } });
      return;
    }
    const buffer = await fs.readFile(located.path);
    reply.header("content-type", located.mime);
    reply.send(buffer);
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
