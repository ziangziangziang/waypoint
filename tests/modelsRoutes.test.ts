import test from "node:test";
import assert from "node:assert/strict";
import path from "path";
import { promises as fs } from "fs";
import Fastify from "fastify";
import { registerModelsRoutes } from "../src/routes/models";
import type { StoragePaths } from "../src/storage/files";

function makePaths(baseDir: string): StoragePaths {
  return {
    baseDir,
    configPath: path.join(baseDir, "config.yaml"),
    healthPath: path.join(baseDir, "health.json"),
    providerHealthPath: path.join(baseDir, "providers_health.json"),
    requestLogPath: path.join(baseDir, "request_logs.jsonl"),
    providersPath: path.join(baseDir, "providers.json"),
    poolsPath: path.join(baseDir, "pools.json"),
    poolStatePath: path.join(baseDir, "pool_state.json"),
  };
}

async function makeWorkspaceTempDir(prefix: string): Promise<string> {
  const base = path.join(process.cwd(), "tmp");
  await fs.mkdir(base, { recursive: true });
  return fs.mkdtemp(path.join(base, prefix));
}

async function writeProvidersFixture(paths: StoragePaths): Promise<void> {
  const providers = {
    version: 3,
    updatedAt: new Date().toISOString(),
    providers: [
      {
        id: "prov-a",
        name: "Provider A",
        protocol: "openai",
        baseUrl: "http://example-a.test",
        enabled: true,
        supportsRouting: true,
        importedAt: new Date().toISOString(),
        models: [
          {
            providerModelId: "prov-a/model-up",
            providerId: "prov-a",
            modelId: "model-up",
            upstreamModel: "model-up",
            enabled: true,
            free: false,
            modalities: ["text"],
            endpointType: "llm",
            capabilities: { input: ["text"], output: ["text"] },
            aliases: [],
          },
          {
            providerModelId: "prov-a/model-down",
            providerId: "prov-a",
            modelId: "model-down",
            upstreamModel: "model-down",
            enabled: true,
            free: false,
            modalities: ["text"],
            endpointType: "llm",
            capabilities: { input: ["text"], output: ["text"] },
            aliases: [],
          },
          {
            providerModelId: "prov-a/model-unknown",
            providerId: "prov-a",
            modelId: "model-unknown",
            upstreamModel: "model-unknown",
            enabled: true,
            free: false,
            modalities: ["text"],
            endpointType: "llm",
            capabilities: { input: ["text"], output: ["text"] },
            aliases: [],
          },
        ],
      },
    ],
  };

  await fs.writeFile(paths.providersPath, JSON.stringify(providers, null, 2), "utf8");
}

async function writeProviderHealthFixture(paths: StoragePaths): Promise<void> {
  const health = {
    models: {
      "prov-a/model-up": {
        status: "up",
        consecutiveFailures: 0,
        lastCheckedAt: "2026-03-06T12:00:00.000Z",
        latencyMsEwma: 123.4,
      },
      "prov-a/model-down": {
        status: "down",
        consecutiveFailures: 4,
        lastCheckedAt: "2026-03-06T12:01:00.000Z",
        lastError: "status 503",
      },
    },
  };
  await fs.writeFile(paths.providerHealthPath, JSON.stringify(health, null, 2), "utf8");
}

test("/v1/models includes additive waypoint_health metadata", async () => {
  const baseDir = await makeWorkspaceTempDir("waypoint-models-test-");
  const paths = makePaths(baseDir);
  await writeProvidersFixture(paths);
  await writeProviderHealthFixture(paths);

  const app = Fastify();
  await registerModelsRoutes(app, paths);

  const res = await app.inject({ method: "GET", url: "/v1/models" });
  assert.equal(res.statusCode, 200);
  const json = res.json() as {
    data: Array<{ id: string; waypoint_health?: { status: "up" | "down" | "unknown"; consecutiveFailures?: number } }>;
  };

  const up = json.data.find((entry) => entry.id === "prov-a/model-up");
  const down = json.data.find((entry) => entry.id === "prov-a/model-down");
  const unknown = json.data.find((entry) => entry.id === "prov-a/model-unknown");
  assert.ok(up);
  assert.ok(down);
  assert.ok(unknown);
  assert.equal(up.waypoint_health?.status, "up");
  assert.equal(down.waypoint_health?.status, "down");
  assert.equal(down.waypoint_health?.consecutiveFailures, 4);
  assert.equal(unknown.waypoint_health?.status, "unknown");

  await app.close();
});

test("/v1/models?available_only=true excludes down but keeps up and unknown", async () => {
  const baseDir = await makeWorkspaceTempDir("waypoint-models-test-");
  const paths = makePaths(baseDir);
  await writeProvidersFixture(paths);
  await writeProviderHealthFixture(paths);

  const app = Fastify();
  await registerModelsRoutes(app, paths);

  const res = await app.inject({ method: "GET", url: "/v1/models?available_only=true" });
  assert.equal(res.statusCode, 200);
  const json = res.json() as { data: Array<{ id: string }> };
  const ids = json.data.map((entry) => entry.id);

  assert.ok(ids.includes("prov-a/model-up"));
  assert.ok(ids.includes("prov-a/model-unknown"));
  assert.ok(!ids.includes("prov-a/model-down"));

  await app.close();
});
