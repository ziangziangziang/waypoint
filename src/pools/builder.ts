import { StoragePaths } from "../storage/files";
import { listProviders } from "../providers/repository";
import { supportsRequirements } from "../utils/modelCapabilities";
import { ModelModality } from "../types";
import { savePools } from "./repository";
import { PoolCandidate, PoolDefinition } from "./types";
import { getEffectiveModelInsecureTls } from "../providers/repository";

interface PoolTemplate {
  id: string;
  aliases: string[];
  requiredInput: ModelModality[];
  requiredOutput: ModelModality[];
}

const DEFAULT_SCORE_FALLBACK = 20;

const DEFAULT_POOLS: PoolTemplate[] = [
  {
    id: "smart",
    aliases: ["smart"],
    requiredInput: [],
    requiredOutput: [],
  },
];

export async function rebuildDefaultPools(
  paths: StoragePaths,
  scoreFallback = DEFAULT_SCORE_FALLBACK
): Promise<PoolDefinition[]> {
  const providers = await listProviders(paths);

  const pools: PoolDefinition[] = DEFAULT_POOLS.map((template) => ({
    id: template.id,
    aliases: template.aliases,
    strategy: "highest_rank_available",
    requiredInput: template.requiredInput,
    requiredOutput: template.requiredOutput,
    scoreFallback,
    candidates: [],
    updatedAt: new Date().toISOString(),
  }));

  for (const provider of providers) {
    for (const model of provider.models) {
      const effectiveBaseUrl = model.baseUrl ?? provider.baseUrl;
      const score = model.benchmark?.livebench;
      const candidate: PoolCandidate = {
        id: model.providerModelId,
        providerModelId: model.providerModelId,
        providerId: provider.id,
        providerName: provider.name,
        providerEnabled: provider.enabled,
        modelEnabled: model.enabled !== false,
        modelId: model.modelId,
        aliases: model.aliases ?? [],
        upstreamModel: model.upstreamModel,
        baseUrl: effectiveBaseUrl ?? "",
        apiKey: model.apiKey ?? provider.apiKey,
        insecureTls: getEffectiveModelInsecureTls(provider, model),
        autoInsecureTlsDomains: provider.autoInsecureTlsDomains ?? [],
        protocol: provider.protocol,
        protocolConfig: provider.protocolConfig,
        auth: provider.auth,
        supportsRouting: provider.supportsRouting,
        free: model.free,
        endpointType: model.endpointType,
        capabilities: model.capabilities,
        score: typeof score === "number" ? score : scoreFallback,
        scoreSource: typeof score === "number" ? "benchmark.livebench" : "fallback",
        limits: {
          requestsPerMinute: model.limits?.requests?.perMinute ?? provider.limits?.requests?.perMinute,
          requestsPerDay: model.limits?.requests?.perDay ?? provider.limits?.requests?.perDay,
          tokensPerMinute: model.limits?.tokens?.perMinute ?? provider.limits?.tokens?.perMinute,
          tokensPerDay: model.limits?.tokens?.perDay ?? provider.limits?.tokens?.perDay,
        },
      };

      for (const pool of pools) {
        if (!model.free) {
          continue;
        }
        if (
          supportsRequirements(candidate.capabilities, {
            requiredInput: pool.requiredInput,
            requiredOutput: pool.requiredOutput,
          })
        ) {
          pool.candidates.push(candidate);
        }
      }
    }
  }

  for (const pool of pools) {
    pool.candidates = pool.candidates.sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }
      return `${a.providerId}/${a.modelId}`.localeCompare(`${b.providerId}/${b.modelId}`);
    });
    pool.updatedAt = new Date().toISOString();
  }

  await savePools(paths, pools);
  return pools;
}
