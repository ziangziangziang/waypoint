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
import os from "os";
import { routeRequest } from "../src/routing/router";
import { resolveModelMappings } from "../src/utils/modelDiscovery";
import { aggregateStats, readStatsForWindow, resolveStatsDir } from "../src/storage/statsRepository";
import { listMcpServers, addMcpServer, removeMcpServer, updateMcpServer } from "../src/mcp/registry";
import { AgentRunner, buildAgentConfig, verifyIsolation } from "../src/agent/index";

const program = new Command();

const paths = resolveStoragePaths();
const pidFile = path.join(paths.baseDir, "waypoint.pid");

/**
 * Perform an on-demand health check for all endpoints.
 * Updates health.json with fresh status before returning.
 */
async function refreshHealthStatus(): Promise<void> {
  const endpoints = await listEndpoints(paths);
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

program
  .name("waypoint")
  .description("Waypoint admin CLI")
  .version("0.1.0");

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
  .option("--no-check", "Skip health check for faster listing")
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
    console.table(results);
  });

// Alias: waypoint status -> waypoint stat
program
  .command("status")
  .description("Alias for 'stat' - Run a health check against each endpoint")
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

const mcp = program
  .command("mcp")
  .description("Manage MCP servers for agentic workflows");

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
    await ensureStorageDir(paths);
    try {
      const servers = await listMcpServers(paths);
      
      if (servers.length === 0) {
        console.log("No MCP servers configured.");
        return;
      }
      
      if (options.json) {
        console.log(JSON.stringify(servers, null, 2));
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
// Agent Commands
// ─────────────────────────────────────────────────────────────────────────────

program
  .command("agent")
  .description("Start the interactive agent CLI (like running 'codex')")
  .option("-m, --model <model>", "Model to use for the agent")
  .option("-d, --cwd <directory>", "Working directory for the agent")
  .action(async (options) => {
    const runner = new AgentRunner({
      defaultModel: options.model,
      workingDirectory: options.cwd || process.cwd(),
    });

    try {
      const result = await runner.runInteractive({
        model: options.model,
        cwd: options.cwd,
        onStdout: (data) => process.stdout.write(data),
        onStderr: (data) => process.stderr.write(data),
      });
      
      process.exitCode = result.exitCode;
    } catch (error) {
      console.error(`Agent error: ${(error as Error).message}`);
      process.exitCode = 1;
    }
  });

program
  .command("run")
  .description("Run the agent with a prompt")
  .argument("<prompt...>", "The prompt to send to the agent")
  .option("-m, --model <model>", "Model to use for the agent")
  .option("--auto", "Auto-approve all actions (never ask)")
  .option("--untrusted", "Only auto-approve safe read commands (most restrictive)")
  .option("--no-network", "Disable network access in sandbox")
  .option("-d, --cwd <directory>", "Working directory for the agent")
  .action(async (promptParts, options) => {
    const prompt = promptParts.join(" ");
    
    // Determine approval policy (Codex values: untrusted, on-failure, on-request, never)
    let approvalPolicy: "untrusted" | "on-failure" | "on-request" | "never" = "on-request";
    if (options.auto) {
      approvalPolicy = "never";
    } else if (options.untrusted) {
      approvalPolicy = "untrusted";
    }
    
    const runner = new AgentRunner({
      defaultModel: options.model,
      workingDirectory: options.cwd || process.cwd(),
      networkAccess: options.network !== false,
      approvalPolicy,
    });

    try {
      const result = await runner.run({
        prompt,
        onStdout: (data) => process.stdout.write(data),
        onStderr: (data) => process.stderr.write(data),
      });
      
      process.exitCode = result.exitCode;
    } catch (error) {
      console.error(`Agent error: ${(error as Error).message}`);
      process.exitCode = 1;
    }
  });

program
  .command("doctor")
  .description("Verify Waypoint agent configuration and isolation")
  .action(async () => {
    console.log("\n🔍 Waypoint Doctor\n");
    console.log("── Environment ──");
    
    const config = buildAgentConfig();
    
    // Show resolved paths
    console.log(`   CODEX_HOME:        ${config.codexHome}`);
    console.log(`   WAYPOINT_BASE_URL: ${config.baseUrl}`);
    console.log(`   WAYPOINT_API_KEY:  ${config.apiKey ? "****" + config.apiKey.slice(-4) : "(none)"}`);
    console.log(`   Working Dir:       ${config.workingDirectory}`);
    console.log(`   Network Access:    ${config.networkAccess ? "enabled" : "disabled"}`);
    console.log(`   Approval Policy:   ${config.approvalPolicy}\n`);
    
    // Verify isolation
    console.log("── Isolation Check ──");
    const isolation = verifyIsolation(config);
    
    if (isolation.valid) {
      console.log("   ✓ Isolation invariants OK");
      console.log(`   ✓ Data path: ${config.codexHome}`);
      console.log(`   ✓ API endpoint: ${config.baseUrl}`);
    } else {
      console.log("   ✗ Isolation check FAILED:");
      for (const error of isolation.errors) {
        console.log(`     - ${error}`);
      }
      process.exitCode = 1;
      return;
    }
    
    // Check directories exist
    console.log("\n── Directory Status ──");
    const dirs = [
      config.codexHome,
      path.join(config.codexHome, "sessions"),
      path.join(config.codexHome, "log"),
    ];
    
    for (const dir of dirs) {
      const exists = fs.existsSync(dir);
      const status = exists ? "✓" : "○";
      console.log(`   ${status} ${dir}`);
    }
    
    // Check Waypoint service
    console.log("\n── Service Status ──");
    const pid = readPid(pidFile);
    if (pid && isRunning(pidFile)) {
      console.log(`   ✓ Waypoint service running (pid ${pid})`);
      
      // Try to reach the service
      try {
        const response = await request(`${config.baseUrl}/models`, {
          method: "GET",
          headersTimeout: 2000,
          bodyTimeout: 2000,
        });
        response.body.resume();
        if (response.statusCode === 200) {
          console.log(`   ✓ API reachable at ${config.baseUrl}`);
        } else {
          console.log(`   ⚠ API returned status ${response.statusCode}`);
        }
      } catch (error) {
        console.log(`   ✗ Cannot reach API: ${(error as Error).message}`);
      }
    } else {
      console.log("   ○ Waypoint service not running");
      console.log("     Run 'waypoint service start' to start the service");
    }
    
    // Check Codex binary
    console.log("\n── Codex Engine ──");
    const codexDir = path.join(getPackageRoot(), "src", "engine", "codex");
    const codexJsEntry = path.join(codexDir, "codex-cli", "bin", "codex.js");
    const vendorDir = path.join(codexDir, "codex-cli", "vendor");
    const rustRelease = path.join(codexDir, "codex-rs", "target", "release", "waypoint-agent");
    const rustDebug = path.join(codexDir, "codex-rs", "target", "debug", "waypoint-agent");
    
    if (fs.existsSync(codexJsEntry) && fs.existsSync(vendorDir)) {
      console.log("   ✓ JS wrapper with vendor binaries found");
      console.log(`     ${codexJsEntry}`);
    } else if (fs.existsSync(rustRelease)) {
      console.log("   ✓ Rust binary found (release)");
      console.log(`     ${rustRelease}`);
    } else if (fs.existsSync(rustDebug)) {
      console.log("   ✓ Rust binary found (debug)");
      console.log(`     ${rustDebug}`);
    } else if (fs.existsSync(codexJsEntry)) {
      console.log("   ⚠ JS wrapper found but vendor binaries missing");
      console.log(`     ${codexJsEntry}`);
      console.log("     Run: cd src/engine/codex/codex-cli && npm install");
    } else {
      console.log("   ✗ Codex binary not found");
      console.log("     Build with: cd src/engine/codex/codex-rs && cargo build --release");
      console.log("     Or install: cd src/engine/codex/codex-cli && npm install");
    }
    
    // Check forbidden paths don't exist
    console.log("\n── Safety Check ──");
    const forbidden = path.join(os.homedir(), ".codex");
    if (fs.existsSync(forbidden)) {
      console.log(`   ⚠ Global ~/.codex exists (not used by Waypoint)`);
    } else {
      console.log("   ✓ No global ~/.codex directory");
    }
    
    console.log("\n✅ Doctor complete\n");
  });

// ─────────────────────────────────────────────────────────────────────────────
// Default behavior: treat unknown commands as agent prompts
// ─────────────────────────────────────────────────────────────────────────────

// List of known subcommands to avoid treating them as prompts
const knownCommands = new Set([
  "add", "ls", "test", "rm", "edit", "stat", "status", "acct",
  "service", "logs", "stats", "mcp", "run", "agent", "doctor", "help", "--help", "-h"
]);

// Check if the first argument is NOT a known command
const firstArg = process.argv[2];
const isAgentPrompt = firstArg && 
  !firstArg.startsWith("-") && 
  !knownCommands.has(firstArg);

if (isAgentPrompt) {
  // Treat all arguments as a prompt
  const prompt = process.argv.slice(2).join(" ");
  
  (async () => {
    const runner = new AgentRunner();
    
    try {
      const result = await runner.run({
        prompt,
        onStdout: (data) => process.stdout.write(data),
        onStderr: (data) => process.stderr.write(data),
      });
      
      process.exit(result.exitCode);
    } catch (error) {
      console.error(`Agent error: ${(error as Error).message}`);
      process.exit(1);
    }
  })();
} else {
  program.parseAsync().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

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

function isAudioModel(model: string): boolean {
  const name = model.toLowerCase();
  return name.includes("whisper") || name.includes("tts") || name.includes("speech");
}

async function resolveModelType(model: string): Promise<"llm" | "diffusion" | "audio" | "embedding"> {
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
