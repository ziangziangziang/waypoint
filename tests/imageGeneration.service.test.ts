import test from "node:test";
import assert from "node:assert/strict";
import os from "os";
import path from "path";
import { promises as fs } from "fs";
import {
  normalizeImageGenerationPayload,
} from "../src/services/imageGeneration";
import { StoragePaths } from "../src/storage/files";

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

test("normalizeImageGenerationPayload preserves mixed url+b64 fields", async () => {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "waypoint-img-norm-"));
  const result = await normalizeImageGenerationPayload(
    makePaths(baseDir),
    {
      created: 1730000000,
      data: [
        {
          url: "https://example.com/image.png",
          b64_json: "AAA",
          revised_prompt: "cat",
        },
      ],
    },
    "provider/model"
  );
  assert.equal(result.model, "provider/model");
  assert.equal(result.images.length, 1);
  assert.equal(result.images[0].url, "https://example.com/image.png");
  assert.equal(result.images[0].b64_json, "AAA");
  assert.equal(result.images[0].revised_prompt, "cat");
});

test("normalizeImageGenerationPayload adds data url when only b64_json exists", async () => {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "waypoint-img-norm-"));
  const result = await normalizeImageGenerationPayload(
    makePaths(baseDir),
    {
      data: [{ b64_json: "BBB" }],
    },
    "smart"
  );
  assert.equal(result.images.length, 1);
  assert.equal(result.images[0].b64_json, "BBB");
  assert.equal(result.images[0].url, "data:image/png;base64,BBB");
});

test("normalizeImageGenerationPayload extracts b64 from data URL", async () => {
  const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "waypoint-img-norm-"));
  const result = await normalizeImageGenerationPayload(
    makePaths(baseDir),
    {
      data: [{ url: "data:image/png;base64,CCC" }],
    },
    "smart"
  );
  assert.equal(result.images.length, 1);
  assert.equal(result.images[0].b64_json, "CCC");
  assert.equal(result.images[0].url, "data:image/png;base64,CCC");
});
