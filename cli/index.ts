#!/usr/bin/env node
import { Command } from "commander";
import {
  createEndpoint,
  deleteEndpointByIdOrName,
  getUsageByEndpoint,
  listEndpoints,
  updateHealthCheck
} from "../src/storage/repositories";
import { Agent, request } from "undici";
import { ensureStorageDir, loadConfig, resolveStoragePaths, saveConfig } from "../src/storage/files";
import { spawn, spawnSync } from "child_process";
import fs from "fs";
import path from "path";
import { routeRequest } from "../src/routing/router";
import { resolveModelMappings } from "../src/utils/modelDiscovery";

const program = new Command();

const paths = resolveStoragePaths();
const pidFile = path.join(paths.baseDir, "waypoint.pid");

program
  .name("waypoint")
  .description("Waypoint admin CLI")
  .version("0.1.0");

program
  .command("add")
  .requiredOption("--name <name>")
  .requiredOption("--url <url>")
  .requiredOption("--priority <priority>")
  .option("--type <type>", "Endpoint type: llm or diffusion", "llm")
  .option("--insecureTls", "Allow self-signed TLS")
  .option("--apiKey <apiKey>")
  .option("--model <mapping...>", "Model mapping as public=upstream")
  .action(async (options) => {
    await ensureStorageDir(paths);
    const mappings = await resolveModelMappings(
      {
        baseUrl: options.url,
        apiKey: options.apiKey,
        insecureTls: Boolean(options.insecureTls)
      },
      parseMappings(options.model ?? [])
    );
    const endpoint = await createEndpoint(paths, {
      name: options.name,
      baseUrl: options.url,
      apiKey: options.apiKey,
      insecureTls: Boolean(options.insecureTls),
      priority: Number(options.priority),
      type: normalizeType(options.type),
      models: mappings
    });
    console.log(JSON.stringify(endpoint, null, 2));
  });

program
  .command("ls")
  .action(async () => {
    await ensureStorageDir(paths);
    const endpoints = await listEndpoints(paths);
    if (endpoints.length === 0) {
      console.log("No endpoints found.");
      return;
    }
    console.table(
      endpoints.map((endpoint) => ({
        id: endpoint.id,
        name: endpoint.name,
        baseUrl: endpoint.baseUrl,
        type: endpoint.type,
        status: endpoint.health.status,
        priority: endpoint.priority
      }))
    );
  });

program
  .command("test")
  .argument("<model>")
  .action(async (model) => {
    await ensureStorageDir(paths);
    const start = Date.now();
    const controller = new AbortController();
    try {
      const type = await resolveModelType(model);
      const isImage = type === "diffusion";
      const requestPath = isImage ? "/v1/images/generations" : "/v1/chat/completions";
      const payload = isImage
        ? { model, prompt: "A small blue square on a white background." }
        : { model, messages: [{ role: "user", content: "Say hello in one short sentence." }], max_tokens: 32 };
      const outcome = await routeRequest(paths, model, requestPath, payload, {}, controller.signal);
      const responseBody = await readResponsePayload(outcome.attempt.response);
      const latency = Date.now() - start;
      console.log(JSON.stringify({ status: outcome.attempt.response.statusCode, latencyMs: latency, response: responseBody }, null, 2));
    } catch (error) {
      console.error((error as Error).message);
      process.exitCode = 1;
    }
  });

program
  .command("rm")
  .argument("<idOrName>")
  .action(async (idOrName) => {
    await ensureStorageDir(paths);
    const endpoint = await deleteEndpointByIdOrName(paths, idOrName);
    if (!endpoint) {
      console.error("Endpoint not found");
      process.exitCode = 1;
      return;
    }
    console.log(JSON.stringify({ deleted: endpoint.name, id: endpoint.id }, null, 2));
  });

program
  .command("edit")
  .description("Open the config file in your editor")
  .action(async () => {
    await ensureStorageDir(paths);
    const config = await loadConfig(paths);
    if (!config.endpoints) {
      await saveConfig(paths, { endpoints: [] });
    }
    const editor = process.env.EDITOR ?? "vim";
    const result = spawnSync(editor, [paths.configPath], { stdio: "inherit" });
    process.exitCode = result.status ?? 0;
  });

program
  .command("stat")
  .description("Run a health check against each endpoint")
  .action(async () => {
    await ensureStorageDir(paths);
    const endpoints = await listEndpoints(paths);
    if (endpoints.length === 0) {
      console.log("No endpoints found.");
      return;
    }
    const results = await Promise.all(
      endpoints.map(async (endpoint) => {
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
          const status = response.statusCode >= 200 && response.statusCode < 500 ? "up" : "down";
          await updateHealthCheck(paths, endpoint.id, status, status === "up" ? latency : null);
          return { name: endpoint.name, status, latencyMs: latency };
        } catch (error) {
          await updateHealthCheck(paths, endpoint.id, "down", null);
          return { name: endpoint.name, status: "down", error: (error as Error).message };
        }
      })
    );
    console.table(results);
  });

program
  .command("acct")
  .description("Aggregate token usage per endpoint from logs")
  .action(async () => {
    await ensureStorageDir(paths);
    const endpoints = await listEndpoints(paths);
    const usage = await getUsageByEndpoint(paths);
    if (usage.length === 0) {
      console.log("No usage records found.");
      return;
    }
    const byId = new Map(usage.map((entry) => [entry.endpointId, entry]));
    const rows = endpoints.map((endpoint) => {
      const entry = byId.get(endpoint.id);
      return {
        id: endpoint.id,
        name: endpoint.name,
        totalTokens: entry?.totalTokens ?? 0,
        requests: entry?.count ?? 0
      };
    });
    console.table(rows);
  });

const service = program
  .command("service")
  .description("Manage the Waypoint service process");

service
  .command("start")
  .description("Start Waypoint in the background (PID file)")
  .action(async () => {
    await startService();
  });

service
  .command("stop")
  .description("Stop Waypoint")
  .action(async () => {
    await stopService();
  });

service
  .command("restart")
  .description("Restart Waypoint")
  .action(async () => {
    await stopService();
    await startService();
  });

service
  .command("status")
  .description("Show service status")
  .action(async () => {
    await ensureStorageDir(paths);
    const pid = readPid(pidFile);
    if (pid && isRunning(pidFile)) {
      console.log(`Waypoint is running (pid ${pid}).`);
      return;
    }
    console.log("Waypoint is not running.");
  });

program.parseAsync().catch((error) => {
  console.error(error);
  process.exit(1);
});

function parseMappings(values: string[]): { publicName: string; upstreamModel: string }[] {
  return values.map((value) => {
    const parts = value.split("=");
    if (parts.length === 1) {
      const name = parts[0].trim();
      if (!name) {
        throw new Error(`Invalid mapping: ${value}`);
      }
      return { publicName: name, upstreamModel: name };
    }
    const [publicName, upstreamModel] = parts;
    if (!publicName || !upstreamModel) {
      throw new Error(`Invalid mapping: ${value}`);
    }
    return { publicName: publicName.trim(), upstreamModel: upstreamModel.trim() };
  });
}

function isImageModel(model: string): boolean {
  const name = model.toLowerCase();
  return name.includes("diffusion") || name.includes("stable") || name.includes("sd") || name.includes("flux");
}

async function resolveModelType(model: string): Promise<"llm" | "diffusion"> {
  const endpoints = await listEndpoints(paths);
  const match = endpoints.find((endpoint) =>
    endpoint.models.some((entry) => entry.publicName === model)
  );
  if (match) {
    return match.type;
  }
  return isImageModel(model) ? "diffusion" : "llm";
}

function normalizeType(value: string): "llm" | "diffusion" {
  return value === "diffusion" ? "diffusion" : "llm";
}

async function readResponsePayload(response: { body: NodeJS.ReadableStream; headers: Record<string, string | string[]> }): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of response.body) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const buffer = Buffer.concat(chunks);
  const contentType = normalizeHeaders(response.headers)["content-type"] ?? "";
  if (contentType.includes("application/json")) {
    try {
      return JSON.parse(buffer.toString("utf8"));
    } catch {
      return buffer.toString("utf8");
    }
  }
  return buffer.toString("utf8");
}

function normalizeHeaders(headers: Record<string, string | string[]>): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    normalized[key.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
  }
  return normalized;
}

function readPid(filePath: string): number | null {
  try {
    const raw = fs.readFileSync(filePath, "utf8").trim();
    const pid = Number(raw);
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}

function isRunning(filePath: string): boolean {
  const pid = readPid(filePath);
  if (!pid) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function startService(): Promise<void> {
  await ensureStorageDir(paths);
  const existingPid = readPid(pidFile);
  if (existingPid) {
    if (isRunning(pidFile)) {
      console.log("Waypoint is already running.");
      return;
    }
    fs.unlinkSync(pidFile);
  }
  const rootDir = getPackageRoot();
  const entry = path.join(rootDir, "dist", "src", "index.js");
  if (!fs.existsSync(entry)) {
    console.error(`Missing ${entry}. Run npm run build first.`);
    process.exitCode = 1;
    return;
  }
  const child = spawn(process.execPath, [entry], {
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env
    }
  });
  if (!child.pid) {
    console.error("Failed to start Waypoint.");
    process.exitCode = 1;
    return;
  }
  child.unref();
  fs.writeFileSync(pidFile, String(child.pid), "utf8");
  console.log(`Waypoint started (pid ${child.pid}).`);
}

async function stopService(): Promise<void> {
  await ensureStorageDir(paths);
  const pid = readPid(pidFile);
  if (!pid) {
    console.log("Waypoint is not running.");
    return;
  }
  try {
    process.kill(pid);
    fs.unlinkSync(pidFile);
    console.log("Waypoint stopped.");
  } catch (error) {
    console.error(`Failed to stop: ${(error as Error).message}`);
    process.exitCode = 1;
  }
}

function getPackageRoot(): string {
  const dir = __dirname;
  const base = path.basename(dir);
  const parent = path.basename(path.dirname(dir));
  if (base === "cli" && parent === "dist") {
    return path.resolve(dir, "..", "..");
  }
  return path.resolve(dir, "..");
}
