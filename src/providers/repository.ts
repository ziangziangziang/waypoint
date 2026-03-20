import { StoragePaths, readJsonFile, writeJsonFile } from "../storage/files";
import { ProviderModelRecord, ProviderRecord, ProviderStoreFile } from "./types";

const CURRENT_VERSION = 3;

export interface ModelRefResolution {
  provider: ProviderRecord;
  model: ProviderModelRecord;
  modelIndex: number;
}

function defaultStore(): ProviderStoreFile {
  return {
    version: CURRENT_VERSION,
    updatedAt: new Date().toISOString(),
    providers: [],
  };
}

export function canonicalProviderModelId(providerId: string, modelId: string): string {
  return `${providerId}/${modelId}`;
}

export async function loadProviderStore(paths: StoragePaths): Promise<ProviderStoreFile> {
  const store = await readJsonFile<ProviderStoreFile>(paths.providersPath, defaultStore());
  if (!Array.isArray(store.providers)) {
    return defaultStore();
  }
  const providers = store.providers.map(normalizeProviderRecord);
  return {
    version: Number.isFinite(store.version) ? store.version : CURRENT_VERSION,
    updatedAt: typeof store.updatedAt === "string" ? store.updatedAt : new Date().toISOString(),
    providers,
  };
}

export async function saveProviderStore(paths: StoragePaths, providers: ProviderRecord[]): Promise<void> {
  const next: ProviderStoreFile = {
    version: CURRENT_VERSION,
    updatedAt: new Date().toISOString(),
    providers: providers.map(normalizeProviderRecord),
  };
  await writeJsonFile(paths.providersPath, next);
}

export async function listProviders(paths: StoragePaths): Promise<ProviderRecord[]> {
  const store = await loadProviderStore(paths);
  return [...store.providers].sort((a, b) => a.id.localeCompare(b.id));
}

export async function getProviderById(paths: StoragePaths, providerId: string): Promise<ProviderRecord | null> {
  const providers = await listProviders(paths);
  return providers.find((provider) => provider.id === providerId) ?? null;
}

export async function setProviderEnabled(
  paths: StoragePaths,
  providerId: string,
  enabled: boolean
): Promise<ProviderRecord | null> {
  const store = await loadProviderStore(paths);
  const index = store.providers.findIndex((provider) => provider.id === providerId);
  if (index === -1) {
    return null;
  }
  const updated: ProviderRecord = {
    ...store.providers[index],
    enabled,
  };
  store.providers[index] = normalizeProviderRecord(updated);
  await saveProviderStore(paths, store.providers);
  return store.providers[index];
}

export async function upsertProviders(paths: StoragePaths, providers: ProviderRecord[]): Promise<void> {
  const existing = await loadProviderStore(paths);
  const byId = new Map(existing.providers.map((provider) => [provider.id, normalizeProviderRecord(provider)]));

  for (const provider of providers) {
    const normalized = normalizeProviderRecord(provider);
    const prev = byId.get(provider.id);
    if (!prev) {
      byId.set(provider.id, normalized);
      continue;
    }

    const mergedByModelId = new Map(prev.models.map((model) => [model.providerModelId, model]));
    for (const model of normalized.models) {
      const previousModel = mergedByModelId.get(model.providerModelId);
      mergedByModelId.set(model.providerModelId, normalizeProviderModelRecord({
        ...model,
        enabled: previousModel?.enabled ?? model.enabled,
        apiKey: model.apiKey ?? previousModel?.apiKey,
        aliases: model.aliases?.length ? model.aliases : previousModel?.aliases,
      }));
    }

    byId.set(provider.id, normalizeProviderRecord({
      ...normalized,
      enabled: prev.enabled,
      apiKey: normalized.apiKey ?? prev.apiKey,
      insecureTls: provider.insecureTls ?? prev.insecureTls,
      autoInsecureTlsDomains:
        provider.autoInsecureTlsDomains ?? prev.autoInsecureTlsDomains,
      models: Array.from(mergedByModelId.values()),
    }));
  }

  await saveProviderStore(paths, Array.from(byId.values()));
}

export async function upsertProvider(paths: StoragePaths, provider: ProviderRecord): Promise<ProviderRecord> {
  const existing = await loadProviderStore(paths);
  const index = existing.providers.findIndex((entry) => entry.id === provider.id);
  if (index === -1) {
    const normalized = normalizeProviderRecord(provider);
    existing.providers.push(normalized);
    await saveProviderStore(paths, existing.providers);
    return normalized;
  }

  const prev = normalizeProviderRecord(existing.providers[index]);
  const next = normalizeProviderRecord({
    ...provider,
    enabled: prev.enabled,
    apiKey: provider.apiKey ?? prev.apiKey,
    insecureTls: provider.insecureTls ?? prev.insecureTls,
    autoInsecureTlsDomains:
      provider.autoInsecureTlsDomains ?? prev.autoInsecureTlsDomains,
  });
  existing.providers[index] = next;
  await saveProviderStore(paths, existing.providers);
  return next;
}

export async function updateProvider(
  paths: StoragePaths,
  providerId: string,
  patch: Partial<ProviderRecord>
): Promise<ProviderRecord | null> {
  const store = await loadProviderStore(paths);
  const index = store.providers.findIndex((provider) => provider.id === providerId);
  if (index === -1) {
    return null;
  }

  const current = normalizeProviderRecord(store.providers[index]);
  const updated = normalizeProviderRecord({
    ...current,
    ...patch,
    id: providerId,
    models: patch.models ?? current.models,
  });
  store.providers[index] = updated;
  await saveProviderStore(paths, store.providers);
  return updated;
}

export async function deleteProvider(
  paths: StoragePaths,
  providerId: string
): Promise<ProviderRecord | null> {
  const store = await loadProviderStore(paths);
  const index = store.providers.findIndex((provider) => provider.id === providerId);
  if (index === -1) {
    return null;
  }
  const [removed] = store.providers.splice(index, 1);
  await saveProviderStore(paths, store.providers);
  return normalizeProviderRecord(removed);
}

export async function listProviderModels(paths: StoragePaths, providerId: string): Promise<ProviderModelRecord[] | null> {
  const provider = await getProviderById(paths, providerId);
  if (!provider) {
    return null;
  }
  return [...provider.models].sort((a, b) => a.modelId.localeCompare(b.modelId));
}

export async function getProviderModel(
  paths: StoragePaths,
  providerId: string,
  modelRef: string
): Promise<ProviderModelRecord | null> {
  const resolved = await resolveProviderModelRef(paths, providerId, modelRef);
  if (!resolved) {
    return null;
  }
  return resolved.model;
}

export async function resolveProviderModelRef(
  paths: StoragePaths,
  providerId: string,
  modelRef: string
): Promise<ModelRefResolution | null> {
  const provider = await getProviderById(paths, providerId);
  if (!provider) {
    return null;
  }

  const normalizedRef = modelRef.trim();
  const candidates = provider.models
    .map((model, modelIndex) => ({ model, modelIndex }))
    .filter(({ model }) => {
      if (model.providerModelId === normalizedRef) {
        return true;
      }
      if (canonicalProviderModelId(providerId, model.modelId) === normalizedRef) {
        return true;
      }
      if (model.modelId === normalizedRef) {
        return true;
      }
      return Boolean(model.aliases?.includes(normalizedRef));
    });

  if (candidates.length !== 1) {
    return null;
  }

  return {
    provider,
    model: candidates[0].model,
    modelIndex: candidates[0].modelIndex,
  };
}

export async function upsertProviderModel(
  paths: StoragePaths,
  providerId: string,
  model: ProviderModelRecord
): Promise<{ provider: ProviderRecord; created: boolean } | null> {
  const store = await loadProviderStore(paths);
  const providerIndex = store.providers.findIndex((provider) => provider.id === providerId);
  if (providerIndex === -1) {
    return null;
  }

  const provider = normalizeProviderRecord(store.providers[providerIndex]);
  const normalizedModel = normalizeProviderModelRecord({
    ...model,
    providerId,
  });
  const modelIndex = provider.models.findIndex(
    (entry) => entry.providerModelId === normalizedModel.providerModelId
  );

  if (modelIndex === -1) {
    provider.models.push(normalizedModel);
    store.providers[providerIndex] = provider;
    await saveProviderStore(paths, store.providers);
    return { provider, created: true };
  }

  provider.models[modelIndex] = {
    ...provider.models[modelIndex],
    ...normalizedModel,
    providerId,
  };
  store.providers[providerIndex] = provider;
  await saveProviderStore(paths, store.providers);
  return { provider, created: false };
}

export async function updateProviderModel(
  paths: StoragePaths,
  providerId: string,
  modelRef: string,
  patch: Partial<ProviderModelRecord>
): Promise<ProviderModelRecord | null> {
  const store = await loadProviderStore(paths);
  const providerIndex = store.providers.findIndex((provider) => provider.id === providerId);
  if (providerIndex === -1) {
    return null;
  }
  const provider = normalizeProviderRecord(store.providers[providerIndex]);
  const matchingIndexes = provider.models.flatMap((model, index) => {
    if (model.providerModelId === modelRef) {
      return [index];
    }
    if (model.modelId === modelRef) {
      return [index];
    }
    if (model.aliases?.includes(modelRef)) {
      return [index];
    }
    return [];
  });
  if (matchingIndexes.length !== 1) {
    return null;
  }
  const modelIndex = matchingIndexes[0];

  const updated = normalizeProviderModelRecord({
    ...provider.models[modelIndex],
    ...patch,
    providerId,
  });
  provider.models[modelIndex] = updated;
  store.providers[providerIndex] = provider;
  await saveProviderStore(paths, store.providers);
  return updated;
}

export async function deleteProviderModel(
  paths: StoragePaths,
  providerId: string,
  modelRef: string
): Promise<ProviderModelRecord | null> {
  const store = await loadProviderStore(paths);
  const providerIndex = store.providers.findIndex((provider) => provider.id === providerId);
  if (providerIndex === -1) {
    return null;
  }
  const provider = normalizeProviderRecord(store.providers[providerIndex]);
  const matchingIndexes = provider.models.flatMap((model, index) => {
    if (model.providerModelId === modelRef) {
      return [index];
    }
    if (model.modelId === modelRef) {
      return [index];
    }
    if (model.aliases?.includes(modelRef)) {
      return [index];
    }
    return [];
  });
  if (matchingIndexes.length !== 1) {
    return null;
  }
  const modelIndex = matchingIndexes[0];

  const [removed] = provider.models.splice(modelIndex, 1);
  store.providers[providerIndex] = provider;
  await saveProviderStore(paths, store.providers);
  return removed;
}

export async function setProviderModelEnabled(
  paths: StoragePaths,
  providerId: string,
  modelRef: string,
  enabled: boolean
): Promise<ProviderModelRecord | null> {
  return updateProviderModel(paths, providerId, modelRef, { enabled });
}

export async function setProviderModelApiKey(
  paths: StoragePaths,
  providerId: string,
  modelRef: string,
  apiKey: string | undefined
): Promise<ProviderModelRecord | null> {
  return updateProviderModel(paths, providerId, modelRef, { apiKey });
}

export async function setProviderModelInsecureTls(
  paths: StoragePaths,
  providerId: string,
  modelRef: string,
  insecureTls: boolean | undefined
): Promise<ProviderModelRecord | null> {
  return updateProviderModel(paths, providerId, modelRef, { insecureTls });
}

export function getEffectiveModelInsecureTls(
  provider: Pick<ProviderRecord, "insecureTls">,
  model: Pick<ProviderModelRecord, "insecureTls">
): boolean {
  return model.insecureTls ?? provider.insecureTls ?? false;
}

function normalizeProviderRecord(provider: ProviderRecord): ProviderRecord {
  const models = Array.isArray(provider.models) ? provider.models.map((model) => normalizeProviderModelRecord({
    ...model,
    providerId: provider.id,
  })) : [];
  return {
    ...provider,
    id: provider.id,
    insecureTls: provider.insecureTls === true,
    autoInsecureTlsDomains: normalizeDomainSuffixes(provider.autoInsecureTlsDomains),
    models,
  };
}

function normalizeProviderModelRecord(model: ProviderModelRecord): ProviderModelRecord {
  const aliases = normalizeAliases(model.aliases);
  const providerId = model.providerId;
  const modelId = model.modelId.trim();
  return {
    ...model,
    providerId,
    modelId,
    providerModelId: model.providerModelId || canonicalProviderModelId(providerId, modelId),
    aliases,
    enabled: model.enabled ?? true,
  };
}

function normalizeAliases(aliases: string[] | undefined): string[] {
  if (!Array.isArray(aliases)) {
    return [];
  }
  const dedup = new Set<string>();
  for (const alias of aliases) {
    const normalized = alias.trim();
    if (normalized) {
      dedup.add(normalized);
    }
  }
  return Array.from(dedup);
}

export function normalizeDomainSuffixes(domains: string[] | undefined): string[] {
  if (!Array.isArray(domains)) {
    return [];
  }
  const dedup = new Set<string>();
  for (const domain of domains) {
    let normalized = domain.trim().toLowerCase();
    if (!normalized) {
      continue;
    }
    if (normalized.startsWith("*.")) {
      normalized = normalized.slice(2);
    }
    if (normalized.startsWith(".")) {
      normalized = normalized.slice(1);
    }
    if (!normalized) {
      continue;
    }
    dedup.add(normalized);
  }
  return Array.from(dedup);
}
