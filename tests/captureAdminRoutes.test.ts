import test from "node:test";
import assert from "node:assert/strict";
import path from "path";
import { promises as fs } from "fs";
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
  const listJson = listRes.json() as { data: Array<{ id: string }> };
  assert.equal(listJson.data.length, 1);

  const detailRes = await app.inject({
    method: "GET",
    url: `/admin/capture/records/${encodeURIComponent(listJson.data[0].id)}`,
    headers: auth,
  });
  assert.equal(detailRes.statusCode, 200);
  const detailJson = detailRes.json() as { route: string };
  assert.equal(detailJson.route, "/v1/embeddings");

  await app.close();
});

