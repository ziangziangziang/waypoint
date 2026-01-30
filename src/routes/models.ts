import { FastifyInstance } from "fastify";
import { StoragePaths } from "../storage/files";
import { listModelsWithTypes } from "../storage/repositories";

export async function registerModelsRoutes(app: FastifyInstance, paths: StoragePaths): Promise<void> {
  app.get("/v1/models", async (_req, reply) => {
    const models = await listModelsWithTypes(paths);
    const data = models.map((m) => ({
      id: m.id,
      object: "model",
      owned_by: "waypoint",
      // Extension: include endpoint type for routing decisions
      endpoint_type: m.type,
      // Codex requirement: include slug field (same as id for simplicity)
      slug: m.id,
    }));
    // Include both 'data' (OpenAI standard) and 'models' (Codex compatibility)
    reply.send({ object: "list", data, models: data });
  });
}
