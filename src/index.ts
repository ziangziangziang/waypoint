import Fastify from "fastify";
import { registerChatRoutes } from "./routes/chat";
import { registerEmbeddingsRoutes } from "./routes/embeddings";
import { registerModelsRoutes } from "./routes/models";
import { registerAdminRoutes } from "./routes/admin";
import { registerImageRoutes } from "./routes/images";
import { registerAudioRoutes } from "./routes/audio";
import { registerResponsesRoutes } from "./routes/responses";
import { registerStatsRoutes } from "./routes/stats";
import { registerSessionRoutes } from "./routes/sessions";
import { registerMcpRoutes } from "./routes/mcp";
import { registerUiRoutes } from "./routes/ui";
import { registerRequestStatsMiddleware } from "./middleware/requestStats";
import { registerAuthHooks, loadAuthConfig, updateAuthConfig } from "./middleware/auth";
import { startHealthChecker } from "./workers/healthChecker";
import { startStatsRotation } from "./workers/statsRotation";
import { startConfigWatcher, stopConfigWatcher } from "./workers/configWatcher";
import { ensureStorageDir, resolveStoragePaths } from "./storage/files";
import { invalidateConfigCache } from "./storage/repositories";
import { discoverAllTools, disconnectAllServers } from "./mcp/discovery";

const PORT = Number(process.env.PORT ?? "8000");
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;

async function start(): Promise<void> {
  const app = Fastify({ logger: true });
  const paths = resolveStoragePaths();
  await ensureStorageDir(paths);

  // Register middleware
  await registerRequestStatsMiddleware(app, paths);
  
  // Register auth hooks (no-op by default, enable via config.authEnabled)
  await registerAuthHooks(app, paths, ["/admin", "/ui"]);

  // OpenAI-compatible routes
  await registerChatRoutes(app, paths);
  await registerEmbeddingsRoutes(app, paths);
  await registerModelsRoutes(app, paths);
  await registerImageRoutes(app, paths);
  await registerAudioRoutes(app, paths);
  await registerResponsesRoutes(app, paths);
  
  // Admin routes
  await registerAdminRoutes(app, paths, { adminToken: ADMIN_TOKEN });
  await registerStatsRoutes(app, paths);
  await registerSessionRoutes(app);
  await registerMcpRoutes(app, paths);
  
  // UI routes (serve React frontend)
  await registerUiRoutes(app);

  // Start background workers
  startHealthChecker(paths);
  startStatsRotation(paths);
  
  // Auto-connect to enabled MCP servers and discover tools
  discoverAllTools(paths).then((tools) => {
    if (tools.length > 0) {
      console.log(`[waypoint] Connected to MCP servers, discovered ${tools.length} tools`);
    }
  }).catch((error) => {
    console.error("[waypoint] Failed to auto-connect to MCP servers:", error);
  });
  
  // Start config watcher for hot-reload
  const configWatcher = startConfigWatcher(paths);
  configWatcher.on("config:updated", async () => {
    invalidateConfigCache();
    // Reload auth config on config change
    const authConfig = await loadAuthConfig(paths);
    updateAuthConfig(authConfig);
    console.log("[waypoint] Config reloaded - no restart needed");
  });

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(`\n[${signal}] Shutting down gracefully...`);
    stopConfigWatcher();
    await disconnectAllServers();
    await app.close();
    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  await app.listen({ port: PORT, host: "0.0.0.0" });
  
  console.log(`\n🚀 Waypoint running on http://localhost:${PORT}`);
  console.log(`   Endpoints: /v1/chat/completions, /v1/embeddings, /v1/images/*, /v1/audio/*`);
  console.log(`   Admin: /admin/*, /admin/stats, /admin/sessions, /admin/mcp`);
  console.log(`   UI: http://localhost:${PORT}/ui\n`);
}

start().catch((error) => {
  console.error(error);
  process.exit(1);
});
