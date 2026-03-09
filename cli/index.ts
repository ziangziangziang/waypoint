#!/usr/bin/env node
import { Command } from "commander";
import {
  getModelCapabilitiesForEndpoint,
  getUsageByEndpoint,
  listEndpoints,
  setEndpointDisabled,
  updateHealthCheck
} from "../src/storage/repositories";
import { Agent, request } from "undici";
import { ensureStorageDir, resolveStoragePaths } from "../src/storage/files";
import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { routeRequest } from "../src/routing/router";
import { aggregateStats } from "../src/storage/statsRepository";
import { listMcpServers, addMcpServer, removeMcpServer, updateMcpServer } from "../src/mcp/registry";
import { runBenchmark } from "../src/benchmark/runner";
import { importProviders } from "../src/providers/importer";
import { listModelsForApi } from "../src/providers/modelRegistry";
import { getProviderModelHealthMap, probeProviderModels } from "../src/providers/health";
import {
  canonicalProviderModelId,
  deleteProviderModel,
  getProviderById,
  getProviderModel,
  listProviderModels,
  listProviders,
  setProviderModelApiKey,
  setProviderModelEnabled,
  setProviderEnabled,
  updateProvider,
  updateProviderModel,
  normalizeDomainSuffixes,
  upsertProvider,
  upsertProviderModel,
} from "../src/providers/repository";
import { rebuildDefaultPools } from "../src/pools/builder";
import { listPools } from "../src/pools/repository";
import { canonicalizeProtocol, hasProtocolAdapter, listAdapterOperations } from "../src/protocols/registry";
import { ProviderModelRecord, ProviderProtocol, ProviderRecord } from "../src/providers/types";
import { ModelCapabilities, ModelModality } from "../src/types";
import { rewriteLegacyArgv, LegacyRewriteResult } from "./legacyRewrite";
import { parseModelRef } from "./modelRef";

const program = new Command();

type CanonicalCommandContext = {
  json?: boolean;
  quiet?: boolean;
  noColor?: boolean;
};

const paths = resolveStoragePaths();
const pidFile = path.join(paths.baseDir, "waypoint.pid");

function resolveDefaultRegistryPath(): string {
  const candidates = [
    path.resolve(process.cwd(), "providers/free-llm-api/registry.yaml"),
    path.resolve(__dirname, "../providers/free-llm-api/registry.yaml"),
    path.resolve(__dirname, "../../providers/free-llm-api/registry.yaml"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return candidates[0];
}

/**
 * Perform an on-demand health check for all endpoints.
 * Updates health.json with fresh status before returning.
 */
async function refreshHealthStatus(): Promise<void> {
  const endpoints = (await listEndpoints(paths)).filter((endpoint) => !endpoint.disabled);
  await Promise.all(
    endpoints.map(async (endpoint) => {
      const start = Date.now();
      try {
        const dispatcher = endpoint.insecureTls
          ? new Agent({ connect: { rejectUnauthorized: false } })
          : undefined;
        const url = new URL("/v1/models", endpoint.baseUrl).toString();
        const headers: Record<string, string> = {};
        if (endpoint.apiKey) {
          headers.authorization = `Bearer ${endpoint.apiKey}`;
        }
        const response = await request(url, {
          method: "GET",
          headers,
          headersTimeout: 3000,
          bodyTimeout: 3000,
          dispatcher
        });
        const latency = Date.now() - start;
        response.body.resume();
        if (response.statusCode >= 200 && response.statusCode < 300) {
          await updateHealthCheck(paths, endpoint.id, "up", latency);
          console.log(`✓ ${endpoint.name}: UP (${response.statusCode}, ${latency}ms)`);
        } else {
          await updateHealthCheck(paths, endpoint.id, "down", null);
          console.log(`✗ ${endpoint.name}: DOWN (status ${response.statusCode})`);
        }
      } catch (error) {
        await updateHealthCheck(paths, endpoint.id, "down", null);
        const errorMsg = (error as Error).message || "unknown error";
        console.log(`✗ ${endpoint.name}: DOWN (${errorMsg})`);
      }
    })
  );
}

function printJson(payload: unknown): void {
  console.log(JSON.stringify(payload, null, 2));
}

function printWarning(message: string): void {
  console.error(message);
}

function printErrorWithSuggestion(message: string, suggestions: string[] = []): void {
  console.error(message);
  for (const suggestion of suggestions) {
    console.error(suggestion);
  }
}

function warnLegacyRewrite(result: LegacyRewriteResult): void {
  if (!result.legacyUsed || process.env.WAYPOINT_NO_WARN === "1") {
    return;
  }
  const oldCmd = result.oldCmd ?? "";
  const newCmd = result.newCmd ? `waypoint ${result.newCmd}` : "waypoint --help";
  printWarning(`Deprecated command: ${oldCmd}`);
  printWarning(`Use instead: ${newCmd}`);
}

program
  .name("waypoint")
  .description("Waypoint proxy and operations CLI")
  .version("0.5.3")
  .option("--json", "Machine-readable JSON output where supported")
  .option("--quiet", "Suppress non-essential output")
  .option("--no-color", "Disable ANSI color output");

program.addHelpText(
  "after",
  `
Examples:
  waypoint providers
  waypoint models
  waypoint models show provider-id/model-id
  waypoint service
  waypoint logs -f
  waypoint bench --suite smoke
`
);

program
  .command("add")
  .description("Add a new endpoint")
  .requiredOption("--name <name>", "Endpoint display name")
  .requiredOption("--url <url>", "Base URL of the endpoint")
  .requiredOption("--priority <priority>", "Routing priority (lower = preferred)")
  .option("--type <type>", "Endpoint type: llm (chat/completions), diffusion (/images/generations), audio, embedding", "llm")
  .option("--insecureTls", "Allow self-signed TLS certificates")
  .option("--apiKey <apiKey>", "Bearer token for Authorization header")
  .option("--model <mapping...>", "Model mapping as 'public' or 'public=upstream'. If endpoint has 1 model, upstream is auto-detected.")
  .action(async () => {
    console.error(
      "Endpoint writes are deprecated in v0.5.0. Use `waypoint provider model add ...` and migration commands."
    );
    process.exitCode = 1;
  });

program
  .command("ls")
  .option("--no-check", "Skip health check for faster listing")
  .option("--verbose", "Show full endpoint fields")
  .action(async (options) => {
    await ensureStorageDir(paths);
    // Refresh health status unless --no-check is specified
    if (options.check !== false) {
      await refreshHealthStatus();
    }
    const endpoints = await listEndpoints(paths);
    if (endpoints.length === 0) {
      console.log("No endpoints found.");
      return;
    }
    const rows = options.verbose
      ? endpoints.map((endpoint) => ({
          id: endpoint.id,
          name: endpoint.name,
          baseUrl: endpoint.baseUrl,
          type: endpoint.type,
          disabled: endpoint.disabled ? "yes" : "no",
          status: endpoint.health.status,
          priority: endpoint.priority,
        }))
      : endpoints.map((endpoint) => ({
          name: endpoint.name,
          host: compactEndpointUrl(endpoint.baseUrl),
          type: endpoint.type,
          disabled: endpoint.disabled ? "yes" : "no",
          status: endpoint.health.status,
          prio: endpoint.priority,
        }));
    console.table(rows);
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
  .action(async () => {
    console.error(
      "Endpoint writes are deprecated in v0.5.0. Disable or migrate endpoints instead of deleting them."
    );
    process.exitCode = 1;
  });

program
  .command("edit")
  .description("Open the config file in your editor")
  .action(async () => {
    console.error(
      "Endpoint config edit is blocked in v0.5.0. Use provider/model management commands instead."
    );
    process.exitCode = 1;
  });

program
  .command("stat")
  .description("Run a health check against each endpoint")
  .action(async () => {
    await ensureStorageDir(paths);
    const endpoints = await listEndpoints(paths);
    const activeEndpoints = endpoints.filter((endpoint) => !endpoint.disabled);
    if (activeEndpoints.length === 0) {
      console.log("No endpoints found.");
      return;
    }
    const results = await Promise.all(
      activeEndpoints.map(async (endpoint) => {
        const start = Date.now();
        try {
          const dispatcher = endpoint.insecureTls
            ? new Agent({ connect: { rejectUnauthorized: false } })
            : undefined;
          const headers: Record<string, string> = {};
          if (endpoint.apiKey) {
            headers.authorization = `Bearer ${endpoint.apiKey}`;
          }
          const response = await request(new URL("/v1/models", endpoint.baseUrl).toString(), {
            method: "GET",
            headers,
            headersTimeout: 3000,
            bodyTimeout: 3000,
            dispatcher
          });
          response.body.resume();
          const latency = Date.now() - start;
          const status = response.statusCode >= 200 && response.statusCode < 300 ? "up" : "down";
          await updateHealthCheck(paths, endpoint.id, status, status === "up" ? latency : null);
          return { name: endpoint.name, status, statusCode: response.statusCode, latencyMs: latency };
        } catch (error) {
          await updateHealthCheck(paths, endpoint.id, "down", null);
          return { name: endpoint.name, status: "down", error: (error as Error).message };
        }
      })
    );
    const disabledRows = endpoints
      .filter((endpoint) => endpoint.disabled)
      .map((endpoint) => ({
        name: endpoint.name,
        status: "disabled",
        error: "skipped (disabled)",
      }));
    if (disabledRows.length > 0) {
      results.push(...disabledRows);
    }
    console.table(results);
  });

// Alias: waypoint status -> waypoint stat
program
  .command("status")
  .description("Alias for 'stat' - Run a health check against each endpoint")
  .action(async () => {
    await ensureStorageDir(paths);
    const endpoints = await listEndpoints(paths);
    const activeEndpoints = endpoints.filter((endpoint) => !endpoint.disabled);
    if (activeEndpoints.length === 0) {
      console.log("No endpoints found.");
      return;
    }
    const results = await Promise.all(
      activeEndpoints.map(async (endpoint) => {
        const start = Date.now();
        try {
          const dispatcher = endpoint.insecureTls
            ? new Agent({ connect: { rejectUnauthorized: false } })
            : undefined;
          const headers: Record<string, string> = {};
          if (endpoint.apiKey) {
            headers.authorization = `Bearer ${endpoint.apiKey}`;
          }
          const response = await request(new URL("/v1/models", endpoint.baseUrl).toString(), {
            method: "GET",
            headers,
            headersTimeout: 3000,
            bodyTimeout: 3000,
            dispatcher
          });
          response.body.resume();
          const latency = Date.now() - start;
          const status = response.statusCode >= 200 && response.statusCode < 300 ? "up" : "down";
          await updateHealthCheck(paths, endpoint.id, status, status === "up" ? latency : null);
          return { name: endpoint.name, status, statusCode: response.statusCode, latencyMs: latency };
        } catch (error) {
          await updateHealthCheck(paths, endpoint.id, "down", null);
          return { name: endpoint.name, status: "down", error: (error as Error).message };
        }
      })
    );
    const disabledRows = endpoints
      .filter((endpoint) => endpoint.disabled)
      .map((endpoint) => ({
        name: endpoint.name,
        status: "disabled",
        error: "skipped (disabled)",
      }));
    if (disabledRows.length > 0) {
      results.push(...disabledRows);
    }
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
  .alias("srv")
  .description("Manage the Waypoint service process")
  .action(async () => {
    await ensureStorageDir(paths);
    const pid = readPid(pidFile);
    if (pid && isRunning(pidFile)) {
      console.log(`Waypoint is running (pid ${pid}).`);
      return;
    }
    console.log("Waypoint is not running.");
  });

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

// ─────────────────────────────────────────────────────────────────────────────
// Logs Command
// ─────────────────────────────────────────────────────────────────────────────

program
  .command("logs")
  .description("Tail the waypoint log file")
  .option("-f, --follow", "Follow log output (like tail -f)")
  .option("-n, --lines <n>", "Number of lines to show", "50")
  .action(async (options) => {
    await ensureStorageDir(paths);
    const logFile = path.join(paths.baseDir, "waypoint.log");
    
    if (!fs.existsSync(logFile)) {
      console.log("No log file found. Start the service first.");
      return;
    }

    const lines = Number(options.lines) || 50;
    
    if (options.follow) {
      // Tail with follow using spawn
      const tail = spawn("tail", ["-n", String(lines), "-f", logFile], {
        stdio: "inherit"
      });
      
      process.on("SIGINT", () => {
        tail.kill();
        process.exit(0);
      });
      
      await new Promise((resolve) => {
        tail.on("exit", resolve);
      });
    } else {
      // Just show last N lines
      try {
        const content = fs.readFileSync(logFile, "utf8");
        const allLines = content.split("\n");
        const lastLines = allLines.slice(-lines).join("\n");
        console.log(lastLines);
      } catch (error) {
        console.error(`Failed to read log file: ${(error as Error).message}`);
        process.exitCode = 1;
      }
    }
  });

// ─────────────────────────────────────────────────────────────────────────────
// Stats Command
// ─────────────────────────────────────────────────────────────────────────────

program
  .command("stats")
  .description("Show request statistics")
  .option("--window <window>", "Time window (e.g., 24h, 7d)", "7d")
  .option("--json", "Output as JSON")
  .action(async (options) => {
    await ensureStorageDir(paths);
    
    // Parse window
    const windowStr = options.window;
    let windowMs: number;
    if (windowStr.endsWith("h")) {
      windowMs = parseInt(windowStr) * 60 * 60 * 1000;
    } else if (windowStr.endsWith("d")) {
      windowMs = parseInt(windowStr) * 24 * 60 * 60 * 1000;
    } else {
      windowMs = parseInt(windowStr) || 7 * 24 * 60 * 60 * 1000;
    }
    
    try {
      const stats = await aggregateStats(paths, windowMs);
      
      if (options.json) {
        console.log(JSON.stringify(stats, null, 2));
        return;
      }
      
      // Pretty print
      console.log("\n📊 Waypoint Statistics");
      console.log(`   Window: ${stats.window}\n`);
      
      console.log("── Request Summary ──");
      console.log(`   Total:    ${stats.total}`);
      console.log(`   Success:  ${stats.success}`);
      console.log(`   Errors:   ${stats.errors}`);
      console.log(`   Rate:     ${stats.total > 0 ? ((stats.success / stats.total) * 100).toFixed(1) : 0}% success\n`);
      
      console.log("── Latency (ms) ──");
      console.log(`   Avg:  ${stats.avgLatencyMs?.toFixed(0) ?? "N/A"}`);
      console.log(`   P50:  ${stats.p50LatencyMs?.toFixed(0) ?? "N/A"}`);
      console.log(`   P95:  ${stats.p95LatencyMs?.toFixed(0) ?? "N/A"}`);
      console.log(`   P99:  ${stats.p99LatencyMs?.toFixed(0) ?? "N/A"}\n`);
      
      console.log("── Token Usage ──");
      console.log(`   Total:      ${stats.totalTokens.toLocaleString()}`);
      console.log(`   Per Hour:   ${stats.tokensPerHour?.toFixed(0) ?? "N/A"}\n`);
      
      if (Object.keys(stats.byModel).length > 0) {
        console.log("── By Model ──");
        console.table(
          Object.entries(stats.byModel).map(([model, data]) => ({
            model,
            requests: data.count,
            avgLatencyMs: data.avgLatencyMs.toFixed(0),
            tokens: data.tokens.toLocaleString()
          }))
        );
      }
      
      if (Object.keys(stats.byEndpoint).length > 0) {
        console.log("── By Endpoint ──");
        console.table(
          Object.entries(stats.byEndpoint).map(([id, data]) => ({
            id: id.slice(0, 8),
            requests: data.count,
            avgLatencyMs: data.avgLatencyMs.toFixed(0),
            tokens: data.tokens.toLocaleString(),
            errors: data.errors
          }))
        );
      }
    } catch (error) {
      console.error(`Failed to load stats: ${(error as Error).message}`);
      process.exitCode = 1;
    }
  });

// ─────────────────────────────────────────────────────────────────────────────
// MCP Commands
// ─────────────────────────────────────────────────────────────────────────────

async function listMcpServersAction(options: { json?: boolean } = {}): Promise<void> {
  await ensureStorageDir(paths);
  try {
    const servers = await listMcpServers(paths);

    if (servers.length === 0) {
      console.log("No MCP servers configured.");
      return;
    }

    if (options.json) {
      printJson(servers);
      return;
    }

    console.table(
      servers.map((s) => ({
        id: s.id.slice(0, 8),
        name: s.name,
        url: s.url,
        status: s.status,
        enabled: s.enabled ? "✓" : "✗",
        tools: s.toolCount ?? 0
      }))
    );
  } catch (error) {
    console.error(`Failed to list servers: ${(error as Error).message}`);
    process.exitCode = 1;
  }
}

const mcp = program
  .command("mcp")
  .description("Manage MCP servers for agentic workflows")
  .action(async () => {
    await listMcpServersAction();
  });

mcp
  .command("add")
  .description("Add a new MCP server")
  .requiredOption("--name <name>", "Server name")
  .requiredOption("--url <url>", "Server URL (streamable HTTP)")
  .option("--disabled", "Add as disabled")
  .action(async (options) => {
    await ensureStorageDir(paths);
    try {
      const server = await addMcpServer(paths, {
        name: options.name,
        url: options.url,
        enabled: !options.disabled
      });
      console.log(`Added MCP server: ${server.name}`);
      console.log(JSON.stringify(server, null, 2));
    } catch (error) {
      console.error(`Failed to add server: ${(error as Error).message}`);
      process.exitCode = 1;
    }
  });

mcp
  .command("list")
  .alias("ls")
  .description("List all MCP servers")
  .option("--json", "Output as JSON")
  .action(async (options) => {
    await listMcpServersAction(options);
  });

mcp
  .command("rm")
  .alias("remove")
  .description("Remove an MCP server")
  .argument("<idOrName>", "Server ID (prefix) or name")
  .action(async (idOrName) => {
    await ensureStorageDir(paths);
    try {
      const servers = await listMcpServers(paths);
      const server = servers.find(
        (s) => s.id.startsWith(idOrName) || s.name.toLowerCase() === idOrName.toLowerCase()
      );
      
      if (!server) {
        console.error("Server not found");
        process.exitCode = 1;
        return;
      }
      
      await removeMcpServer(paths, server.id);
      console.log(`Removed MCP server: ${server.name}`);
    } catch (error) {
      console.error(`Failed to remove server: ${(error as Error).message}`);
      process.exitCode = 1;
    }
  });

mcp
  .command("enable")
  .description("Enable an MCP server")
  .argument("<idOrName>", "Server ID (prefix) or name")
  .action(async (idOrName) => {
    await ensureStorageDir(paths);
    try {
      const servers = await listMcpServers(paths);
      const server = servers.find(
        (s) => s.id.startsWith(idOrName) || s.name.toLowerCase() === idOrName.toLowerCase()
      );
      
      if (!server) {
        console.error("Server not found");
        process.exitCode = 1;
        return;
      }
      
      await updateMcpServer(paths, server.id, { enabled: true });
      console.log(`Enabled MCP server: ${server.name}`);
    } catch (error) {
      console.error(`Failed to enable server: ${(error as Error).message}`);
      process.exitCode = 1;
    }
  });

mcp
  .command("disable")
  .description("Disable an MCP server")
  .argument("<idOrName>", "Server ID (prefix) or name")
  .action(async (idOrName) => {
    await ensureStorageDir(paths);
    try {
      const servers = await listMcpServers(paths);
      const server = servers.find(
        (s) => s.id.startsWith(idOrName) || s.name.toLowerCase() === idOrName.toLowerCase()
      );
      
      if (!server) {
        console.error("Server not found");
        process.exitCode = 1;
        return;
      }
      
      await updateMcpServer(paths, server.id, { enabled: false });
      console.log(`Disabled MCP server: ${server.name}`);
    } catch (error) {
      console.error(`Failed to disable server: ${(error as Error).message}`);
      process.exitCode = 1;
    }
  });

// ─────────────────────────────────────────────────────────────────────────────
// Provider Commands
// ─────────────────────────────────────────────────────────────────────────────

async function listProvidersAction(options: { json?: boolean; verbose?: boolean; check?: boolean } = {}): Promise<void> {
  await ensureStorageDir(paths);
  if (options.check !== false) {
    await probeProviderModels(paths);
  }
  const providers = await listProviders(paths);
  if (options.json) {
    printJson(providers);
    return;
  }
  if (providers.length === 0) {
    console.log("No providers imported.");
    return;
  }
  const healthMap = await getProviderModelHealthMap(paths);
  const rows = options.verbose
    ? providers.map((provider) => ({
        protocol: provider.protocolRaw ?? provider.protocol,
        operations:
          listAdapterOperations(provider.protocol)?.operations.join(",") ?? "-",
        streamOps:
          listAdapterOperations(provider.protocol)?.streamOperations.join(",") ?? "-",
        id: provider.id,
        name: provider.name,
        enabled: provider.enabled ? "yes" : "no",
        tls: provider.insecureTls ? "insecure" : "strict",
        autoInsecureDomains: provider.autoInsecureTlsDomains?.length ?? 0,
        routable: provider.supportsRouting ? "yes" : "no",
        models: provider.models.length,
        scored: provider.models.filter((model) => typeof model.benchmark?.livebench === "number")
          .length,
        hasKey: provider.apiKey || provider.models.some((model) => Boolean(model.apiKey)) ? "yes" : "no",
        health: summarizeProviderHealth(provider.models, healthMap),
      }))
    : providers.map((provider) => ({
        id: provider.id,
        protocol: provider.protocolRaw ?? provider.protocol,
        enabled: provider.enabled ? "yes" : "no",
        tls: provider.insecureTls ? "insecure" : "strict",
        autoInsecureDomains: provider.autoInsecureTlsDomains?.length ?? 0,
        models: provider.models.length,
        scored: provider.models.filter((model) => typeof model.benchmark?.livebench === "number")
          .length,
        hasKey: provider.apiKey || provider.models.some((model) => Boolean(model.apiKey)) ? "yes" : "no",
        health: summarizeProviderHealth(provider.models, healthMap),
      }));
  console.table(rows);
}

const provider = program
  .command("providers")
  .alias("provider")
  .alias("prov")
  .description("Manage provider catalog and smart pools")
  .action(async () => {
    await listProvidersAction();
  });

provider.addHelpText(
  "after",
  `
Default: \`waypoint providers\` runs \`providers list\`.
Examples:
  waypoint providers
  waypoint providers show provider-id
  waypoint providers import --registry ./providers/registry.yaml -f .env
`
);

provider
  .command("import")
  .description("Import providers from a registry and load credentials")
  .option(
    "--registry <path>",
    "Path to providers registry yaml",
    resolveDefaultRegistryPath()
  )
  .option("-f, --env-file <path>", "Path to .env file", ".env")
  .option("--overwrite-auth", "Overwrite stored provider keys with env values")
  .option("--no-rebuild-pools", "Skip automatic smart pool rebuild")
  .action(async (options) => {
    await ensureStorageDir(paths);
    try {
      const result = await importProviders(paths, {
        registryPath: options.registry,
        envFilePath: options.envFile,
        overwriteAuth: Boolean(options.overwriteAuth),
      });
      let rebuilt = 0;
      if (options.rebuildPools !== false) {
        const pools = await rebuildDefaultPools(paths);
        rebuilt = pools.length;
      }
      console.log(`Imported providers: ${result.importedProviders}`);
      console.log(`Imported models: ${result.importedModels}`);
      if (rebuilt > 0) {
        console.log(`Rebuilt pools: ${rebuilt}`);
      }
      if (result.warnings.length > 0) {
        console.log("Warnings:");
        for (const warning of result.warnings) {
          console.log(`  - ${warning}`);
        }
      }
    } catch (error) {
      console.error(`Provider import failed: ${(error as Error).message}`);
      process.exitCode = 1;
    }
  });

provider
  .command("ls")
  .alias("list")
  .description("List providers")
  .option("--json", "Output as JSON")
  .option("--verbose", "Show protocol operation details")
  .option("--no-check", "Skip health check for faster listing")
  .action(async (options) => {
    await listProvidersAction(options);
  });

provider
  .command("show")
  .description("Show one provider")
  .argument("<providerId>")
  .action(async (providerId) => {
    await ensureStorageDir(paths);
    const providerRecord = await getProviderById(paths, providerId);
    if (!providerRecord) {
      console.error("Provider not found");
      process.exitCode = 1;
      return;
    }
    const adapterOps = listAdapterOperations(providerRecord.protocol);
    console.log(
      JSON.stringify(
        {
          ...providerRecord,
          supportedOperations: adapterOps?.operations ?? [],
          streamSupportedOperations: adapterOps?.streamOperations ?? [],
        },
        null,
        2
      )
    );
  });

provider
  .command("update")
  .description("Update provider TLS policy and allowlist")
  .argument("<providerId>")
  .option("--insecure-tls", "Set provider default TLS mode to insecure")
  .option("--strict-tls", "Set provider default TLS mode to strict")
  .option("--auto-insecure-domain <suffix...>", "Set auto-insecure TLS allowlist domains")
  .option("--clear-auto-insecure-domains", "Clear auto-insecure TLS allowlist")
  .option("--no-rebuild", "Skip automatic smart pool rebuild")
  .action(async (providerId, options) => {
    await ensureStorageDir(paths);
    if (options.insecureTls && options.strictTls) {
      console.error("Choose either --insecure-tls or --strict-tls, not both.");
      process.exitCode = 1;
      return;
    }
    const patch: Partial<ProviderRecord> = {};
    if (options.insecureTls) {
      patch.insecureTls = true;
    }
    if (options.strictTls) {
      patch.insecureTls = false;
    }
    if (options.clearAutoInsecureDomains) {
      patch.autoInsecureTlsDomains = [];
    } else if (options.autoInsecureDomain) {
      patch.autoInsecureTlsDomains = normalizeDomainSuffixes(options.autoInsecureDomain);
    }

    if (Object.keys(patch).length === 0) {
      console.error("No provider changes requested.");
      process.exitCode = 1;
      return;
    }

    const updated = await updateProvider(paths, providerId, patch);
    if (!updated) {
      console.error("Provider not found");
      process.exitCode = 1;
      return;
    }
    if (options.rebuild !== false) {
      await rebuildDefaultPools(paths);
    }
    console.log(`Updated provider: ${updated.id}`);
  });

provider
  .command("models")
  .description("List models for a provider")
  .argument("<providerId>")
  .option("--free", "Only free models")
  .option("--modality <modality>", "Filter by modality (e.g., text-to-text,image-to-text)")
  .option("--json", "Output as JSON")
  .action(async (providerId, options) => {
    await ensureStorageDir(paths);
    const providerRecord = await getProviderById(paths, providerId);
    if (!providerRecord) {
      console.error("Provider not found");
      process.exitCode = 1;
      return;
    }
    const modality = typeof options.modality === "string" ? options.modality.trim() : undefined;
    const filtered = providerRecord.models.filter((model) => {
      if (options.free && !model.free) {
        return false;
      }
      if (modality && !model.modalities.includes(modality)) {
        return false;
      }
      return true;
    });
    if (options.json) {
      console.log(JSON.stringify(filtered, null, 2));
      return;
    }
    console.table(
      filtered.map((model) => ({
        id: model.modelId,
        upstream: model.upstreamModel,
        baseUrl: model.baseUrl ?? providerRecord.baseUrl,
        enabled: model.enabled === false ? "no" : "yes",
        free: model.free ? "yes" : "no",
        modalities: model.modalities.join(","),
        livebench: model.benchmark?.livebench ?? "-",
      }))
    );
  });

const providerModel = provider
  .command("model")
  .description("Manage provider-owned models");

providerModel
  .command("ls")
  .description("List models for a provider")
  .argument("<providerId>")
  .option("--json", "Output as JSON")
  .option("--enabled", "Only show enabled models")
  .option("--modality <modality>", "Filter by modality (e.g. text-to-text,image-to-text)")
  .option("--verbose", "Show full model metadata")
  .option("--no-check", "Skip health check for faster listing")
  .action(async (providerId, options) => {
    await ensureStorageDir(paths);
    if (options.check !== false) {
      await probeProviderModels(paths);
    }
    const healthMap = await getProviderModelHealthMap(paths);
    const models = await listProviderModels(paths, providerId);
    if (!models) {
      console.error("Provider not found");
      process.exitCode = 1;
      return;
    }

    const modality = typeof options.modality === "string" ? options.modality.trim() : undefined;
    const filtered = models.filter((model) => {
      if (options.enabled && model.enabled === false) {
        return false;
      }
      if (modality && !model.modalities.includes(modality)) {
        return false;
      }
      return true;
    });

    if (options.json) {
      console.log(JSON.stringify(filtered, null, 2));
      return;
    }

    const rows = options.verbose
      ? filtered.map((model) => ({
          providerModelId: model.providerModelId,
          modelId: model.modelId,
          upstreamModel: model.upstreamModel,
          enabled: model.enabled === false ? "no" : "yes",
          tls: model.insecureTls === undefined ? "inherit" : model.insecureTls ? "insecure" : "strict",
          endpointType: model.endpointType,
          baseUrl: model.baseUrl ?? "-",
          aliases: (model.aliases ?? []).join(","),
          free: model.free ? "yes" : "no",
          livebench: model.benchmark?.livebench ?? "-",
          status: healthMap[model.providerModelId]?.status ?? "-",
          latency: formatLatency(healthMap[model.providerModelId]?.latencyMsEwma),
          lastStatus: healthMap[model.providerModelId]?.lastStatusCode ?? "-",
          lastError: healthMap[model.providerModelId]?.lastError ?? "-",
        }))
      : filtered.map((model) => ({
          id: model.modelId,
          enabled: model.enabled === false ? "no" : "yes",
          tls: model.insecureTls === undefined ? "inherit" : model.insecureTls ? "insecure" : "strict",
          type: model.endpointType,
          aliases: (model.aliases ?? []).length,
          livebench: model.benchmark?.livebench ?? "-",
          status: healthMap[model.providerModelId]?.status ?? "-",
          latency: formatLatency(healthMap[model.providerModelId]?.latencyMsEwma),
          lastStatus: healthMap[model.providerModelId]?.lastStatusCode ?? "-",
          lastError: healthMap[model.providerModelId]?.lastError ?? "-",
        }));
    console.table(rows);
  });

providerModel
  .command("show")
  .description("Show one model from a provider")
  .argument("<providerId>")
  .argument("<modelRef>")
  .action(async (providerId, modelRef) => {
    await ensureStorageDir(paths);
    const model = await getProviderModel(paths, providerId, modelRef);
    if (!model) {
      console.error("Model not found");
      process.exitCode = 1;
      return;
    }
    console.log(JSON.stringify(model, null, 2));
  });

providerModel
  .command("add")
  .description("Add a model under a provider")
  .argument("<providerId>")
  .requiredOption("--model-id <id>", "Provider model ID suffix")
  .requiredOption("--upstream <name>", "Upstream model name")
  .requiredOption("--base-url <url>", "Base URL for this model")
  .option("--api-key <key>", "API key for this model")
  .option("--insecure-tls", "Allow self-signed TLS certificates for this model")
  .option("--endpoint-type <type>", "Endpoint type (llm|diffusion|audio|embedding)", "llm")
  .option("--capability <spec...>", "Capability spec, e.g. text->text or text+image->text")
  .option("--alias <alias...>", "Legacy/public aliases")
  .option("--free", "Mark model as free")
  .option("--no-free", "Mark model as not free")
  .option("--disabled", "Add model in disabled state")
  .option("--no-rebuild", "Skip automatic pool rebuild")
  .action(async (providerId, options) => {
    await ensureStorageDir(paths);
    const providerRecord = await getProviderById(paths, providerId);
    if (!providerRecord) {
      console.error("Provider not found");
      process.exitCode = 1;
      return;
    }

    const endpointType = normalizeType(options.endpointType);
    const capabilities = options.capability
      ? parseCapabilitySpecs(options.capability)
      : defaultCapabilitiesForEndpointType(endpointType);
    const modelId = String(options.modelId).trim();
    const providerModelId = canonicalProviderModelId(providerId, modelId);
    const modelRecord: ProviderModelRecord = {
      providerModelId,
      providerId,
      modelId,
      upstreamModel: String(options.upstream).trim(),
      baseUrl: String(options.baseUrl).trim(),
      apiKey: options.apiKey,
      insecureTls: options.insecureTls ? true : undefined,
      enabled: options.disabled ? false : true,
      aliases: normalizeAliasList(options.alias ?? []),
      free: options.free !== false,
      modalities: capabilitiesToModalities(capabilities),
      capabilities,
      endpointType,
    };
    const result = await upsertProviderModel(paths, providerId, modelRecord);
    if (!result) {
      console.error("Failed to add model");
      process.exitCode = 1;
      return;
    }
    if (options.rebuild !== false) {
      await rebuildDefaultPools(paths);
    }
    console.log(`Model ${result.created ? "added" : "updated"}: ${providerModelId}`);
  });

providerModel
  .command("update")
  .description("Update a provider model")
  .argument("<providerId>")
  .argument("<modelRef>")
  .option("--upstream <name>", "Set upstream model")
  .option("--base-url <url>", "Set base URL")
  .option("--clear-base-url", "Clear model-specific base URL override")
  .option("--api-key <key>", "Set API key")
  .option("--clear-api-key", "Clear model-specific API key")
  .option("--insecure-tls", "Enable insecure TLS for this model")
  .option("--clear-insecure-tls", "Clear model TLS override and inherit provider setting")
  .option("--endpoint-type <type>", "Endpoint type")
  .option("--capability <spec...>", "Replace capabilities")
  .option("--alias <alias...>", "Set aliases")
  .option("--free", "Set free=true")
  .option("--not-free", "Set free=false")
  .option("--enabled", "Set enabled=true")
  .option("--disabled", "Set enabled=false")
  .option("--no-rebuild", "Skip automatic pool rebuild")
  .action(async (providerId, modelRef, options) => {
    await ensureStorageDir(paths);
    const patch: Partial<ProviderModelRecord> = {};
    if (typeof options.upstream === "string") {
      patch.upstreamModel = options.upstream.trim();
    }
    if (typeof options.baseUrl === "string") {
      patch.baseUrl = options.baseUrl.trim();
    }
    if (options.clearBaseUrl) {
      patch.baseUrl = undefined;
    }
    if (typeof options.apiKey === "string") {
      patch.apiKey = options.apiKey;
    }
    if (options.clearApiKey) {
      patch.apiKey = undefined;
    }
    if (options.insecureTls) {
      patch.insecureTls = true;
    }
    if (options.clearInsecureTls) {
      patch.insecureTls = undefined;
    }
    if (typeof options.endpointType === "string") {
      patch.endpointType = normalizeType(options.endpointType);
    }
    if (options.capability) {
      const capabilities = parseCapabilitySpecs(options.capability);
      patch.capabilities = capabilities;
      patch.modalities = capabilitiesToModalities(capabilities);
    }
    if (options.alias) {
      patch.aliases = normalizeAliasList(options.alias);
    }
    if (options.free) {
      patch.free = true;
    }
    if (options.notFree) {
      patch.free = false;
    }
    if (options.enabled) {
      patch.enabled = true;
    }
    if (options.disabled) {
      patch.enabled = false;
    }
    if (Object.keys(patch).length === 0) {
      console.error("No changes requested.");
      process.exitCode = 1;
      return;
    }

    const updated = await updateProviderModel(paths, providerId, modelRef, patch);
    if (!updated) {
      console.error("Model not found");
      process.exitCode = 1;
      return;
    }
    if (options.rebuild !== false) {
      await rebuildDefaultPools(paths);
    }
    console.log(`Updated model: ${updated.providerModelId}`);
  });

providerModel
  .command("rm")
  .description("Remove a provider model")
  .argument("<providerId>")
  .argument("<modelRef>")
  .option("--no-rebuild", "Skip automatic pool rebuild")
  .action(async (providerId, modelRef, options) => {
    await ensureStorageDir(paths);
    const removed = await deleteProviderModel(paths, providerId, modelRef);
    if (!removed) {
      console.error("Model not found");
      process.exitCode = 1;
      return;
    }
    if (options.rebuild !== false) {
      await rebuildDefaultPools(paths);
    }
    console.log(`Removed model: ${removed.providerModelId}`);
  });

providerModel
  .command("enable")
  .description("Enable a provider model")
  .argument("<providerId>")
  .argument("<modelRef>")
  .option("--no-rebuild", "Skip automatic pool rebuild")
  .action(async (providerId, modelRef, options) => {
    await ensureStorageDir(paths);
    const model = await setProviderModelEnabled(paths, providerId, modelRef, true);
    if (!model) {
      console.error("Model not found");
      process.exitCode = 1;
      return;
    }
    if (options.rebuild !== false) {
      await rebuildDefaultPools(paths);
    }
    console.log(`Enabled model: ${model.providerModelId}`);
  });

providerModel
  .command("disable")
  .description("Disable a provider model")
  .argument("<providerId>")
  .argument("<modelRef>")
  .option("--no-rebuild", "Skip automatic pool rebuild")
  .action(async (providerId, modelRef, options) => {
    await ensureStorageDir(paths);
    const model = await setProviderModelEnabled(paths, providerId, modelRef, false);
    if (!model) {
      console.error("Model not found");
      process.exitCode = 1;
      return;
    }
    if (options.rebuild !== false) {
      await rebuildDefaultPools(paths);
    }
    console.log(`Disabled model: ${model.providerModelId}`);
  });

providerModel
  .command("set-key")
  .description("Set plaintext API key for a provider model")
  .argument("<providerId>")
  .argument("<modelRef>")
  .option("--api-key <key>", "API key value")
  .option("--env-var <name>", "Read API key from environment variable")
  .option("--no-rebuild", "Skip automatic pool rebuild")
  .action(async (providerId, modelRef, options) => {
    await ensureStorageDir(paths);
    let apiKey: string | undefined = options.apiKey;
    if (!apiKey && options.envVar) {
      apiKey = process.env[String(options.envVar)] ?? undefined;
      if (!apiKey) {
        console.error(`Environment variable '${options.envVar}' is not set.`);
        process.exitCode = 1;
        return;
      }
    }
    if (!apiKey) {
      console.error("Provide --api-key or --env-var.");
      process.exitCode = 1;
      return;
    }
    const model = await setProviderModelApiKey(paths, providerId, modelRef, apiKey);
    if (!model) {
      console.error("Model not found");
      process.exitCode = 1;
      return;
    }
    if (options.rebuild !== false) {
      await rebuildDefaultPools(paths);
    }
    console.log(`Updated key for model: ${model.providerModelId}`);
  });

provider
  .command("enable")
  .description("Enable a provider")
  .argument("<providerId>")
  .action(async (providerId) => {
    await ensureStorageDir(paths);
    const updated = await setProviderEnabled(paths, providerId, true);
    if (!updated) {
      console.error("Provider not found");
      process.exitCode = 1;
      return;
    }
    await rebuildDefaultPools(paths);
    console.log(`Enabled provider: ${updated.id}`);
  });

provider
  .command("disable")
  .description("Disable a provider")
  .argument("<providerId>")
  .action(async (providerId) => {
    await ensureStorageDir(paths);
    const updated = await setProviderEnabled(paths, providerId, false);
    if (!updated) {
      console.error("Provider not found");
      process.exitCode = 1;
      return;
    }
    await rebuildDefaultPools(paths);
    console.log(`Disabled provider: ${updated.id}`);
  });

provider
  .command("migrate-endpoints")
  .description("Copy matching endpoints into a provider and disable source endpoints")
  .requiredOption("--provider <id>", "Destination provider ID (e.g. pcai)")
  .option("--match-domain <domain>", "Hostname suffix to migrate (e.g. ai-application.stjude.org)")
  .option("--all", "Migrate all endpoints (ignore domain filter)")
  .option("--protocol <protocol>", "Protocol for destination provider", "openai")
  .action(async (options) => {
    await ensureStorageDir(paths);

    const providerId = String(options.provider).trim();
    const domain = typeof options.matchDomain === "string" ? options.matchDomain.trim().toLowerCase() : "";
    const includeAll = options.all === true;
    const protocol = normalizeProviderProtocol(String(options.protocol));
    const now = new Date().toISOString();
    const warnings: string[] = [];
    let skippedEndpoints = 0;
    let migratedModels = 0;
    let createdModels = 0;
    let updatedModels = 0;
    let disabledEndpoints = 0;
    const endpointIdsToDisable = new Set<string>();

    if (!providerId) {
      console.error("--provider is required");
      process.exitCode = 1;
      return;
    }
    if (!includeAll && !domain) {
      console.error("Provide --match-domain <domain> or use --all.");
      process.exitCode = 1;
      return;
    }

    const allEndpoints = await listEndpoints(paths);
    const matchedEndpoints = allEndpoints.filter((endpoint) => {
      if (includeAll) {
        return true;
      }
      try {
        const host = new URL(endpoint.baseUrl).hostname.toLowerCase();
        return hostMatchesDomain(host, domain);
      } catch (error) {
        warnings.push(`Skipped endpoint '${endpoint.name}': invalid baseUrl (${(error as Error).message})`);
        skippedEndpoints += 1;
        return false;
      }
    });

    if (matchedEndpoints.length === 0) {
      console.log(
        includeAll
          ? "No endpoints found to migrate."
          : `No endpoints matched domain suffix '${domain}'.`
      );
      return;
    }

    const existingProvider = await getProviderById(paths, providerId);
    const providerSeed: ProviderRecord = {
      id: providerId,
      name: existingProvider?.name ?? providerId.toUpperCase(),
      description: existingProvider?.description ?? `Migrated endpoints for ${includeAll ? "all legacy endpoints" : domain}`,
      docs: existingProvider?.docs,
      protocol,
      protocolRaw: options.protocol,
      protocolConfig: existingProvider?.protocolConfig,
      baseUrl: existingProvider?.baseUrl ?? matchedEndpoints[0].baseUrl,
      enabled: existingProvider?.enabled ?? true,
      supportsRouting: hasProtocolAdapter(protocol),
      auth: existingProvider?.auth ?? { type: "bearer" },
      envVar: existingProvider?.envVar,
      apiKey: existingProvider?.apiKey,
      limits: existingProvider?.limits,
      models: existingProvider?.models ?? [],
      warnings: existingProvider?.warnings,
      importedAt: existingProvider?.importedAt ?? now,
    };

    await upsertProvider(paths, providerSeed);

    for (const endpoint of matchedEndpoints) {
      if (endpoint.models.length === 0) {
        warnings.push(`Endpoint '${endpoint.name}' has no models; skipped.`);
        skippedEndpoints += 1;
        continue;
      }

      let migratedFromEndpoint = 0;
      for (const mapping of endpoint.models) {
        const capabilities = getModelCapabilitiesForEndpoint(endpoint.type, mapping);
        const canonicalId = canonicalProviderModelId(providerId, mapping.publicName);
        const aliases = normalizeAliasList([mapping.publicName, ...(existingProvider?.models ?? [])
          .filter((m) => m.modelId === mapping.publicName)
          .flatMap((m) => m.aliases ?? [])]);
        const modelRecord: ProviderModelRecord = {
          providerModelId: canonicalId,
          providerId,
          modelId: mapping.publicName,
          upstreamModel: mapping.upstreamModel,
          baseUrl: endpoint.baseUrl,
          apiKey: endpoint.apiKey,
          insecureTls: endpoint.insecureTls,
          enabled: true,
          aliases,
          free: true,
          modalities: capabilitiesToModalities(capabilities),
          capabilities,
          endpointType: endpoint.type,
        };
        const result = await upsertProviderModel(paths, providerId, modelRecord);
        if (!result) {
          warnings.push(`Failed to write model '${mapping.publicName}' into provider '${providerId}'.`);
          continue;
        }
        migratedModels += 1;
        migratedFromEndpoint += 1;
        if (result.created) {
          createdModels += 1;
        } else {
          updatedModels += 1;
        }
      }
      if (migratedFromEndpoint > 0) {
        endpointIdsToDisable.add(endpoint.id);
      } else {
        warnings.push(`Endpoint '${endpoint.name}' had no models migrated; left enabled.`);
      }
    }

    for (const endpoint of matchedEndpoints) {
      if (!endpointIdsToDisable.has(endpoint.id)) {
        continue;
      }
      if (endpoint.disabled) {
        continue;
      }
      const updatedEndpoint = await setEndpointDisabled(paths, endpoint.id, true);
      if (updatedEndpoint) {
        disabledEndpoints += 1;
      }
    }

    const pools = await rebuildDefaultPools(paths);
    const reportPath = writeMigrationReport(paths.baseDir, {
      timestamp: now,
      providerId,
      includeAll,
      domain: domain || undefined,
      matchedEndpoints: matchedEndpoints.length,
      migratedModels,
      createdModels,
      updatedModels,
      disabledEndpoints,
      skippedEndpoints,
      warnings,
    });

    console.log(`Migrated provider: ${providerId}`);
    console.log(`Matched endpoints: ${matchedEndpoints.length}`);
    console.log(`Migrated models: ${migratedModels} (created ${createdModels}, updated ${updatedModels})`);
    console.log(`Disabled source endpoints: ${disabledEndpoints}`);
    console.log(`Rebuilt pools: ${pools.length}`);
    console.log(`Migration report: ${reportPath}`);

    if (warnings.length > 0) {
      console.log("Warnings:");
      for (const warning of warnings) {
        console.log(`  - ${warning}`);
      }
    }
    if (skippedEndpoints > 0) {
      console.log(`Skipped endpoints: ${skippedEndpoints}`);
    }
  });

provider
  .command("pools")
  .description("List smart pools")
  .option("--json", "Output as JSON")
  .action(async (options) => {
    await ensureStorageDir(paths);
    const pools = await listPools(paths);
    if (options.json) {
      console.log(JSON.stringify(pools, null, 2));
      return;
    }
    if (pools.length === 0) {
      console.log("No pools found.");
      return;
    }
    console.table(
      pools.map((pool) => ({
        id: pool.id,
        aliases: pool.aliases.join(","),
        candidates: pool.candidates.length,
        strategy: pool.strategy,
      }))
    );
  });

type ResolvedModelTarget = {
  providerId: string;
  modelId: string;
  model: ProviderModelRecord;
};

async function resolveModelTarget(modelRef: string): Promise<ResolvedModelTarget | null> {
  const parsed = parseModelRef(modelRef);
  if (parsed.providerId) {
    const model = await getProviderModel(paths, parsed.providerId, parsed.modelId);
    if (!model) {
      printErrorWithSuggestion(
        `Model not found: ${parsed.providerId}/${parsed.modelId}`,
        [
          `Try: waypoint models ${parsed.providerId}`,
          "List providers: waypoint providers",
        ]
      );
      process.exitCode = 1;
      return null;
    }
    return {
      providerId: parsed.providerId,
      modelId: parsed.modelId,
      model,
    };
  }

  const providers = await listProviders(paths);
  const matches: ResolvedModelTarget[] = [];
  for (const providerEntry of providers) {
    for (const model of providerEntry.models) {
      if (
        model.modelId === parsed.modelId ||
        model.providerModelId === parsed.modelId ||
        (model.aliases ?? []).includes(parsed.modelId)
      ) {
        matches.push({
          providerId: providerEntry.id,
          modelId: model.modelId,
          model,
        });
      }
    }
  }

  if (matches.length === 0) {
    printErrorWithSuggestion(
      `Unknown model '${parsed.modelId}'`,
      [
        "Try: waypoint models",
        "List providers: waypoint providers",
      ]
    );
    process.exitCode = 1;
    return null;
  }

  if (matches.length > 1) {
    const candidates = matches
      .map((entry) => `  - waypoint models show ${entry.providerId}/${entry.modelId}`)
      .slice(0, 10);
    printErrorWithSuggestion(
      `Model '${parsed.modelId}' is ambiguous across providers.`,
      [
        "Use a provider-qualified model reference:",
        ...candidates,
      ]
    );
    process.exitCode = 1;
    return null;
  }

  return matches[0];
}

async function listModelsAction(
  providerId: string | undefined,
  options: {
    json?: boolean;
    enabled?: boolean;
    modality?: string;
    verbose?: boolean;
    check?: boolean;
  }
): Promise<void> {
  await ensureStorageDir(paths);
  if (options.check !== false) {
    await probeProviderModels(paths);
  }
  const healthMap = await getProviderModelHealthMap(paths);
  const modality = typeof options.modality === "string" ? options.modality.trim() : undefined;

  if (providerId) {
    const models = await listProviderModels(paths, providerId);
    if (!models) {
      printErrorWithSuggestion(
        `Provider not found: ${providerId}`,
        ["List providers: waypoint providers"]
      );
      process.exitCode = 1;
      return;
    }
    const filtered = models.filter((model) => {
      if (options.enabled && model.enabled === false) {
        return false;
      }
      if (modality && !model.modalities.includes(modality)) {
        return false;
      }
      return true;
    });
    if (options.json) {
      printJson(filtered);
      return;
    }
    const rows = options.verbose
      ? filtered.map((model) => ({
          provider: providerId,
          providerModelId: model.providerModelId,
          modelId: model.modelId,
          upstreamModel: model.upstreamModel,
          enabled: model.enabled === false ? "no" : "yes",
          tls: model.insecureTls === undefined ? "inherit" : model.insecureTls ? "insecure" : "strict",
          endpointType: model.endpointType,
          baseUrl: model.baseUrl ?? "-",
          aliases: (model.aliases ?? []).join(","),
          free: model.free ? "yes" : "no",
          livebench: model.benchmark?.livebench ?? "-",
          status: healthMap[model.providerModelId]?.status ?? "-",
          latency: formatLatency(healthMap[model.providerModelId]?.latencyMsEwma),
          lastStatus: healthMap[model.providerModelId]?.lastStatusCode ?? "-",
          lastError: healthMap[model.providerModelId]?.lastError ?? "-",
        }))
      : filtered.map((model) => ({
          provider: providerId,
          id: model.modelId,
          enabled: model.enabled === false ? "no" : "yes",
          tls: model.insecureTls === undefined ? "inherit" : model.insecureTls ? "insecure" : "strict",
          type: model.endpointType,
          aliases: (model.aliases ?? []).length,
          livebench: model.benchmark?.livebench ?? "-",
          status: healthMap[model.providerModelId]?.status ?? "-",
          latency: formatLatency(healthMap[model.providerModelId]?.latencyMsEwma),
        }));
    console.table(rows);
    return;
  }

  const providers = await listProviders(paths);
  const flattened = providers.flatMap((providerEntry) =>
    providerEntry.models.map((model) => ({ providerId: providerEntry.id, model }))
  );
  const filtered = flattened.filter(({ model }) => {
    if (options.enabled && model.enabled === false) {
      return false;
    }
    if (modality && !model.modalities.includes(modality)) {
      return false;
    }
    return true;
  });
  if (options.json) {
    printJson(
      filtered.map(({ providerId, model }) => ({
        ...model,
        providerId,
      }))
    );
    return;
  }
  const rows = filtered.map(({ providerId, model }) => ({
    provider: providerId,
    model: model.modelId,
    enabled: model.enabled === false ? "no" : "yes",
    type: model.endpointType,
    aliases: (model.aliases ?? []).length,
    livebench: model.benchmark?.livebench ?? "-",
    status: healthMap[model.providerModelId]?.status ?? "-",
    latency: formatLatency(healthMap[model.providerModelId]?.latencyMsEwma),
  }));
  console.table(rows);
}

const models = program
  .command("models")
  .alias("model")
  .description("List and manage provider-owned models")
  .argument("[providerId]")
  .option("--json", "Output as JSON")
  .option("--enabled", "Only show enabled models")
  .option("--modality <modality>", "Filter by modality (e.g. text-to-text,image-to-text)")
  .option("--verbose", "Show full model metadata")
  .option("--no-check", "Skip health check for faster listing")
  .action(async (providerId, options) => {
    await listModelsAction(providerId, options);
  });

models.addHelpText(
  "after",
  `
Default: \`waypoint models [providerId]\` runs \`models list [providerId]\`.
Examples:
  waypoint models
  waypoint models provider-id
  waypoint models show provider-id/model-id
`
);

models
  .command("list")
  .alias("ls")
  .description("List models, optionally filtered by provider")
  .argument("[providerId]")
  .option("--json", "Output as JSON")
  .option("--enabled", "Only show enabled models")
  .option("--modality <modality>", "Filter by modality (e.g. text-to-text,image-to-text)")
  .option("--verbose", "Show full model metadata")
  .option("--no-check", "Skip health check for faster listing")
  .action(async (providerId, options) => {
    await listModelsAction(providerId, options);
  });

models
  .command("show")
  .description("Show one model (provider/model preferred)")
  .argument("<modelRef>")
  .action(async (modelRef) => {
    await ensureStorageDir(paths);
    const resolved = await resolveModelTarget(modelRef);
    if (!resolved) {
      return;
    }
    printJson({
      ...resolved.model,
      providerId: resolved.providerId,
      modelId: resolved.modelId,
    });
  });

models
  .command("enable")
  .description("Enable a provider model")
  .argument("<modelRef>")
  .option("--no-rebuild", "Skip automatic pool rebuild")
  .action(async (modelRef, options) => {
    await ensureStorageDir(paths);
    const resolved = await resolveModelTarget(modelRef);
    if (!resolved) {
      return;
    }
    const model = await setProviderModelEnabled(paths, resolved.providerId, resolved.modelId, true);
    if (!model) {
      printErrorWithSuggestion(`Model not found: ${modelRef}`, ["Try: waypoint models"]);
      process.exitCode = 1;
      return;
    }
    if (options.rebuild !== false) {
      await rebuildDefaultPools(paths);
    }
    console.log(`Enabled model: ${model.providerModelId}`);
  });

models
  .command("disable")
  .description("Disable a provider model")
  .argument("<modelRef>")
  .option("--no-rebuild", "Skip automatic pool rebuild")
  .action(async (modelRef, options) => {
    await ensureStorageDir(paths);
    const resolved = await resolveModelTarget(modelRef);
    if (!resolved) {
      return;
    }
    const model = await setProviderModelEnabled(paths, resolved.providerId, resolved.modelId, false);
    if (!model) {
      printErrorWithSuggestion(`Model not found: ${modelRef}`, ["Try: waypoint models"]);
      process.exitCode = 1;
      return;
    }
    if (options.rebuild !== false) {
      await rebuildDefaultPools(paths);
    }
    console.log(`Disabled model: ${model.providerModelId}`);
  });

models
  .command("set-key")
  .description("Set plaintext API key for a provider model")
  .argument("<modelRef>")
  .option("--api-key <key>", "API key value")
  .option("--env-var <name>", "Read API key from environment variable")
  .option("--no-rebuild", "Skip automatic pool rebuild")
  .action(async (modelRef, options) => {
    await ensureStorageDir(paths);
    const resolved = await resolveModelTarget(modelRef);
    if (!resolved) {
      return;
    }
    let apiKey: string | undefined = options.apiKey;
    if (!apiKey && options.envVar) {
      apiKey = process.env[String(options.envVar)] ?? undefined;
      if (!apiKey) {
        printErrorWithSuggestion(`Environment variable '${options.envVar}' is not set.`, [
          "Provide --api-key <key> or set the environment variable.",
        ]);
        process.exitCode = 1;
        return;
      }
    }
    if (!apiKey) {
      printErrorWithSuggestion("Provide --api-key or --env-var.", [
        "Try: waypoint models set-key provider/model --env-var API_KEY",
      ]);
      process.exitCode = 1;
      return;
    }
    const model = await setProviderModelApiKey(paths, resolved.providerId, resolved.modelId, apiKey);
    if (!model) {
      printErrorWithSuggestion(`Model not found: ${modelRef}`, ["Try: waypoint models"]);
      process.exitCode = 1;
      return;
    }
    if (options.rebuild !== false) {
      await rebuildDefaultPools(paths);
    }
    console.log(`Updated key for model: ${model.providerModelId}`);
  });

models
  .command("add")
  .description("Add a model under a provider")
  .argument("<providerId>")
  .requiredOption("--model-id <id>", "Provider model ID suffix")
  .requiredOption("--upstream <name>", "Upstream model name")
  .requiredOption("--base-url <url>", "Base URL for this model")
  .option("--api-key <key>", "API key for this model")
  .option("--insecure-tls", "Allow self-signed TLS certificates for this model")
  .option("--endpoint-type <type>", "Endpoint type (llm|diffusion|audio|embedding)", "llm")
  .option("--capability <spec...>", "Capability spec, e.g. text->text or text+image->text")
  .option("--alias <alias...>", "Legacy/public aliases")
  .option("--free", "Mark model as free")
  .option("--no-free", "Mark model as not free")
  .option("--disabled", "Add model in disabled state")
  .option("--no-rebuild", "Skip automatic pool rebuild")
  .action(async (providerId, options) => {
    await ensureStorageDir(paths);
    const providerRecord = await getProviderById(paths, providerId);
    if (!providerRecord) {
      printErrorWithSuggestion(`Provider not found: ${providerId}`, ["List providers: waypoint providers"]);
      process.exitCode = 1;
      return;
    }
    const endpointType = normalizeType(options.endpointType);
    const capabilities = options.capability
      ? parseCapabilitySpecs(options.capability)
      : defaultCapabilitiesForEndpointType(endpointType);
    const modelId = String(options.modelId).trim();
    const providerModelId = canonicalProviderModelId(providerId, modelId);
    const modelRecord: ProviderModelRecord = {
      providerModelId,
      providerId,
      modelId,
      upstreamModel: String(options.upstream).trim(),
      baseUrl: String(options.baseUrl).trim(),
      apiKey: options.apiKey,
      insecureTls: options.insecureTls ? true : undefined,
      enabled: options.disabled ? false : true,
      aliases: normalizeAliasList(options.alias ?? []),
      free: options.free !== false,
      modalities: capabilitiesToModalities(capabilities),
      capabilities,
      endpointType,
    };
    const result = await upsertProviderModel(paths, providerId, modelRecord);
    if (!result) {
      console.error("Failed to add model");
      process.exitCode = 1;
      return;
    }
    if (options.rebuild !== false) {
      await rebuildDefaultPools(paths);
    }
    console.log(`Model ${result.created ? "added" : "updated"}: ${providerModelId}`);
  });

models
  .command("update")
  .description("Update a provider model")
  .argument("<providerId>")
  .argument("<modelRef>")
  .option("--upstream <name>", "Set upstream model")
  .option("--base-url <url>", "Set base URL")
  .option("--clear-base-url", "Clear model-specific base URL override")
  .option("--api-key <key>", "Set API key")
  .option("--clear-api-key", "Clear model-specific API key")
  .option("--insecure-tls", "Enable insecure TLS for this model")
  .option("--clear-insecure-tls", "Clear model TLS override and inherit provider setting")
  .option("--endpoint-type <type>", "Endpoint type")
  .option("--capability <spec...>", "Replace capabilities")
  .option("--alias <alias...>", "Set aliases")
  .option("--free", "Set free=true")
  .option("--not-free", "Set free=false")
  .option("--enabled", "Set enabled=true")
  .option("--disabled", "Set enabled=false")
  .option("--no-rebuild", "Skip automatic pool rebuild")
  .action(async (providerId, modelRef, options) => {
    await ensureStorageDir(paths);
    const patch: Partial<ProviderModelRecord> = {};
    if (typeof options.upstream === "string") {
      patch.upstreamModel = options.upstream.trim();
    }
    if (typeof options.baseUrl === "string") {
      patch.baseUrl = options.baseUrl.trim();
    }
    if (options.clearBaseUrl) {
      patch.baseUrl = undefined;
    }
    if (typeof options.apiKey === "string") {
      patch.apiKey = options.apiKey;
    }
    if (options.clearApiKey) {
      patch.apiKey = undefined;
    }
    if (options.insecureTls) {
      patch.insecureTls = true;
    }
    if (options.clearInsecureTls) {
      patch.insecureTls = undefined;
    }
    if (typeof options.endpointType === "string") {
      patch.endpointType = normalizeType(options.endpointType);
    }
    if (options.capability) {
      const capabilities = parseCapabilitySpecs(options.capability);
      patch.capabilities = capabilities;
      patch.modalities = capabilitiesToModalities(capabilities);
    }
    if (options.alias) {
      patch.aliases = normalizeAliasList(options.alias);
    }
    if (options.free) {
      patch.free = true;
    }
    if (options.notFree) {
      patch.free = false;
    }
    if (options.enabled) {
      patch.enabled = true;
    }
    if (options.disabled) {
      patch.enabled = false;
    }
    if (Object.keys(patch).length === 0) {
      printErrorWithSuggestion("No changes requested.", [
        "Try: waypoint models update <providerId> <modelRef> --upstream <name>",
      ]);
      process.exitCode = 1;
      return;
    }
    const updated = await updateProviderModel(paths, providerId, modelRef, patch);
    if (!updated) {
      printErrorWithSuggestion(`Model not found: ${providerId}/${modelRef}`, [
        `Try: waypoint models ${providerId}`,
      ]);
      process.exitCode = 1;
      return;
    }
    if (options.rebuild !== false) {
      await rebuildDefaultPools(paths);
    }
    console.log(`Updated model: ${updated.providerModelId}`);
  });

models
  .command("rm")
  .description("Remove a provider model")
  .argument("<providerId>")
  .argument("<modelRef>")
  .option("--no-rebuild", "Skip automatic pool rebuild")
  .action(async (providerId, modelRef, options) => {
    await ensureStorageDir(paths);
    const removed = await deleteProviderModel(paths, providerId, modelRef);
    if (!removed) {
      printErrorWithSuggestion(`Model not found: ${providerId}/${modelRef}`, [
        `Try: waypoint models ${providerId}`,
      ]);
      process.exitCode = 1;
      return;
    }
    if (options.rebuild !== false) {
      await rebuildDefaultPools(paths);
    }
    console.log(`Removed model: ${removed.providerModelId}`);
  });

// ─────────────────────────────────────────────────────────────────────────────
// Benchmark Command
// ─────────────────────────────────────────────────────────────────────────────

program
  .command("bench")
  .alias("benchmark")
  .description("Run lightweight benchmarks (chat/agent/embeddings/images/audio)")
  .option("--suite <name>", "Built-in suite to run")
  .option("--scenario <path>", "Scenario file (.json, .jsonl, .yaml)")
  .option("--model <name>", "Override model for all scenarios")
  .option("--out <path>", "Output file path or directory for benchmark artifact")
  .option("--config <path>", "Benchmark config file (YAML or JSON)")
  .option("--profile <name>", "Benchmark profile (local|ci)")
  .option("--baseline <path>", "Baseline benchmark JSON for regression comparison")
  .option("--update-cap-cache", "Persist capability findings to capability cache")
  .option("--cap-ttl-days <n>", "Capability cache TTL days for freshness/output", parseInt)
  .action(async (options) => {
    await ensureStorageDir(paths);
    try {
      const { report, artifactPath, textArtifactPath } = await runBenchmark(paths, {
        suite: options.suite,
        scenarioPath: options.scenario,
        modelOverride: options.model,
        outPath: options.out,
        configPath: options.config,
        profile: options.profile,
        baselinePath: options.baseline,
        updateCapCache: options.updateCapCache,
        capTtlDays: options.capTtlDays,
      });

      console.log("\n🏁 Benchmark complete");
      console.log(`   Profile:     ${report.profile}`);
      if (report.suite) {
      console.log(`   Suite:       ${report.suite}`);
      }
      if (report.capabilityMatrix) {
        console.log(`   Cap TTL:     ${report.capabilityMatrix.ttlDays}d`);
      }
      console.log(`   Scenarios:   ${report.total}`);
      console.log(`   Executed:    ${report.executed}`);
      console.log(`   Skipped:     ${report.skipped}`);
      console.log(`   Success:     ${report.succeeded}`);
      console.log(`   Failed:      ${report.failed}`);
      console.log(`   SuccessRate: ${(report.successRate * 100).toFixed(1)}%`);
      console.log(`   AvgLatency:  ${report.avgLatencyMs}ms`);
      console.log(`   P95Latency:  ${report.p95LatencyMs}ms`);
      console.log(`   Tokens:      ${report.totalTokens}`);
      console.log(`   ToolCalls:   ${report.totalToolCalls}`);
      console.log(`   Throughput:  ${report.avgThroughputTokensPerSec.toFixed(2)} t/s`);
      console.log(`   Artifact:    ${artifactPath}\n`);
      console.log(`   Summary:     ${textArtifactPath}\n`);

      if (report.warnings.length > 0) {
        console.log("Warnings:");
        for (const warning of report.warnings) {
          console.log(`  - ${warning}`);
        }
        console.log();
      }

      const skipped = report.results.filter((item) => item.status === "skipped");
      if (skipped.length > 0) {
        console.log("Skipped scenarios:");
        console.table(
          skipped.map((item) => ({
            id: item.id,
            mode: item.mode,
            reason: item.skippedReason ?? "no compatible model",
          }))
        );
      }

      if (report.gateResults.soft.messages.length > 0) {
        console.log("Soft gate warnings:");
        for (const warning of report.gateResults.soft.messages) {
          console.log(`  - ${warning}`);
        }
        console.log();
      }

      if (!report.gateResults.hard.passed) {
        console.log("Hard gate failures:");
        for (const failure of report.gateResults.hard.messages) {
          console.log(`  - ${failure}`);
        }
        console.log();

        const failed = report.results.filter((item) => !item.success);
        if (failed.length > 0) {
          console.log("Failed scenarios:");
          console.table(
            failed.map((item) => ({
              id: item.id,
              mode: item.mode,
              model: item.model,
              passRate: `${(item.passRate * 100).toFixed(1)}%`,
              error: item.errorReasons[0] ?? "failed",
            }))
          );
        }

        process.exitCode = 1;
      } else {
        const failed = report.results.filter((item) => !item.success);
        if (failed.length > 0) {
          console.log("Scenarios below pass-rate threshold:");
          console.table(
            failed.map((item) => ({
              id: item.id,
              mode: item.mode,
              model: item.model,
              passRate: `${(item.passRate * 100).toFixed(1)}%`,
              error: item.errorReasons[0] ?? "failed",
            }))
          );
        }
      }

      if (report.gateResults.soft.messages.length > 0 && report.gateResults.hard.passed) {
        console.log("Benchmark finished with soft warnings (exit code 0).");
      }

      if (report.capabilityMatrix && report.capabilityMatrix.models.length > 0) {
        console.log("\nCapability Matrix:");
        const rows = report.capabilityMatrix.models.map((model) => ({
          model: model.model,
          freshness: model.freshness,
          verified: model.lastVerifiedAt,
          chat: model.findings.chat_basic.status,
          tools: model.findings.chat_tool_calls.status,
          embed: model.findings.embeddings.status,
          image: model.findings.images_generation.status,
          audioIn: model.findings.audio_transcription.status,
          audioOut: model.findings.audio_speech.status,
        }));
        console.table(rows);
      }
    } catch (error) {
      console.error(`Benchmark failed: ${(error as Error).message}`);
      process.exitCode = 1;
    }
  });

const rawArgv = process.argv.slice(2);
const rewriteResult = rewriteLegacyArgv(rawArgv);
warnLegacyRewrite(rewriteResult);

program.parseAsync(["node", "waypoint", ...rewriteResult.argv]).catch((error) => {
  console.error(error);
  process.exit(1);
});

function compactEndpointUrl(value: string, maxLength = 36): string {
  try {
    const parsed = new URL(value);
    return truncateText(`${parsed.protocol}//${parsed.host}`, maxLength);
  } catch {
    return truncateText(value, maxLength);
  }
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  if (maxLength <= 1) {
    return value.slice(0, maxLength);
  }
  return `${value.slice(0, maxLength - 1)}…`;
}

function normalizeProviderProtocol(value: string): ProviderProtocol {
  const normalized = canonicalizeProtocol(value);
  if (normalized === "openai" || normalized === "inference_v2") {
    return normalized;
  }
  return "unknown";
}

function hostMatchesDomain(hostname: string, domain: string): boolean {
  const normalizedHost = hostname.toLowerCase();
  const normalizedDomain = domain.replace(/^\*\./, "").toLowerCase();
  return normalizedHost === normalizedDomain || normalizedHost.endsWith(`.${normalizedDomain}`);
}

function capabilitiesToModalities(capabilities: ModelCapabilities): string[] {
  const modalities = new Set<string>();
  const hasTextInput = capabilities.input.includes("text");
  const hasImageInput = capabilities.input.includes("image");
  const hasAudioInput = capabilities.input.includes("audio");
  const hasTextOutput = capabilities.output.includes("text");
  const hasImageOutput = capabilities.output.includes("image");
  const hasAudioOutput = capabilities.output.includes("audio");
  const hasEmbeddingOutput = capabilities.output.includes("embedding");

  if (hasTextInput && hasTextOutput) {
    modalities.add("text-to-text");
  }
  if (hasImageInput && hasTextOutput) {
    modalities.add("image-to-text");
  }
  if (hasTextInput && hasImageOutput) {
    modalities.add("text-to-image");
  }
  if (hasAudioInput && hasTextOutput) {
    modalities.add("audio-to-text");
  }
  if (hasTextInput && hasAudioOutput) {
    modalities.add("text-to-audio");
  }
  if (hasTextInput && hasEmbeddingOutput) {
    modalities.add("text-to-embedding");
  }

  return Array.from(modalities);
}

function defaultCapabilitiesForEndpointType(
  endpointType: "llm" | "diffusion" | "audio" | "embedding"
): ModelCapabilities {
  if (endpointType === "embedding") {
    return { input: ["text"], output: ["embedding"], source: "configured" };
  }
  if (endpointType === "diffusion") {
    return { input: ["text"], output: ["image"], source: "configured" };
  }
  if (endpointType === "audio") {
    return { input: ["audio"], output: ["text"], source: "configured" };
  }
  return {
    input: ["text"],
    output: ["text"],
    supportsTools: true,
    supportsStreaming: true,
    source: "configured",
  };
}

function parseCapabilitySpecs(values: string[]): ModelCapabilities {
  const input = new Set<ModelModality>();
  const output = new Set<ModelModality>();
  for (const value of values) {
    const [inputSpec, outputSpec] = value.split("->").map((part) => part.trim());
    if (!inputSpec || !outputSpec) {
      throw new Error(`Invalid capability spec '${value}'. Use format input->output, e.g. text+image->text`);
    }
    for (const modality of inputSpec.split("+").map((item) => item.trim())) {
      input.add(parseModality(modality));
    }
    for (const modality of outputSpec.split("+").map((item) => item.trim())) {
      output.add(parseModality(modality));
    }
  }
  if (input.size === 0 || output.size === 0) {
    throw new Error("Capability spec must include at least one input and one output modality.");
  }
  return {
    input: Array.from(input),
    output: Array.from(output),
    source: "configured",
  };
}

function parseModality(value: string): ModelModality {
  if (value === "text" || value === "image" || value === "audio" || value === "embedding") {
    return value;
  }
  throw new Error(`Unsupported modality '${value}'. Use one of: text,image,audio,embedding.`);
}

function normalizeAliasList(values: string[]): string[] {
  const seen = new Set<string>();
  for (const value of values) {
    const alias = value.trim();
    if (alias.length > 0) {
      seen.add(alias);
    }
  }
  return Array.from(seen);
}

function writeMigrationReport(baseDir: string, payload: Record<string, unknown>): string {
  const migrationsDir = path.join(baseDir, "migrations");
  fs.mkdirSync(migrationsDir, { recursive: true });
  const filePath = path.join(
    migrationsDir,
    `migrate-${new Date().toISOString().replace(/[:.]/g, "-")}.json`
  );
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), "utf8");
  return filePath;
}

function isImageModel(model: string): boolean {
  const name = model.toLowerCase();
  return name.includes("diffusion") || name.includes("stable") || name.includes("sd") || name.includes("flux");
}

function isAudioModel(model: string): boolean {
  const name = model.toLowerCase();
  return name.includes("whisper") || name.includes("tts") || name.includes("speech");
}

async function resolveModelType(model: string): Promise<"llm" | "diffusion" | "audio" | "embedding"> {
  const providerModels = await listModelsForApi(paths);
  const providerMatch = providerModels.find((entry) => entry.id === model || entry.aliases.includes(model));
  if (providerMatch) {
    return providerMatch.endpoint_type;
  }
  const endpoints = await listEndpoints(paths);
  const match = endpoints.find((endpoint) =>
    endpoint.models.some((entry) => entry.publicName === model)
  );
  if (match) {
    return match.type;
  }
  if (isImageModel(model)) return "diffusion";
  if (isAudioModel(model)) return "audio";
  return "llm";
}

function normalizeType(value: string): "llm" | "diffusion" | "audio" | "embedding" {
  if (value === "diffusion") return "diffusion";
  if (value === "audio") return "audio";
  if (value === "embedding") return "embedding";
  return "llm";
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

function summarizeProviderHealth(
  models: ProviderModelRecord[],
  healthMap: Record<string, { status?: string }>
): string {
  const enabled = models.filter((model) => model.enabled !== false);
  let up = 0;
  let down = 0;
  for (const model of enabled) {
    const health = healthMap[model.providerModelId];
    if (health?.status === "up") {
      up += 1;
    } else if (health?.status === "down") {
      down += 1;
    }
  }
  return `${up}/${down}/${enabled.length}`;
}

function formatLatency(latency?: number): string {
  if (!latency || !Number.isFinite(latency)) {
    return "-";
  }
  return `${Math.round(latency)}ms`;
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
