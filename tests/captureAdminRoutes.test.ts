import test from "node:test";
import assert from "node:assert/strict";
import path from "path";
import { promises as fs } from "fs";
import { createServer } from "node:http";
import Fastify from "fastify";
import { registerAdminRoutes } from "../src/routes/admin";
import { persistCaptureRecord, updateCaptureConfig } from "../src/storage/captureRepository";
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

async function startUpstreamServer(
  handler: Parameters<typeof createServer>[0]
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("failed to bind upstream test server");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
}

test("admin capture endpoints expose config, list, and detail", async () => {
  const baseDir = await makeWorkspaceTempDir("waypoint-capture-admin-test-");
  const paths = makePaths(baseDir);
  const app = Fastify();
  await registerAdminRoutes(app, paths, { adminToken: "test-token", version: "0.0.0" });

  const auth = { authorization: "Bearer test-token" };

  const cfgRes = await app.inject({ method: "GET", url: "/admin/capture/config", headers: auth });
  assert.equal(cfgRes.statusCode, 200);

  const enableRes = await app.inject({
    method: "PUT",
    url: "/admin/capture/config",
    headers: { ...auth, "content-type": "application/json" },
    payload: { enabled: true, retentionDays: 30, maxBytes: 20 * 1024 * 1024 * 1024 },
  });
  assert.equal(enableRes.statusCode, 200);
  await updateCaptureConfig(paths, { enabled: true });

  const record = await persistCaptureRecord(paths, {
    route: "/v1/embeddings",
    method: "POST",
    statusCode: 200,
    latencyMs: 10,
    requestBody: { model: "prov/model", input: "hello" },
    responseBody: { data: [] },
    routing: { publicModel: "prov/model" },
  });
  assert.ok(record);

  const listRes = await app.inject({ method: "GET", url: "/admin/capture/records?limit=5", headers: auth });
  assert.equal(listRes.statusCode, 200);
  const listJson = listRes.json() as { data: Array<{ id: string }>; total: number };
  assert.equal(listJson.data.length, 1);
  assert.equal(listJson.total, 1);

  const detailRes = await app.inject({
    method: "GET",
    url: `/admin/capture/records/${encodeURIComponent(listJson.data[0].id)}`,
    headers: auth,
  });
  assert.equal(detailRes.statusCode, 200);
  const detailJson = detailRes.json() as {
    route: string;
    analysis?: {
      tokenFlow?: {
        method: string;
      };
    };
  };
  assert.equal(detailJson.route, "/v1/embeddings");
  assert.equal(detailJson.analysis?.tokenFlow?.method, "unavailable");

  const datedListRes = await app.inject({
    method: "GET",
    url: `/admin/capture/records?date=${record?.timestamp.slice(0, 10)}&limit=5&offset=0`,
    headers: auth,
  });
  assert.equal(datedListRes.statusCode, 200);
  const datedListJson = datedListRes.json() as { data: Array<{ id: string }>; total: number };
  assert.equal(datedListJson.total, 1);

  const calendarRes = await app.inject({
    method: "GET",
    url: `/admin/capture/calendar?month=${record?.timestamp.slice(0, 7)}`,
    headers: auth,
  });
  assert.equal(calendarRes.statusCode, 200);
  const calendarJson = calendarRes.json() as { month: string; days: Array<{ date: string; count: number }> };
  assert.equal(calendarJson.days.length, 1);
  assert.equal(calendarJson.days[0]?.count, 1);

  await app.close();
});

test("admin provider endpoints support provider-level CRUD", async () => {
  const baseDir = await makeWorkspaceTempDir("waypoint-provider-admin-test-");
  const paths = makePaths(baseDir);
  const app = Fastify();
  await registerAdminRoutes(app, paths, { adminToken: "test-token", version: "0.0.0" });

  const auth = { authorization: "Bearer test-token" };

  const createRes = await app.inject({
    method: "POST",
    url: "/admin/providers",
    headers: { ...auth, "content-type": "application/json" },
    payload: {
      id: "demo",
      name: "Demo Provider",
      protocol: "openai",
      baseUrl: "https://example.com/v1",
      enabled: true,
      supportsRouting: true,
    },
  });
  assert.equal(createRes.statusCode, 201);

  const updateRes = await app.inject({
    method: "PATCH",
    url: "/admin/providers/demo",
    headers: { ...auth, "content-type": "application/json" },
    payload: {
      name: "Demo Provider Updated",
      envVar: "DEMO_API_KEY",
    },
  });
  assert.equal(updateRes.statusCode, 200);
  assert.equal((updateRes.json() as { name: string }).name, "Demo Provider Updated");

  const disableRes = await app.inject({
    method: "POST",
    url: "/admin/providers/demo/disable",
    headers: auth,
  });
  assert.equal(disableRes.statusCode, 200);
  assert.equal((disableRes.json() as { enabled: boolean }).enabled, false);

  const enableRes = await app.inject({
    method: "POST",
    url: "/admin/providers/demo/enable",
    headers: auth,
  });
  assert.equal(enableRes.statusCode, 200);
  assert.equal((enableRes.json() as { enabled: boolean }).enabled, true);

  const deleteRes = await app.inject({
    method: "DELETE",
    url: "/admin/providers/demo",
    headers: auth,
  });
  assert.equal(deleteRes.statusCode, 200);
  assert.equal((deleteRes.json() as { deleted: string }).deleted, "demo");

  await app.close();
});

test("admin provider model discovery honors header auth and normalizes capabilities", async () => {
  const upstream = await startUpstreamServer((req, res) => {
    assert.equal(req.url, "/v1/models");
    assert.equal(req.headers["x-api-key"], "secret-token");
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      data: [
        {
          id: "gpt-4.1-mini",
          capabilities: {
            input: ["text"],
            output: ["text", "image"],
            supportsTools: true,
            supportsStreaming: true,
          },
        },
      ],
    }));
  });

  const baseDir = await makeWorkspaceTempDir("waypoint-provider-discovery-test-");
  const paths = makePaths(baseDir);
  const app = Fastify();
  await registerAdminRoutes(app, paths, { adminToken: "test-token", version: "0.0.0" });
  const auth = { authorization: "Bearer test-token" };

  const createRes = await app.inject({
    method: "POST",
    url: "/admin/providers",
    headers: { ...auth, "content-type": "application/json" },
    payload: {
      id: "demo",
      name: "Demo Provider",
      protocol: "openai",
      baseUrl: upstream.baseUrl,
      apiKey: "secret-token",
      auth: {
        type: "header",
        headerName: "x-api-key",
      },
      enabled: true,
      supportsRouting: true,
    },
  });
  assert.equal(createRes.statusCode, 201);

  const discoveryRes = await app.inject({
    method: "POST",
    url: "/admin/providers/demo/models/discover",
    headers: { ...auth, "content-type": "application/json" },
    payload: {},
  });
  assert.equal(discoveryRes.statusCode, 200);
  const discoveryJson = discoveryRes.json() as {
    baseUrl: string;
    models: Array<{
      id: string;
      capabilities?: {
        input: string[];
        output: string[];
        supportsTools?: boolean;
        supportsStreaming?: boolean;
        source?: string;
      };
    }>;
  };
  assert.equal(discoveryJson.baseUrl, upstream.baseUrl);
  assert.deepEqual(discoveryJson.models, [
    {
      id: "gpt-4.1-mini",
      capabilities: {
        input: ["text"],
        output: ["text", "image"],
        supportsTools: true,
        supportsStreaming: true,
        source: "inferred",
      },
    },
  ]);

  await app.close();
  await upstream.close();
});

test("admin provider model discovery supports providers whose base URL already ends with /v1", async () => {
  const upstream = await startUpstreamServer((req, res) => {
    assert.equal(req.url, "/v1/models?token=query-secret");
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      data: [
        {
          id: "text-embedding-3-large",
          input_modalities: ["text"],
          output_modalities: ["embedding"],
        },
      ],
    }));
  });

  const baseDir = await makeWorkspaceTempDir("waypoint-provider-discovery-v1-test-");
  const paths = makePaths(baseDir);
  const app = Fastify();
  await registerAdminRoutes(app, paths, { adminToken: "test-token", version: "0.0.0" });
  const auth = { authorization: "Bearer test-token" };

  const createRes = await app.inject({
    method: "POST",
    url: "/admin/providers",
    headers: { ...auth, "content-type": "application/json" },
    payload: {
      id: "embed",
      name: "Embed Provider",
      protocol: "openai",
      baseUrl: `${upstream.baseUrl}/v1`,
      apiKey: "query-secret",
      auth: {
        type: "query",
        keyParam: "token",
      },
      enabled: true,
      supportsRouting: true,
    },
  });
  assert.equal(createRes.statusCode, 201);

  const discoveryRes = await app.inject({
    method: "POST",
    url: "/admin/providers/embed/models/discover",
    headers: { ...auth, "content-type": "application/json" },
    payload: {},
  });
  assert.equal(discoveryRes.statusCode, 200);
  const discoveryJson = discoveryRes.json() as {
    models: Array<{ id: string; capabilities?: { input: string[]; output: string[]; source?: string } }>;
  };
  assert.deepEqual(discoveryJson.models, [
    {
      id: "text-embedding-3-large",
      capabilities: {
        input: ["text"],
        output: ["embedding"],
        source: "inferred",
      },
    },
  ]);

  await app.close();
  await upstream.close();
});
