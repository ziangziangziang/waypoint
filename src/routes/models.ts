import { FastifyInstance } from "fastify";
import { StoragePaths } from "../storage/files";
import { EndpointType, ModelModality } from "../types";
import { getAvailableSmartPool, listModelsForApi } from "../providers/modelRegistry";

export async function registerModelsRoutes(app: FastifyInstance, paths: StoragePaths): Promise<void> {
  app.get("/v1/models", async (_req, reply) => {
    const concrete = await listModelsForApi(paths);
    const smart = await getAvailableSmartPool(paths);
    const poolEntries = smart
      ? [
          {
            id: smart.alias,
            object: "model" as const,
            owned_by: "waypoint",
            endpoint_type: inferEndpointType(smart.capabilities.output),
            capabilities: smart.capabilities,
            slug: smart.alias,
            waypoint_pool: {
              id: smart.id,
              strategy: smart.strategy,
              candidateCount: smart.candidateCount,
              scoreSource: "benchmark.livebench",
            },
          },
        ]
      : [];
    const data = [...concrete, ...poolEntries];
    // Include both `data` and `models` for broader client compatibility.
    reply.send({ object: "list", data, models: data });
  });
}

function inferEndpointType(output: ModelModality[]): EndpointType {
  if (output.includes("text")) {
    return "llm";
  }
  if (output.includes("embedding")) {
    return "embedding";
  }
  if (output.includes("image")) {
    return "diffusion";
  }
  if (output.includes("audio")) {
    return "audio";
  }
  return "llm";
}
