import test from "node:test";
import assert from "node:assert/strict";
import path from "path";
import { promises as fs } from "fs";
import {
  ensureCaptureStore,
  getCaptureConfig,
  listCaptureRecords,
  persistCaptureRecord,
  updateCaptureConfig,
  getCaptureRecordById,
} from "../src/storage/captureRepository";
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

test("capture repository toggles config and persists record with media artifact previews", async () => {
  const baseDir = await makeWorkspaceTempDir("waypoint-capture-test-");
  const paths = makePaths(baseDir);

  await ensureCaptureStore(paths);
  const initial = await getCaptureConfig(paths);
  assert.equal(initial.enabled, false);

  await updateCaptureConfig(paths, { enabled: true });
  const enabled = await getCaptureConfig(paths);
  assert.equal(enabled.enabled, true);

  const pngData =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO2w2pQAAAAASUVORK5CYII=";

  const persisted = await persistCaptureRecord(paths, {
    route: "/v1/chat/completions",
    method: "POST",
    statusCode: 200,
    latencyMs: 42,
    requestBody: {
      model: "prov/model",
      messages: [{ role: "system", content: "Read AGENTS.md" }],
      tools: [{ type: "function", function: { name: "my_tool", description: "MCP helper" } }],
      image: pngData,
    },
    responseBody: { ok: true },
    routing: { publicModel: "prov/model", endpointId: "ep-1", upstreamModel: "u-1" },
  });

  assert.ok(persisted);
  assert.equal(persisted?.artifacts.length, 1);
  assert.equal(persisted?.analysis.systemMessages.length, 1);
  assert.equal(persisted?.analysis.mcpToolDescriptions.length, 1);

  const list = await listCaptureRecords(paths, 5);
  assert.equal(list.length, 1);
  const loaded = await getCaptureRecordById(paths, list[0].id);
  assert.ok(loaded);
  assert.equal(loaded?.route, "/v1/chat/completions");
});

