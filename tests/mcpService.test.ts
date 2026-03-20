import test from "node:test";
import assert from "node:assert/strict";
import path from "path";
import { promises as fs } from "fs";
import Fastify from "fastify";
import { registerMcpServiceRoutes } from "../src/routes/mcpService";
import { StoragePaths } from "../src/storage/files";

const MCP_HEADERS = {
  host: "localhost:8011",
  accept: "application/json, text/event-stream",
  "content-type": "application/json",
};

async function makeWorkspaceTempDir(prefix: string): Promise<string> {
  const base = path.join(process.cwd(), "tmp");
  await fs.mkdir(base, { recursive: true });
  return fs.mkdtemp(path.join(base, prefix));
}

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

function withTemporaryEnv(
  patch: Partial<NodeJS.ProcessEnv>,
  run: () => Promise<void>
): Promise<void> {
  const keys = Object.keys(patch) as Array<keyof NodeJS.ProcessEnv>;
  const previous = new Map<keyof NodeJS.ProcessEnv, string | undefined>();
  for (const key of keys) {
    previous.set(key, process.env[key]);
    const value = patch[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  return run().finally(() => {
    for (const key of keys) {
      const value = previous.get(key);
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });
}

test("mcp /mcp initialize, list tools, and call generate_image", async () => {
  const baseDir = await makeWorkspaceTempDir("waypoint-mcp-test-");
  const app = Fastify();
  await registerMcpServiceRoutes(app, makePaths(baseDir), {
    runImageGeneration: async () => ({
      model: "mock/diffusion",
      statusCode: 200,
      headers: { "content-type": "application/json" },
      payload: { created: 1730000000, data: [{ b64_json: "AAA" }] },
      route: {
        endpointId: "ep-1",
        endpointName: "mock",
        upstreamModel: "upstream",
      },
    }),
    normalizeImageGenerationPayload: async (_paths, payload, model) => ({
      model,
      created: (payload as { created: number }).created,
      images: [{ index: 0, url: "data:image/png;base64,AAA", b64_json: "AAA" }],
    }),
  });

  const init = await app.inject({
    method: "POST",
    url: "/mcp",
    headers: MCP_HEADERS,
    payload: {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test", version: "1.0.0" },
      },
    },
  });
  assert.equal(init.statusCode, 200);
  const sessionId = init.headers["mcp-session-id"];
  assert.ok(typeof sessionId === "string" && sessionId.length > 0);

  await app.inject({
    method: "POST",
    url: "/mcp",
    headers: { ...MCP_HEADERS, "mcp-session-id": sessionId },
    payload: {
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    },
  });

  const listTools = await app.inject({
    method: "POST",
    url: "/mcp",
    headers: { ...MCP_HEADERS, "mcp-session-id": sessionId },
    payload: {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    },
  });
  assert.equal(listTools.statusCode, 200);
  const listJson = listTools.json() as {
    result?: { tools?: Array<{ name: string; description?: string }> };
  };
  const generateImageTool = listJson.result?.tools?.find((tool) => tool.name === "generate_image");
  assert.ok(generateImageTool);
  const understandImageTool = listJson.result?.tools?.find((tool) => tool.name === "understand_image");
  assert.ok(understandImageTool);
  const desc = generateImageTool?.description ?? "";
  assert.match(desc, /workspace_root is required/);
  assert.match(desc, /\.waypoint\/generated-images/);
  assert.match(desc, /never the MCP transcript path/);
  const understandDesc = understandImageTool?.description ?? "";
  assert.match(understandDesc, /Provide exactly one of image_path or image_url/);
  assert.match(understandDesc, /original-image pixel coordinates/);

  const call = await app.inject({
    method: "POST",
    url: "/mcp",
    headers: { ...MCP_HEADERS, "mcp-session-id": sessionId },
    payload: {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "generate_image",
        arguments: {
          prompt: "sunset over mountains",
          workspace_root: baseDir,
        },
      },
    },
  });
  assert.equal(call.statusCode, 200);
  const callJson = call.json() as {
    result?: { content?: Array<{ type: string; text?: string }> };
  };
  const text = callJson.result?.content?.find((item) => item.type === "text")?.text ?? "{}";
  const payload = JSON.parse(text) as { ok: boolean; file_path: string; model: string };
  assert.equal(payload.ok, true);
  assert.equal(payload.model, "mock/diffusion");
  assert.match(payload.file_path, /^\.waypoint\/generated-images\/image-1730000000-0\.png$/);

  await app.close();
});

test("mcp tool returns typed no_diffusion_model error output", async () => {
  const baseDir = await makeWorkspaceTempDir("waypoint-mcp-test-");
  const app = Fastify();
  await registerMcpServiceRoutes(app, makePaths(baseDir), {
    runImageGeneration: async () => {
      const err = new Error("No diffusion model available");
      (err as Error & { type: string }).type = "no_diffusion_model";
      throw err;
    },
    normalizeImageGenerationPayload: async () => {
      throw new Error("should not run");
    },
  });

  const init = await app.inject({
    method: "POST",
    url: "/mcp",
    headers: MCP_HEADERS,
    payload: {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test", version: "1.0.0" },
      },
    },
  });
  const sessionId = init.headers["mcp-session-id"] as string;
  await app.inject({
    method: "POST",
    url: "/mcp",
    headers: { ...MCP_HEADERS, "mcp-session-id": sessionId },
    payload: { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
  });

  const call = await app.inject({
    method: "POST",
    url: "/mcp",
    headers: { ...MCP_HEADERS, "mcp-session-id": sessionId },
    payload: {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "generate_image",
        arguments: { prompt: "any", workspace_root: baseDir },
      },
    },
  });
  const callJson = call.json() as {
    result?: { content?: Array<{ type: string; text?: string }>; isError?: boolean };
  };
  assert.equal(callJson.result?.isError, true);
  const text = callJson.result?.content?.find((item) => item.type === "text")?.text ?? "";
  assert.match(text, /"type":"no_diffusion_model"/);

  await app.close();
});

test("mcp localhost guard blocks non-local hosts", async () => {
  const baseDir = await makeWorkspaceTempDir("waypoint-mcp-test-");
  const app = Fastify();
  await registerMcpServiceRoutes(app, makePaths(baseDir), {
    runImageGeneration: async () => {
      throw new Error("unused");
    },
    normalizeImageGenerationPayload: async () => {
      throw new Error("unused");
    },
  });

  const res = await app.inject({
    method: "POST",
    url: "/mcp",
    headers: { host: "evil.example.com:8000" },
    payload: {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test", version: "1.0.0" },
      },
    },
  });
  assert.equal(res.statusCode, 403);
  await app.close();
});

test("mcp generate_image can write output directly to file", async () => {
  const baseDir = await makeWorkspaceTempDir("waypoint-mcp-test-");
  const outPath = "./images/result-{index}.png";
  const app = Fastify();
  await registerMcpServiceRoutes(app, makePaths(baseDir), {
    runImageGeneration: async () => ({
      model: "mock/diffusion",
      statusCode: 200,
      headers: { "content-type": "application/json" },
      payload: { created: 1730000000, data: [{ b64_json: "AQID" }] },
      route: {
        endpointId: "ep-1",
        endpointName: "mock",
        upstreamModel: "upstream",
      },
    }),
    normalizeImageGenerationPayload: async () => ({
      model: "mock/diffusion",
      created: 1730000000,
      images: [{ index: 0, b64_json: "AQID" }],
    }),
  });

  const init = await app.inject({
    method: "POST",
    url: "/mcp",
    headers: MCP_HEADERS,
    payload: {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test", version: "1.0.0" },
      },
    },
  });
  const sessionId = init.headers["mcp-session-id"] as string;
  await app.inject({
    method: "POST",
    url: "/mcp",
    headers: { ...MCP_HEADERS, "mcp-session-id": sessionId },
    payload: { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
  });

  const call = await app.inject({
    method: "POST",
    url: "/mcp",
    headers: { ...MCP_HEADERS, "mcp-session-id": sessionId },
    payload: {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "generate_image",
        arguments: {
          prompt: "any",
          workspace_root: baseDir,
          output_path: outPath,
        },
      },
    },
  });
  assert.equal(call.statusCode, 200);
  const callJson = call.json() as {
    result?: { content?: Array<{ type: string; text?: string }> };
  };
  const text = callJson.result?.content?.find((item) => item.type === "text")?.text ?? "{}";
  const payload = JSON.parse(text) as { ok: boolean; file_path: string; model: string };
  assert.equal(payload.ok, true);
  assert.equal(payload.file_path, "images/result-0.png");
  const written = await fs.readFile(path.join(baseDir, payload.file_path));
  assert.equal(written.length, 3);

  await app.close();
});

test("mcp generate_image can include inline data when include_data=true with file output", async () => {
  const baseDir = await makeWorkspaceTempDir("waypoint-mcp-test-");
  const app = Fastify();
  await registerMcpServiceRoutes(app, makePaths(baseDir), {
    runImageGeneration: async () => ({
      model: "mock/diffusion",
      statusCode: 200,
      headers: { "content-type": "application/json" },
      payload: { created: 1730000000, data: [{ b64_json: "AQID", url: "data:image/png;base64,AQID" }] },
      route: {
        endpointId: "ep-1",
        endpointName: "mock",
        upstreamModel: "upstream",
      },
    }),
    normalizeImageGenerationPayload: async () => ({
      model: "mock/diffusion",
      created: 1730000000,
      images: [{ index: 0, b64_json: "AQID", url: "data:image/png;base64,AQID" }],
    }),
  });

  const init = await app.inject({
    method: "POST",
    url: "/mcp",
    headers: MCP_HEADERS,
    payload: {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test", version: "1.0.0" },
      },
    },
  });
  const sessionId = init.headers["mcp-session-id"] as string;
  await app.inject({
    method: "POST",
    url: "/mcp",
    headers: { ...MCP_HEADERS, "mcp-session-id": sessionId },
    payload: { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
  });

  const call = await app.inject({
    method: "POST",
    url: "/mcp",
    headers: { ...MCP_HEADERS, "mcp-session-id": sessionId },
    payload: {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "generate_image",
        arguments: {
          prompt: "any",
          workspace_root: baseDir,
          output_dir: "./images",
          include_data: true,
        },
      },
    },
  });
  assert.equal(call.statusCode, 200);
  const callJson = call.json() as {
    result?: {
      content?: Array<{ type: string; text?: string }>;
      structuredContent?: {
        ok: boolean;
        artifacts: Array<{ file_path: string; b64_json?: string; url?: string }>;
      };
    };
  };
  const text = callJson.result?.content?.find((item) => item.type === "text")?.text ?? "{}";
  const payload = JSON.parse(text) as { ok: boolean; file_path: string };
  assert.equal(payload.ok, true);
  assert.equal(payload.file_path, "images/image-1730000000-0.png");
  assert.doesNotMatch(text, /AQID/);
  assert.equal(typeof callJson.result?.structuredContent?.artifacts[0]?.b64_json, "string");
  assert.equal(typeof callJson.result?.structuredContent?.artifacts[0]?.url, "string");

  await app.close();
});

test("mcp generate_image rejects missing workspace_root", async () => {
  const baseDir = await makeWorkspaceTempDir("waypoint-mcp-test-");
  const app = Fastify();
  await registerMcpServiceRoutes(app, makePaths(baseDir), {
    runImageGeneration: async () => {
      throw new Error("should not run");
    },
    normalizeImageGenerationPayload: async () => {
      throw new Error("should not run");
    },
  });

  const init = await app.inject({
    method: "POST",
    url: "/mcp",
    headers: MCP_HEADERS,
    payload: {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test", version: "1.0.0" },
      },
    },
  });
  const sessionId = init.headers["mcp-session-id"] as string;
  await app.inject({
    method: "POST",
    url: "/mcp",
    headers: { ...MCP_HEADERS, "mcp-session-id": sessionId },
    payload: { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
  });

  const call = await app.inject({
    method: "POST",
    url: "/mcp",
    headers: { ...MCP_HEADERS, "mcp-session-id": sessionId },
    payload: {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "generate_image",
        arguments: {
          prompt: "any",
        },
      },
    },
  });
  assert.equal(call.statusCode, 200);
  const callJson = call.json() as {
    result?: { content?: Array<{ type: string; text?: string }>; isError?: boolean };
  };
  assert.equal(callJson.result?.isError, true);
  const text = callJson.result?.content?.find((item) => item.type === "text")?.text ?? "";
  assert.match(text, /workspace_root is required/);

  await app.close();
});

test("mcp generate_image defaults to .waypoint/generated-images when output target is omitted", async () => {
  const baseDir = await makeWorkspaceTempDir("waypoint-mcp-test-");
  const app = Fastify();
  await registerMcpServiceRoutes(app, makePaths(baseDir), {
    runImageGeneration: async () => ({
      model: "mock/diffusion",
      statusCode: 200,
      headers: { "content-type": "application/json" },
      payload: { created: 1730000000, data: [{ b64_json: "AQID" }] },
      route: {
        endpointId: "ep-1",
        endpointName: "mock",
        upstreamModel: "upstream",
      },
    }),
    normalizeImageGenerationPayload: async () => ({
      model: "mock/diffusion",
      created: 1730000000,
      images: [{ index: 0, b64_json: "AQID" }],
    }),
  });

  const init = await app.inject({
    method: "POST",
    url: "/mcp",
    headers: MCP_HEADERS,
    payload: {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test", version: "1.0.0" },
      },
    },
  });
  const sessionId = init.headers["mcp-session-id"] as string;
  await app.inject({
    method: "POST",
    url: "/mcp",
    headers: { ...MCP_HEADERS, "mcp-session-id": sessionId },
    payload: { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
  });

  const call = await app.inject({
    method: "POST",
    url: "/mcp",
    headers: { ...MCP_HEADERS, "mcp-session-id": sessionId },
    payload: {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "generate_image",
        arguments: {
          prompt: "any",
          workspace_root: baseDir,
        },
      },
    },
  });
  assert.equal(call.statusCode, 200);
  const callJson = call.json() as {
    result?: { content?: Array<{ type: string; text?: string }> };
  };
  const text = callJson.result?.content?.find((item) => item.type === "text")?.text ?? "{}";
  const payload = JSON.parse(text) as { ok: boolean; file_path: string };
  assert.equal(payload.ok, true);
  assert.match(payload.file_path, /^\.waypoint\/generated-images\/image-1730000000-0\.png$/);
  const written = await fs.readFile(path.join(baseDir, payload.file_path));
  assert.equal(written.length, 3);

  await app.close();
});

test("mcp generate_image rejects output_path + output_dir as invalid_request", async () => {
  const baseDir = await makeWorkspaceTempDir("waypoint-mcp-test-");
  const app = Fastify();
  await registerMcpServiceRoutes(app, makePaths(baseDir), {
    runImageGeneration: async () => {
      throw new Error("should not run");
    },
    normalizeImageGenerationPayload: async () => {
      throw new Error("should not run");
    },
  });

  const init = await app.inject({
    method: "POST",
    url: "/mcp",
    headers: MCP_HEADERS,
    payload: {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test", version: "1.0.0" },
      },
    },
  });
  const sessionId = init.headers["mcp-session-id"] as string;
  await app.inject({
    method: "POST",
    url: "/mcp",
    headers: { ...MCP_HEADERS, "mcp-session-id": sessionId },
    payload: { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
  });

  const call = await app.inject({
    method: "POST",
    url: "/mcp",
    headers: { ...MCP_HEADERS, "mcp-session-id": sessionId },
    payload: {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "generate_image",
        arguments: {
          prompt: "any",
          workspace_root: baseDir,
          output_path: "./img-{index}.png",
          output_dir: "./images",
        },
      },
    },
  });
  assert.equal(call.statusCode, 200);
  const callJson = call.json() as {
    result?: { content?: Array<{ type: string; text?: string }>; isError?: boolean };
  };
  assert.equal(callJson.result?.isError, true);
  const text = callJson.result?.content?.find((item) => item.type === "text")?.text ?? "";
  assert.match(text, /"type":"invalid_request"/);

  await app.close();
});

test("mcp generate_image rejects absolute output_dir", async () => {
  const baseDir = await makeWorkspaceTempDir("waypoint-mcp-test-");
  const app = Fastify();
  await registerMcpServiceRoutes(app, makePaths(baseDir), {
    runImageGeneration: async () => {
      throw new Error("should not run");
    },
    normalizeImageGenerationPayload: async () => {
      throw new Error("should not run");
    },
  });

  const init = await app.inject({
    method: "POST",
    url: "/mcp",
    headers: MCP_HEADERS,
    payload: {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test", version: "1.0.0" },
      },
    },
  });
  const sessionId = init.headers["mcp-session-id"] as string;
  await app.inject({
    method: "POST",
    url: "/mcp",
    headers: { ...MCP_HEADERS, "mcp-session-id": sessionId },
    payload: { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
  });

  const call = await app.inject({
    method: "POST",
    url: "/mcp",
    headers: { ...MCP_HEADERS, "mcp-session-id": sessionId },
    payload: {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "generate_image",
        arguments: {
          prompt: "any",
          workspace_root: baseDir,
          output_dir: path.join(baseDir, "images"),
        },
      },
    },
  });
  assert.equal(call.statusCode, 200);
  const callJson = call.json() as {
    result?: { content?: Array<{ type: string; text?: string }>; isError?: boolean };
  };
  assert.equal(callJson.result?.isError, true);
  const text = callJson.result?.content?.find((item) => item.type === "text")?.text ?? "";
  assert.match(text, /"type":"invalid_request"/);
  assert.match(text, /output_dir must be relative to workspace_root/);

  await app.close();
});

test("mcp generate_image resolves relative output_dir against configured output root", async () => {
  const baseDir = await makeWorkspaceTempDir("waypoint-mcp-test-");
  const pinnedRoot = path.join(baseDir, "manga");
  const pinnedWorkDir = path.join(pinnedRoot, "work");
  await fs.mkdir(pinnedWorkDir, { recursive: true });

  await withTemporaryEnv(
    {
      WAYPOINT_MCP_OUTPUT_ROOT: pinnedRoot,
      WAYPOINT_MCP_OUTPUT_SUBDIR: "work",
    },
    async () => {
      const app = Fastify();
      await registerMcpServiceRoutes(app, makePaths(baseDir), {
        runImageGeneration: async () => ({
          model: "mock/diffusion",
          statusCode: 200,
          headers: { "content-type": "application/json" },
          payload: { created: 1730000000, data: [{ b64_json: "AQID" }] },
          route: {
            endpointId: "ep-1",
            endpointName: "mock",
            upstreamModel: "upstream",
          },
        }),
        normalizeImageGenerationPayload: async () => ({
          model: "mock/diffusion",
          created: 1730000000,
          images: [{ index: 0, b64_json: "AQID" }],
        }),
      });

      const init = await app.inject({
        method: "POST",
        url: "/mcp",
        headers: MCP_HEADERS,
        payload: {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "test", version: "1.0.0" },
          },
        },
      });
      const sessionId = init.headers["mcp-session-id"] as string;
      await app.inject({
        method: "POST",
        url: "/mcp",
        headers: { ...MCP_HEADERS, "mcp-session-id": sessionId },
        payload: { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
      });

      const call = await app.inject({
        method: "POST",
        url: "/mcp",
        headers: { ...MCP_HEADERS, "mcp-session-id": sessionId },
        payload: {
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: {
            name: "generate_image",
            arguments: {
              prompt: "any",
              workspace_root: pinnedRoot,
              output_dir: "./work",
            },
          },
        },
      });
      assert.equal(call.statusCode, 200);
      const callJson = call.json() as {
        result?: { content?: Array<{ type: string; text?: string }> };
      };
      const text = callJson.result?.content?.find((item) => item.type === "text")?.text ?? "{}";
      const payload = JSON.parse(text) as { ok: boolean; file_path: string };
      assert.equal(payload.ok, true);
      assert.match(payload.file_path, /^work\/image-1730000000-0\.png$/);
      const written = await fs.readFile(path.join(pinnedRoot, payload.file_path));
      assert.equal(written.length, 3);

      await app.close();
    }
  );
});

test("mcp generate_image forces b64_json when writing files", async () => {
  const baseDir = await makeWorkspaceTempDir("waypoint-mcp-test-");
  let observedResponseFormat: string | undefined;
  const app = Fastify();
  await registerMcpServiceRoutes(app, makePaths(baseDir), {
    runImageGeneration: async (_paths, request) => {
      observedResponseFormat = request.response_format;
      return {
        model: "mock/diffusion",
        statusCode: 200,
        headers: { "content-type": "application/json" },
        payload: { created: 1730000000, data: [{ b64_json: "AQID" }] },
        route: {
          endpointId: "ep-1",
          endpointName: "mock",
          upstreamModel: "upstream",
        },
      };
    },
    normalizeImageGenerationPayload: async () => ({
      model: "mock/diffusion",
      created: 1730000000,
      images: [{ index: 0, b64_json: "AQID" }],
    }),
  });

  const init = await app.inject({
    method: "POST",
    url: "/mcp",
    headers: MCP_HEADERS,
    payload: {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test", version: "1.0.0" },
      },
    },
  });
  const sessionId = init.headers["mcp-session-id"] as string;
  await app.inject({
    method: "POST",
    url: "/mcp",
    headers: { ...MCP_HEADERS, "mcp-session-id": sessionId },
    payload: { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
  });

  const call = await app.inject({
    method: "POST",
    url: "/mcp",
    headers: { ...MCP_HEADERS, "mcp-session-id": sessionId },
    payload: {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "generate_image",
        arguments: {
          prompt: "any",
          workspace_root: baseDir,
          response_format: "url",
          output_path: "./img-{index}.png",
        },
      },
    },
  });
  assert.equal(call.statusCode, 200);
  assert.equal(observedResponseFormat, "b64_json");

  await app.close();
});

test("mcp generate_image accepts image_url for edit-style generation", async () => {
  const baseDir = await makeWorkspaceTempDir("waypoint-mcp-test-");
  let observedImageUrl: string | undefined;
  const app = Fastify();
  await registerMcpServiceRoutes(app, makePaths(baseDir), {
    runImageGeneration: async (_paths, request) => {
      observedImageUrl = request.image_url;
      return {
        model: "mock/diffusion",
        statusCode: 200,
        headers: { "content-type": "application/json" },
        payload: { created: 1730000000, data: [{ b64_json: "AQID" }] },
        route: {
          endpointId: "ep-1",
          endpointName: "mock",
          upstreamModel: "upstream",
        },
      };
    },
    normalizeImageGenerationPayload: async () => ({
      model: "mock/diffusion",
      created: 1730000000,
      images: [{ index: 0, b64_json: "AQID", url: "data:image/png;base64,AQID" }],
    }),
  });

  const init = await app.inject({
    method: "POST",
    url: "/mcp",
    headers: MCP_HEADERS,
    payload: {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test", version: "1.0.0" },
      },
    },
  });
  const sessionId = init.headers["mcp-session-id"] as string;
  await app.inject({
    method: "POST",
    url: "/mcp",
    headers: { ...MCP_HEADERS, "mcp-session-id": sessionId },
    payload: { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
  });

  const call = await app.inject({
    method: "POST",
    url: "/mcp",
    headers: { ...MCP_HEADERS, "mcp-session-id": sessionId },
    payload: {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "generate_image",
        arguments: {
          prompt: "edit",
          image_url: "data:image/png;base64,AQID",
          workspace_root: baseDir,
        },
      },
    },
  });
  assert.equal(call.statusCode, 200);
  assert.equal(observedImageUrl, "data:image/png;base64,AQID");
  await app.close();
});

test("mcp generate_image accepts image_path for edit-style generation", async () => {
  const baseDir = await makeWorkspaceTempDir("waypoint-mcp-test-");
  const inputPath = path.join(baseDir, "input.png");
  const onePixelPngBase64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7Zk3cAAAAASUVORK5CYII=";
  await fs.writeFile(inputPath, Buffer.from(onePixelPngBase64, "base64"));

  let observedImageUrl: string | undefined;
  const app = Fastify();
  await registerMcpServiceRoutes(app, makePaths(baseDir), {
    runImageGeneration: async (_paths, request) => {
      observedImageUrl = request.image_url;
      return {
        model: "mock/diffusion",
        statusCode: 200,
        headers: { "content-type": "application/json" },
        payload: { created: 1730000000, data: [{ b64_json: "AQID" }] },
        route: {
          endpointId: "ep-1",
          endpointName: "mock",
          upstreamModel: "upstream",
        },
      };
    },
    normalizeImageGenerationPayload: async () => ({
      model: "mock/diffusion",
      created: 1730000000,
      images: [{ index: 0, b64_json: "AQID", url: "data:image/png;base64,AQID" }],
    }),
  });

  const init = await app.inject({
    method: "POST",
    url: "/mcp",
    headers: MCP_HEADERS,
    payload: {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test", version: "1.0.0" },
      },
    },
  });
  const sessionId = init.headers["mcp-session-id"] as string;
  await app.inject({
    method: "POST",
    url: "/mcp",
    headers: { ...MCP_HEADERS, "mcp-session-id": sessionId },
    payload: { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
  });

  const call = await app.inject({
    method: "POST",
    url: "/mcp",
    headers: { ...MCP_HEADERS, "mcp-session-id": sessionId },
    payload: {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "generate_image",
        arguments: {
          prompt: "edit",
          image_path: inputPath,
          workspace_root: baseDir,
        },
      },
    },
  });
  assert.equal(call.statusCode, 200);
  assert.ok(observedImageUrl?.startsWith("data:image/png;base64,"));
  await app.close();
});

test("mcp generate_image rejects conflicting image_path and image_url", async () => {
  const baseDir = await makeWorkspaceTempDir("waypoint-mcp-test-");
  const app = Fastify();
  await registerMcpServiceRoutes(app, makePaths(baseDir), {
    runImageGeneration: async () => {
      throw new Error("should not run");
    },
  });

  const init = await app.inject({
    method: "POST",
    url: "/mcp",
    headers: MCP_HEADERS,
    payload: {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test", version: "1.0.0" },
      },
    },
  });
  const sessionId = init.headers["mcp-session-id"] as string;
  await app.inject({
    method: "POST",
    url: "/mcp",
    headers: { ...MCP_HEADERS, "mcp-session-id": sessionId },
    payload: { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
  });

  const call = await app.inject({
    method: "POST",
    url: "/mcp",
    headers: { ...MCP_HEADERS, "mcp-session-id": sessionId },
    payload: {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "generate_image",
        arguments: {
          prompt: "edit",
          image_path: "/tmp/a.png",
          image_url: "https://example.com/a.png",
          workspace_root: baseDir,
        },
      },
    },
  });
  const callJson = call.json() as {
    result?: { content?: Array<{ type: string; text?: string }>; isError?: boolean };
  };
  assert.equal(callJson.result?.isError, true);
  assert.match(
    callJson.result?.content?.find((item) => item.type === "text")?.text ?? "",
    /"type":"invalid_request"/
  );
  await app.close();
});

test("mcp understand_image returns structured success output", async () => {
  const baseDir = await makeWorkspaceTempDir("waypoint-mcp-test-");
  const app = Fastify();
  await registerMcpServiceRoutes(app, makePaths(baseDir), {
    runImageUnderstanding: async () => ({
      model: "mock/vision",
      analysis: {
        answer: "A stop sign on a street",
        ocr_text: "STOP",
        objects: ["stop sign", "street"],
        scene: "urban roadside",
        notable_details: ["daylight"],
        safety_notes: [],
      },
      raw_text: "A stop sign on a street",
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }),
  });

  const init = await app.inject({
    method: "POST",
    url: "/mcp",
    headers: MCP_HEADERS,
    payload: {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test", version: "1.0.0" },
      },
    },
  });
  const sessionId = init.headers["mcp-session-id"] as string;
  await app.inject({
    method: "POST",
    url: "/mcp",
    headers: { ...MCP_HEADERS, "mcp-session-id": sessionId },
    payload: { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
  });

  const call = await app.inject({
    method: "POST",
    url: "/mcp",
    headers: { ...MCP_HEADERS, "mcp-session-id": sessionId },
    payload: {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "understand_image",
        arguments: {
          image_url: "data:image/png;base64,AQID",
        },
      },
    },
  });
  assert.equal(call.statusCode, 200);
  const callJson = call.json() as {
    result?: {
      content?: Array<{ type: string; text?: string }>;
      isError?: boolean;
      structuredContent?: {
        ok: boolean;
        text: string;
        result: { ocr_text: string };
        image_geometry?: unknown;
      };
    };
  };
  assert.equal(callJson.result?.isError ?? false, false);
  const text = callJson.result?.content?.find((item) => item.type === "text")?.text ?? "{}";
  const payload = JSON.parse(text) as { ok: boolean; text: string; summary: string; model: string };
  assert.equal(payload.ok, true);
  assert.equal(payload.text, "A stop sign on a street");
  assert.equal(payload.summary, "Image analyzed.");
  assert.equal(callJson.result?.structuredContent?.result.ocr_text, "STOP");
  assert.equal(callJson.result?.structuredContent?.image_geometry, undefined);

  await app.close();
});

test("mcp understand_image forwards image_geometry when available", async () => {
  const baseDir = await makeWorkspaceTempDir("waypoint-mcp-test-");
  const app = Fastify();
  await registerMcpServiceRoutes(app, makePaths(baseDir), {
    runImageUnderstanding: async () => ({
      model: "mock/vision",
      analysis: {
        answer: "Object at point",
        ocr_text: "",
        objects: ["object"],
        scene: "scene",
        notable_details: [],
        safety_notes: [],
      },
      raw_text: "Object at point",
      image_geometry: {
        original_width: 2000,
        original_height: 1200,
        uploaded_width: 1080,
        uploaded_height: 648,
        scale_x: 2000 / 1080,
        scale_y: 1200 / 648,
        resized: true,
      },
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }),
  });

  const init = await app.inject({
    method: "POST",
    url: "/mcp",
    headers: MCP_HEADERS,
    payload: {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test", version: "1.0.0" },
      },
    },
  });
  const sessionId = init.headers["mcp-session-id"] as string;
  await app.inject({
    method: "POST",
    url: "/mcp",
    headers: { ...MCP_HEADERS, "mcp-session-id": sessionId },
    payload: { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
  });

  const call = await app.inject({
    method: "POST",
    url: "/mcp",
    headers: { ...MCP_HEADERS, "mcp-session-id": sessionId },
    payload: {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "understand_image",
        arguments: {
          image_url: "data:image/png;base64,AQID",
        },
      },
    },
  });
  assert.equal(call.statusCode, 200);
  const callJson = call.json() as {
    result?: {
      content?: Array<{ type: string; text?: string }>;
      isError?: boolean;
      structuredContent?: {
        ok: boolean;
        image_geometry?: { original_width: number; resized: boolean };
      };
    };
  };
  assert.equal(callJson.result?.isError ?? false, false);
  const text = callJson.result?.content?.find((item) => item.type === "text")?.text ?? "{}";
  const payload = JSON.parse(text) as { ok: boolean; text: string };
  assert.equal(payload.ok, true);
  assert.equal(payload.text, "Object at point");
  assert.equal(callJson.result?.structuredContent?.image_geometry?.original_width, 2000);
  assert.equal(callJson.result?.structuredContent?.image_geometry?.resized, true);

  await app.close();
});

test("mcp understand_image rejects missing or conflicting image sources", async () => {
  const baseDir = await makeWorkspaceTempDir("waypoint-mcp-test-");
  const app = Fastify();
  await registerMcpServiceRoutes(app, makePaths(baseDir), {
    runImageUnderstanding: async () => {
      throw new Error("should not run");
    },
  });

  const init = await app.inject({
    method: "POST",
    url: "/mcp",
    headers: MCP_HEADERS,
    payload: {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test", version: "1.0.0" },
      },
    },
  });
  const sessionId = init.headers["mcp-session-id"] as string;
  await app.inject({
    method: "POST",
    url: "/mcp",
    headers: { ...MCP_HEADERS, "mcp-session-id": sessionId },
    payload: { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
  });

  const conflict = await app.inject({
    method: "POST",
    url: "/mcp",
    headers: { ...MCP_HEADERS, "mcp-session-id": sessionId },
    payload: {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "understand_image",
        arguments: {
          image_path: "/tmp/a.png",
          image_url: "https://example.com/a.png",
        },
      },
    },
  });
  const conflictJson = conflict.json() as {
    result?: { content?: Array<{ type: string; text?: string }>; isError?: boolean };
  };
  assert.equal(conflictJson.result?.isError, true);
  assert.match(
    conflictJson.result?.content?.find((item) => item.type === "text")?.text ?? "",
    /"type":"invalid_request"/
  );

  const missing = await app.inject({
    method: "POST",
    url: "/mcp",
    headers: { ...MCP_HEADERS, "mcp-session-id": sessionId },
    payload: {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "understand_image",
        arguments: {},
      },
    },
  });
  const missingJson = missing.json() as {
    result?: { content?: Array<{ type: string; text?: string }>; isError?: boolean };
  };
  assert.equal(missingJson.result?.isError, true);
  assert.match(
    missingJson.result?.content?.find((item) => item.type === "text")?.text ?? "",
    /"type":"invalid_request"/
  );

  await app.close();
});

test("mcp understand_image returns typed no_vision_model error", async () => {
  const baseDir = await makeWorkspaceTempDir("waypoint-mcp-test-");
  const app = Fastify();
  await registerMcpServiceRoutes(app, makePaths(baseDir), {
    runImageUnderstanding: async () => {
      const err = new Error("No vision model");
      (err as Error & { type: string }).type = "no_vision_model";
      throw err;
    },
  });

  const init = await app.inject({
    method: "POST",
    url: "/mcp",
    headers: MCP_HEADERS,
    payload: {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test", version: "1.0.0" },
      },
    },
  });
  const sessionId = init.headers["mcp-session-id"] as string;
  await app.inject({
    method: "POST",
    url: "/mcp",
    headers: { ...MCP_HEADERS, "mcp-session-id": sessionId },
    payload: { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
  });

  const call = await app.inject({
    method: "POST",
    url: "/mcp",
    headers: { ...MCP_HEADERS, "mcp-session-id": sessionId },
    payload: {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "understand_image",
        arguments: { image_url: "data:image/png;base64,AQID" },
      },
    },
  });
  const callJson = call.json() as {
    result?: { content?: Array<{ type: string; text?: string }>; isError?: boolean };
  };
  assert.equal(callJson.result?.isError, true);
  assert.match(
    callJson.result?.content?.find((item) => item.type === "text")?.text ?? "",
    /"type":"no_vision_model"/
  );

  await app.close();
});
