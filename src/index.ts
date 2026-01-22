import Fastify from "fastify";
import { registerChatRoutes } from "./routes/chat";
import { registerEmbeddingsRoutes } from "./routes/embeddings";
import { registerModelsRoutes } from "./routes/models";
import { registerAdminRoutes } from "./routes/admin";
import { startHealthChecker } from "./workers/healthChecker";
import { ensureStorageDir, resolveStoragePaths } from "./storage/files";

const PORT = Number(process.env.PORT ?? "8000");
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;

async function start(): Promise<void> {
  const app = Fastify({ logger: true });
  const paths = resolveStoragePaths();
  await ensureStorageDir(paths);

  await registerChatRoutes(app, paths);
  await registerEmbeddingsRoutes(app, paths);
  await registerModelsRoutes(app, paths);
  await registerAdminRoutes(app, paths, { adminToken: ADMIN_TOKEN });

  startHealthChecker(paths);

  await app.listen({ port: PORT, host: "0.0.0.0" });
}

start().catch((error) => {
  console.error(error);
  process.exit(1);
});
