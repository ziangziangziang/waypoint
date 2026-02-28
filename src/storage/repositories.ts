import {
  appendRequestLog,
  defaultHealth,
  loadConfig,
  loadHealth,
  newEndpointId,
  readRequestLogs,
  saveConfig,
  saveHealth,
  StoragePaths,
  ConfigFile
} from "./files";
import {
  EndpointDoc,
  EndpointHealth,
  EndpointType,
  ModelCapabilities,
  ModelMapping,
  ModelModality,
  RequestLog,
} from "../types";
import {
  CapabilitiesRequirements,
  resolveCapabilities,
  supportsRequirements,
} from "../utils/modelCapabilities";
import { pickBestProviderModelByCapabilities } from "../providers/modelRegistry";

// ========================================
// Config Cache for Hot-Reload Support
// ========================================

interface ConfigCache {
  config: ConfigFile | null;
  health: { endpoints: Record<string, EndpointHealth> } | null;
  lastLoadedAt: number;
}

const cache: ConfigCache = {
  config: null,
  health: null,
  lastLoadedAt: 0
};

const CACHE_TTL_MS = 1000; // 1 second TTL for cache

/**
 * Invalidate the config cache. Call this when config changes externally.
 */
export function invalidateConfigCache(): void {
  cache.config = null;
  cache.health = null;
  cache.lastLoadedAt = 0;
  console.log("[repositories] Config cache invalidated");
}

/**
 * Check if cache is valid
 */
function isCacheValid(): boolean {
  return cache.config !== null && (Date.now() - cache.lastLoadedAt) < CACHE_TTL_MS;
}

async function getCachedConfig(paths: StoragePaths): Promise<ConfigFile> {
  if (!isCacheValid()) {
    cache.config = await loadConfig(paths);
    cache.lastLoadedAt = Date.now();
  }
  return cache.config!;
}

async function getCachedHealth(paths: StoragePaths): Promise<{ endpoints: Record<string, EndpointHealth> }> {
  // Health is always fresh-loaded since it changes frequently
  return loadHealth(paths);
}

export async function listEndpoints(paths: StoragePaths): Promise<EndpointDoc[]> {
  const config = await getCachedConfig(paths);
  const normalized = normalizeConfig(config);
  if (normalized.changed) {
    await saveConfig(paths, normalized.config);
    cache.config = normalized.config;
  }
  const health = await getCachedHealth(paths);
  return normalized.config.endpoints.map((endpoint) => ({
    ...endpoint,
    health: health.endpoints[endpoint.id] ?? defaultHealth()
  }));
}

export async function createEndpoint(
  paths: StoragePaths,
  input: Omit<EndpointDoc, "id" | "health" | "createdAt" | "updatedAt">
): Promise<EndpointDoc> {
  const normalized = normalizeConfig(await loadConfig(paths));
  if (normalized.changed) {
    await saveConfig(paths, normalized.config);
  }
  const config = normalized.config;
  const now = new Date();
  const endpoint: EndpointDoc = {
    ...input,
    id: newEndpointId(),
    health: defaultHealth(),
    disabled: input.disabled ?? false,
    createdAt: now,
    updatedAt: now
  };
  config.endpoints.push(stripHealth(endpoint));
  await saveConfig(paths, config);

  const health = await loadHealth(paths);
  health.endpoints[endpoint.id] = endpoint.health;
  await saveHealth(paths, health);

  return endpoint;
}

export async function updateEndpoint(
  paths: StoragePaths,
  id: string,
  patch: Partial<EndpointDoc>
): Promise<EndpointDoc | null> {
  const config = normalizeConfig(await loadConfig(paths)).config;
  const idx = config.endpoints.findIndex((endpoint) => endpoint.id === id);
  if (idx === -1) {
    return null;
  }
  const existing = config.endpoints[idx];
  const updated = {
    ...existing,
    ...stripHealth(patch as EndpointDoc),
    updatedAt: new Date()
  };
  config.endpoints[idx] = updated;
  await saveConfig(paths, config);

  const health = await loadHealth(paths);
  const healthState = health.endpoints[id] ?? defaultHealth();
  return { ...updated, health: healthState };
}

export async function setEndpointDisabled(
  paths: StoragePaths,
  id: string,
  disabled: boolean
): Promise<EndpointDoc | null> {
  const endpoint = await updateEndpoint(paths, id, { disabled });
  return endpoint;
}

export async function deleteEndpointByIdOrName(
  paths: StoragePaths,
  value: string
): Promise<EndpointDoc | null> {
  const config = normalizeConfig(await loadConfig(paths)).config;
  const target = config.endpoints.find((endpoint) => endpoint.id === value || endpoint.name === value);
  if (!target) {
    return null;
  }
  config.endpoints = config.endpoints.filter((endpoint) => endpoint.id !== target.id);
  await saveConfig(paths, config);

  const health = await loadHealth(paths);
  const healthState = health.endpoints[target.id] ?? defaultHealth();
  delete health.endpoints[target.id];
  await saveHealth(paths, health);

  return { ...target, health: healthState };
}

export async function getEndpointByIdOrName(paths: StoragePaths, value: string): Promise<EndpointDoc | null> {
  const config = normalizeConfig(await loadConfig(paths)).config;
  const endpoint = config.endpoints.find((item) => item.id === value || item.name === value);
  if (!endpoint) {
    return null;
  }
  const health = await loadHealth(paths);
  return { ...endpoint, health: health.endpoints[endpoint.id] ?? defaultHealth() };
}

export async function getEligibleEndpointsForModel(
  paths: StoragePaths,
  publicModel: string,
  requirements: {
    endpointType?: EndpointType;
    requiredInput?: ModelModality[];
    requiredOutput?: ModelModality[];
  } = {}
): Promise<EndpointDoc[]> {
  const endpoints = await listEndpoints(paths);
  const now = new Date();
  return endpoints.filter((endpoint) => {
    if (endpoint.disabled) {
      return false;
    }
    // Filter by endpoint type if specified
    if (requirements.endpointType && endpoint.type !== requirements.endpointType) {
      return false;
    }
    const model = endpoint.models.find((mapping) => mapping.publicName === publicModel);
    if (!model) {
      return false;
    }
    const capabilities = resolveCapabilities(model, endpoint.type);
    if (!supportsRequirements(capabilities, requirements)) {
      return false;
    }
    if (endpoint.health.status === "down") {
      return false;
    }
    if (endpoint.health.downUntil && endpoint.health.downUntil > now) {
      return false;
    }
    return true;
  });
}

export async function listEligibleEndpoints(paths: StoragePaths): Promise<EndpointDoc[]> {
  const endpoints = await listEndpoints(paths);
  const now = new Date();
  return endpoints.filter((endpoint) => {
    if (endpoint.disabled) {
      return false;
    }
    if (endpoint.health.status === "down") {
      return false;
    }
    if (endpoint.health.downUntil && endpoint.health.downUntil > now) {
      return false;
    }
    return true;
  });
}

export function sortEndpointsForRouting(endpoints: EndpointDoc[]): EndpointDoc[] {
  return endpoints.sort((a, b) => {
    if (a.priority !== b.priority) {
      return a.priority - b.priority;
    }
    const aLatency = a.health.latencyMsEwma ?? Number.POSITIVE_INFINITY;
    const bLatency = b.health.latencyMsEwma ?? Number.POSITIVE_INFINITY;
    return aLatency - bLatency;
  });
}

export async function updateHealthSuccess(
  paths: StoragePaths,
  endpointId: string,
  latencyMs: number
): Promise<void> {
  const health = await loadHealth(paths);
  const now = new Date();
  const current = health.endpoints[endpointId] ?? defaultHealth();
  const nextLatency = ewma(current.latencyMsEwma, latencyMs);
  health.endpoints[endpointId] = {
    ...current,
    status: "up",
    lastSuccessAt: now,
    consecutiveFailures: 0,
    latencyMsEwma: nextLatency,
    downUntil: undefined
  };
  await saveHealth(paths, health);
}

export async function updateHealthFailure(
  paths: StoragePaths,
  endpointId: string
): Promise<{ consecutiveFailures: number } | null> {
  const health = await loadHealth(paths);
  const now = new Date();
  const current = health.endpoints[endpointId] ?? defaultHealth();
  const next = {
    ...current,
    lastFailureAt: now,
    consecutiveFailures: current.consecutiveFailures + 1
  };
  health.endpoints[endpointId] = next;
  await saveHealth(paths, health);
  return { consecutiveFailures: next.consecutiveFailures };
}

export async function markEndpointDown(
  paths: StoragePaths,
  endpointId: string,
  downUntil: Date
): Promise<void> {
  const health = await loadHealth(paths);
  const current = health.endpoints[endpointId] ?? defaultHealth();
  health.endpoints[endpointId] = {
    ...current,
    status: "down",
    downUntil
  };
  await saveHealth(paths, health);
}

export async function updateHealthCheck(
  paths: StoragePaths,
  endpointId: string,
  status: "up" | "down",
  latencyMs: number | null
): Promise<void> {
  const health = await loadHealth(paths);
  const now = new Date();
  const current = health.endpoints[endpointId] ?? defaultHealth();
  const next: EndpointHealth = {
    ...current,
    status,
    lastCheckedAt: now
  };
  if (latencyMs !== null) {
    next.latencyMsEwma = ewma(current.latencyMsEwma, latencyMs);
    next.lastSuccessAt = now;
  } else {
    next.lastFailureAt = now;
  }
  health.endpoints[endpointId] = next;
  await saveHealth(paths, health);
}

export async function listPublicModels(paths: StoragePaths): Promise<string[]> {
  const config = normalizeConfig(await loadConfig(paths)).config;
  const names = new Set<string>();
  for (const endpoint of config.endpoints) {
    for (const model of endpoint.models) {
      names.add(model.publicName);
    }
  }
  return Array.from(names).sort();
}

export interface ModelWithType {
  id: string;
  type: 'llm' | 'diffusion' | 'audio' | 'embedding';
  endpointName: string;
  capabilities: ModelCapabilities;
}

export async function listModelsWithTypes(paths: StoragePaths): Promise<ModelWithType[]> {
  // Get endpoints with health status to filter out unhealthy ones
  const endpoints = await listEligibleEndpoints(paths);
  const models = new Map<string, ModelWithType>();
  for (const endpoint of endpoints) {
    for (const model of endpoint.models) {
      // First endpoint wins (in case model is on multiple endpoints)
      if (!models.has(model.publicName)) {
        models.set(model.publicName, {
          id: model.publicName,
          type: endpoint.type,
          endpointName: endpoint.name,
          capabilities: resolveCapabilities(model, endpoint.type),
        });
      }
    }
  }
  return Array.from(models.values()).sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Pick the best available LLM model based on endpoint priority and health.
 * Returns the publicName of the first LLM model from the highest-priority healthy endpoint.
 */
export async function pickBestLlmModel(paths: StoragePaths): Promise<string | null> {
  return pickBestProviderModelByCapabilities(
    paths,
    { requiredInput: ["text"], requiredOutput: ["text"] },
    "llm"
  );
}

export async function pickBestModelByCapabilities(
  paths: StoragePaths,
  requirements: CapabilitiesRequirements,
  preferredEndpointType?: EndpointType
): Promise<string | null> {
  return pickBestProviderModelByCapabilities(paths, requirements, preferredEndpointType);
}

export function getModelCapabilitiesForEndpoint(
  endpointType: EndpointType,
  mapping: ModelMapping
): ModelCapabilities {
  return resolveCapabilities(mapping, endpointType);
}

export async function logRequest(paths: StoragePaths, log: RequestLog): Promise<void> {
  await appendRequestLog(paths, log);
}

export async function getStats(
  paths: StoragePaths,
  windowMs: number
): Promise<{ total: number; success: number; errors: number; avgLatencyMs: number | null }> {
  const since = Date.now() - windowMs;
  const logs = await readRequestLogs(paths);
  const filtered = logs.filter((log) => new Date(log.ts).getTime() >= since);
  if (filtered.length === 0) {
    return { total: 0, success: 0, errors: 0, avgLatencyMs: null };
  }
  let sumLatency = 0;
  let latencyCount = 0;
  let errors = 0;
  for (const log of filtered) {
    if (log.result.errorType) {
      errors += 1;
    }
    if (typeof log.result.latencyMs === "number") {
      sumLatency += log.result.latencyMs;
      latencyCount += 1;
    }
  }
  const avgLatencyMs = latencyCount > 0 ? sumLatency / latencyCount : null;
  return {
    total: filtered.length,
    success: filtered.length - errors,
    errors,
    avgLatencyMs
  };
}

export async function getUsageByEndpoint(paths: StoragePaths): Promise<
  Array<{ endpointId: string; endpointName: string; totalTokens: number; count: number }>
> {
  const logs = await readRequestLogs(paths);
  const totals = new Map<string, { endpointName: string; totalTokens: number; count: number }>();
  for (const log of logs) {
    const endpointId = log.route.endpointId;
    if (!endpointId) {
      continue;
    }
    const entry = totals.get(endpointId) ?? { endpointName: log.route.endpointName ?? "unknown", totalTokens: 0, count: 0 };
    entry.totalTokens += log.result.totalTokens ?? 0;
    entry.count += 1;
    totals.set(endpointId, entry);
  }
  return Array.from(totals.entries()).map(([endpointId, entry]) => ({
    endpointId,
    endpointName: entry.endpointName,
    totalTokens: entry.totalTokens,
    count: entry.count
  }));
}

function ewma(prev: number | undefined, next: number, alpha = 0.2): number {
  if (prev === undefined) {
    return next;
  }
  return alpha * next + (1 - alpha) * prev;
}

function stripHealth(endpoint: EndpointDoc): Omit<EndpointDoc, "health"> {
  const { health: _health, ...rest } = endpoint;
  return rest;
}

function normalizeConfig(config: ConfigFile): {
  config: ConfigFile;
  changed: boolean;
} {
  let changed = false;
  const endpoints = config.endpoints.map((endpoint) => {
    let next = endpoint;
    if (!endpoint.id) {
      next = { ...next, id: newEndpointId() };
      changed = true;
    }
    if (!next.type) {
      next = { ...next, type: "llm" };
      changed = true;
    }
    if (typeof next.disabled !== "boolean") {
      next = { ...next, disabled: false };
      changed = true;
    }
    if (!next.createdAt) {
      next = { ...next, createdAt: new Date() };
      changed = true;
    } else if (!(next.createdAt instanceof Date)) {
      next = { ...next, createdAt: new Date(next.createdAt) };
      changed = true;
    }
    if (!next.updatedAt) {
      next = { ...next, updatedAt: new Date() };
      changed = true;
    } else if (!(next.updatedAt instanceof Date)) {
      next = { ...next, updatedAt: new Date(next.updatedAt) };
      changed = true;
    }
    return next;
  });
  return { config: { ...config, endpoints }, changed };
}
