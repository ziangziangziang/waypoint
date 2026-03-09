import { getPoolByAlias, listPools } from "../pools/repository";
import { PoolCandidate } from "../pools/types";
import { getProtocolAdapter } from "../protocols/registry";
import { ProtocolOperation } from "../protocols/types";
import { StoragePaths } from "../storage/files";
import { EndpointType, ModelCapabilities, ModelModality } from "../types";
import { supportsRequirements } from "../utils/modelCapabilities";
import { canonicalProviderModelId, getEffectiveModelInsecureTls, listProviders } from "./repository";
import { getProviderModelHealthMap } from "./health";
import { ProviderModelRecord, ProviderRecord } from "./types";

const SCORE_FALLBACK = 20;
const SMART_ALIAS = "smart";
const LEGACY_SMART_ALIAS_PREFIX = "smart-";

export interface RegistryModelEntry {
  id: string;
  provider_id: string;
  model_id: string;
  provider_model_id: string;
  object: "model";
  owned_by: string;
  endpoint_type: EndpointType;
  capabilities: ModelCapabilities;
  enabled: boolean;
  aliases: string[];
  slug: string;
  waypoint_health?: RegistryModelHealth;
}

export interface RegistryModelHealth {
  status: "up" | "down" | "unknown";
  lastCheckedAt?: string;
  consecutiveFailures?: number;
  latencyMsEwma?: number;
}

type CandidateRequirements = {
  requiredInput?: ModelModality[];
  requiredOutput?: ModelModality[];
};

export type ResolveModelResult =
  | { kind: "pool"; alias: string }
  | { kind: "direct"; canonicalId: string; candidates: PoolCandidate[] }
  | { kind: "deprecated_pool_alias"; input: string; replacement: typeof SMART_ALIAS }
  | { kind: "ambiguous"; input: string; matches: string[] }
  | { kind: "none"; input: string };

interface FlattenedProviderModel {
  provider: ProviderRecord;
  model: ProviderModelRecord;
  canonicalId: string;
}

export async function listModelsForApi(
  paths: StoragePaths,
  options?: { availableOnly?: boolean }
): Promise<RegistryModelEntry[]> {
  const providers = await listProviders(paths);
  const healthMap = await getProviderModelHealthMap(paths);
  const entries: RegistryModelEntry[] = [];

  for (const provider of providers) {
    for (const model of provider.models) {
      const health = healthMap[model.providerModelId];
      const status: RegistryModelHealth["status"] = health?.status ?? "unknown";
      if (options?.availableOnly && status === "down") {
        continue;
      }
      const canonicalId = canonicalProviderModelId(provider.id, model.modelId);
      entries.push({
        id: canonicalId,
        provider_id: provider.id,
        model_id: model.modelId,
        provider_model_id: model.providerModelId,
        object: "model",
        owned_by: "waypoint",
        endpoint_type: model.endpointType,
        capabilities: model.capabilities,
        enabled: provider.enabled && model.enabled !== false,
        aliases: model.aliases ?? [],
        slug: canonicalId,
        waypoint_health: {
          status,
          lastCheckedAt: health?.lastCheckedAt ? new Date(health.lastCheckedAt).toISOString() : undefined,
          consecutiveFailures: health?.consecutiveFailures,
          latencyMsEwma: health?.latencyMsEwma,
        },
      });
    }
  }

  return entries.sort((a, b) => a.id.localeCompare(b.id));
}

export async function resolveModel(
  paths: StoragePaths,
  inputId: string,
  requirements: CandidateRequirements,
  routing?: { operation: ProtocolOperation; stream: boolean }
): Promise<ResolveModelResult> {
  if (isDeprecatedSmartAlias(inputId)) {
    return {
      kind: "deprecated_pool_alias",
      input: inputId,
      replacement: SMART_ALIAS,
    };
  }

  const pool = await getPoolByAlias(paths, inputId);
  if (pool) {
    return { kind: "pool", alias: inputId };
  }

  const models = await flattenProviderModels(paths);
  const healthMap = await getProviderModelHealthMap(paths);
  const canonicalMatch = models.find((entry) => {
    return entry.canonicalId === inputId || entry.model.providerModelId === inputId;
  });
  if (canonicalMatch) {
    const candidates = await buildAndFilterCandidates(
      paths,
      [canonicalMatch],
      requirements,
      routing,
      healthMap
    );
    return {
      kind: "direct",
      canonicalId: canonicalMatch.canonicalId,
      candidates,
    };
  }

  const aliasMatches = models.filter((entry) => {
    if (entry.model.modelId === inputId) {
      return true;
    }
    return Boolean(entry.model.aliases?.includes(inputId));
  });

  if (aliasMatches.length === 0) {
    return { kind: "none", input: inputId };
  }
  if (aliasMatches.length > 1) {
    return {
      kind: "ambiguous",
      input: inputId,
      matches: aliasMatches.map((entry) => entry.canonicalId).sort(),
    };
  }

  const winner = aliasMatches[0];
  const candidates = await buildAndFilterCandidates(
    paths,
    [winner],
    requirements,
    routing,
    healthMap
  );
  return {
    kind: "direct",
    canonicalId: winner.canonicalId,
    candidates,
  };
}

export async function pickBestProviderModelByCapabilities(
  paths: StoragePaths,
  requirements: CandidateRequirements,
  preferredEndpointType?: EndpointType
): Promise<string | null> {
  const all = await flattenProviderModels(paths);
  const healthMap = await getProviderModelHealthMap(paths);
  const filtered = all
    .filter((entry) => entry.provider.enabled && entry.model.enabled !== false)
    .filter((entry) => {
      const health = healthMap[entry.model.providerModelId];
      return health?.status !== "down";
    })
    .filter((entry) => supportsRequirements(entry.model.capabilities, requirements));

  if (filtered.length === 0) {
    return null;
  }

  const ranked = filtered.sort((a, b) => {
    if (preferredEndpointType) {
      const aPreferred = a.model.endpointType === preferredEndpointType ? 1 : 0;
      const bPreferred = b.model.endpointType === preferredEndpointType ? 1 : 0;
      if (aPreferred !== bPreferred) {
        return bPreferred - aPreferred;
      }
    }
    const aScore = typeof a.model.benchmark?.livebench === "number" ? a.model.benchmark.livebench : SCORE_FALLBACK;
    const bScore = typeof b.model.benchmark?.livebench === "number" ? b.model.benchmark.livebench : SCORE_FALLBACK;
    if (aScore !== bScore) {
      return bScore - aScore;
    }
    return a.canonicalId.localeCompare(b.canonicalId);
  });

  return ranked[0].canonicalId;
}

export async function listModelAliases(paths: StoragePaths): Promise<string[]> {
  const providers = await listProviders(paths);
  const aliases = new Set<string>();
  for (const provider of providers) {
    for (const model of provider.models) {
      for (const alias of model.aliases ?? []) {
        aliases.add(alias);
      }
    }
  }
  const pools = await listPools(paths);
  for (const pool of pools) {
    for (const alias of pool.aliases) {
      if (alias === SMART_ALIAS) {
        aliases.add(alias);
      }
    }
  }
  return Array.from(aliases).sort();
}

export interface SmartPoolAvailability {
  id: string;
  alias: string;
  strategy: "highest_rank_available";
  candidateCount: number;
  capabilities: ModelCapabilities;
}

export async function getAvailableSmartPool(paths: StoragePaths): Promise<SmartPoolAvailability | null> {
  const pool = await getPoolByAlias(paths, SMART_ALIAS);
  if (!pool) {
    return null;
  }

  const healthMap = await getProviderModelHealthMap(paths);
  const candidates = pool.candidates.filter((candidate) => {
    if (!candidate.providerEnabled || !candidate.modelEnabled || !candidate.supportsRouting) {
      return false;
    }
    if (!candidate.baseUrl) {
      return false;
    }
    if (!getProtocolAdapter(candidate.protocol)) {
      return false;
    }
    if (candidate.providerModelId) {
      const health = healthMap[candidate.providerModelId];
      if (health?.status === "down") {
        return false;
      }
    }
    const requiresApiKey = (candidate.auth?.type ?? "bearer") !== "none";
    if (requiresApiKey && !candidate.apiKey) {
      return false;
    }
    return true;
  });

  if (candidates.length === 0) {
    return null;
  }

  return {
    id: pool.id,
    alias: SMART_ALIAS,
    strategy: pool.strategy,
    candidateCount: candidates.length,
    capabilities: unionCapabilities(candidates),
  };
}

async function flattenProviderModels(paths: StoragePaths): Promise<FlattenedProviderModel[]> {
  const providers = await listProviders(paths);
  const flattened: FlattenedProviderModel[] = [];
  for (const provider of providers) {
    for (const model of provider.models) {
      flattened.push({
        provider,
        model,
        canonicalId: canonicalProviderModelId(provider.id, model.modelId),
      });
    }
  }
  return flattened;
}

async function buildAndFilterCandidates(
  paths: StoragePaths,
  entries: FlattenedProviderModel[],
  requirements: CandidateRequirements,
  routing?: { operation: ProtocolOperation; stream: boolean },
  healthMap?: Record<string, { status?: "up" | "down" }>
): Promise<PoolCandidate[]> {
  const accepted: PoolCandidate[] = [];
  const modelHealth = healthMap ?? (await getProviderModelHealthMap(paths));
  for (const entry of entries) {
    const candidate = buildCandidate(entry.provider, entry.model);
    if (!candidate.providerEnabled || !candidate.modelEnabled) {
      continue;
    }
    if (candidate.providerModelId) {
      const health = modelHealth[candidate.providerModelId];
      if (health?.status === "down") {
        continue;
      }
    }
    if (!candidate.baseUrl) {
      continue;
    }
    const adapter = getProtocolAdapter(candidate.protocol);
    if (!candidate.supportsRouting || !adapter) {
      continue;
    }
    const requiresApiKey = (candidate.auth?.type ?? "bearer") !== "none";
    if (requiresApiKey && !candidate.apiKey) {
      continue;
    }
    if (!supportsRequirements(candidate.capabilities, requirements)) {
      continue;
    }
    if (routing) {
      const support = adapter.supports({
        operation: routing.operation,
        stream: routing.stream,
        capabilities: candidate.capabilities,
        requiredInput: requirements.requiredInput,
        requiredOutput: requirements.requiredOutput,
      });
      if (!support.supported) {
        continue;
      }
    }
    accepted.push(candidate);
  }
  return accepted.sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    return a.id.localeCompare(b.id);
  });
}

function buildCandidate(provider: ProviderRecord, model: ProviderModelRecord): PoolCandidate {
  const score = model.benchmark?.livebench;
  const baseUrl = model.baseUrl ?? provider.baseUrl;
  return {
    id: model.providerModelId,
    providerModelId: model.providerModelId,
    providerId: provider.id,
    providerName: provider.name,
    providerEnabled: provider.enabled,
    modelEnabled: model.enabled !== false,
    modelId: model.modelId,
    aliases: model.aliases ?? [],
    upstreamModel: model.upstreamModel,
    baseUrl: baseUrl ?? "",
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
    score: typeof score === "number" ? score : SCORE_FALLBACK,
    scoreSource: typeof score === "number" ? "benchmark.livebench" : "fallback",
    limits: {
      requestsPerMinute: model.limits?.requests?.perMinute ?? provider.limits?.requests?.perMinute,
      requestsPerDay: model.limits?.requests?.perDay ?? provider.limits?.requests?.perDay,
      tokensPerMinute: model.limits?.tokens?.perMinute ?? provider.limits?.tokens?.perMinute,
      tokensPerDay: model.limits?.tokens?.perDay ?? provider.limits?.tokens?.perDay,
    },
  };
}

function unionCapabilities(candidates: PoolCandidate[]): ModelCapabilities {
  const input = new Set<ModelModality>();
  const output = new Set<ModelModality>();
  let supportsTools = false;
  let supportsStreaming = false;

  for (const candidate of candidates) {
    for (const modality of candidate.capabilities.input) {
      input.add(modality);
    }
    for (const modality of candidate.capabilities.output) {
      output.add(modality);
    }
    if (candidate.capabilities.supportsTools) {
      supportsTools = true;
    }
    if (candidate.capabilities.supportsStreaming) {
      supportsStreaming = true;
    }
  }

  const capabilities: ModelCapabilities = {
    input: Array.from(input).sort(),
    output: Array.from(output).sort(),
    source: "inferred",
  };

  if (supportsTools) {
    capabilities.supportsTools = true;
  }
  if (supportsStreaming) {
    capabilities.supportsStreaming = true;
  }

  return capabilities;
}

function isDeprecatedSmartAlias(inputId: string): boolean {
  return inputId.startsWith(LEGACY_SMART_ALIAS_PREFIX) && inputId !== SMART_ALIAS;
}
