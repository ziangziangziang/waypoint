import { FastifyInstance } from "fastify";
import { StoragePaths } from "../storage/files";
import { listPublicModels } from "../storage/repositories";

export async function registerModelsRoutes(app: FastifyInstance, paths: StoragePaths): Promise<void> {
  app.get("/v1/models", async (_req, reply) => {
    const models = await listPublicModels(paths);
    const data = models.map((id) => ({
      id,
      object: "model",
      owned_by: "waypoint"
    }));
    reply.send({ object: "list", data });
  });
}
