import { Agent, request } from "undici";
import { StoragePaths, loadProviderHealth, saveProviderHealth } from "../storage/files";
import { ProviderModelHealth } from "../types";
import { listProviders } from "./repository";
import { getEffectiveModelInsecureTls } from "./repository";

const DEFAULT_TIMEOUT_MS = 5000;

export interface ProviderModelProbeResult {
  providerModelId: string;
  providerId: string;
  modelId: string;
  baseUrl: string;
  status: "up" | "down";
  latencyMs?: number | null;
  statusCode?: number;
  error?: string;
}

export function defaultProviderModelHealth(): ProviderModelHealth {
  return {
    status: "up",
    consecutiveFailures: 0,
  };
}

export async function getProviderModelHealthMap(
  paths: StoragePaths
): Promise<Record<string, ProviderModelHealth>> {
  const health = await loadProviderHealth(paths);
  return health.models;
}

export async function updateProviderModelHealthCheck(
  paths: StoragePaths,
  providerModelId: string,
  status: "up" | "down",
  latencyMs: number | null,
  lastStatusCode?: number,
  lastError?: string
): Promise<void> {
  const health = await loadProviderHealth(paths);
  const now = new Date();
  const current = health.models[providerModelId] ?? defaultProviderModelHealth();

  let consecutiveFailures = current.consecutiveFailures;
  let nextStatus = current.status;

  if (status === "up") {
    consecutiveFailures = 0;
    nextStatus = "up";
  } else {
    consecutiveFailures = current.consecutiveFailures + 1;
    if (consecutiveFailures >= 3) {
      nextStatus = "down";
    }
  }

  const next: ProviderModelHealth = {
    ...current,
    status: nextStatus,
    consecutiveFailures,
    lastCheckedAt: now,
    lastStatusCode,
    lastError,
  };

  if (status === "up" && latencyMs !== null) {
    next.latencyMsEwma = ewma(current.latencyMsEwma, latencyMs);
    next.lastSuccessAt = now;
    next.lastFailureAt = undefined;
    next.lastError = undefined;
  } else if (status === "down") {
    next.lastFailureAt = now;
  }

  health.models[providerModelId] = next;
  await saveProviderHealth(paths, health);
}

export async function probeProviderModels(
  paths: StoragePaths,
  options?: { timeoutMs?: number }
): Promise<ProviderModelProbeResult[]> {
  const providers = await listProviders(paths);
  const targets = collectTargets(providers);
  const results: ProviderModelProbeResult[] = [];
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  await Promise.all(
    Array.from(targets.values()).map(async (target) => {
      const start = Date.now();
      try {
        const dispatcher = target.insecureTls
          ? new Agent({ connect: { rejectUnauthorized: false } })
          : undefined;
        const headers: Record<string, string> = {};
        if (target.apiKey) {
          headers.authorization = `Bearer ${target.apiKey}`;
        }
        const response = await request(new URL("/v1/models", target.baseUrl).toString(), {
          method: "GET",
          headers,
          headersTimeout: timeoutMs,
          bodyTimeout: timeoutMs,
          dispatcher,
        });
        const latency = Date.now() - start;
        response.body.resume();
        const ok = response.statusCode >= 200 && response.statusCode < 300;
        for (const model of target.models) {
          await updateProviderModelHealthCheck(
            paths,
            model.providerModelId,
            ok ? "up" : "down",
            ok ? latency : null,
            response.statusCode,
            ok ? undefined : `status ${response.statusCode}`
          );
          results.push({
            providerModelId: model.providerModelId,
            providerId: model.providerId,
            modelId: model.modelId,
            baseUrl: target.baseUrl,
            status: ok ? "up" : "down",
            latencyMs: ok ? latency : null,
            statusCode: response.statusCode,
            error: ok ? undefined : `status ${response.statusCode}`,
          });
        }
      } catch (error) {
        const errorMsg = (error as Error).message || "unknown error";
        for (const model of target.models) {
          await updateProviderModelHealthCheck(
            paths,
            model.providerModelId,
            "down",
            null,
            undefined,
            errorMsg
          );
          results.push({
            providerModelId: model.providerModelId,
            providerId: model.providerId,
            modelId: model.modelId,
            baseUrl: target.baseUrl,
            status: "down",
            latencyMs: null,
            error: errorMsg,
          });
        }
      }
    })
  );

  return results;
}

type HealthProbeTarget = {
  baseUrl: string;
  apiKey?: string;
  insecureTls?: boolean;
  models: Array<{ providerModelId: string; providerId: string; modelId: string }>;
};

function collectTargets(
  providers: Awaited<ReturnType<typeof listProviders>>
): Map<string, HealthProbeTarget> {
  const targets = new Map<string, HealthProbeTarget>();
  for (const provider of providers) {
    if (!provider.enabled) {
      continue;
    }
    for (const model of provider.models) {
      if (model.enabled === false) {
        continue;
      }
      const baseUrl = model.baseUrl ?? provider.baseUrl;
      if (!baseUrl) {
        continue;
      }
      const apiKey = model.apiKey ?? provider.apiKey;
      const insecureTls = getEffectiveModelInsecureTls(provider, model);
      const key = `${baseUrl}@@${apiKey ? "key" : "nokey"}@@${insecureTls ? "insecure" : "secure"}`;
      const entry = targets.get(key) ?? {
        baseUrl,
        apiKey,
        insecureTls,
        models: [],
      };
      entry.models.push({
        providerModelId: model.providerModelId,
        providerId: provider.id,
        modelId: model.modelId,
      });
      targets.set(key, entry);
    }
  }
  return targets;
}

function ewma(previous: number | undefined, next: number, alpha = 0.2): number {
  if (previous === undefined) {
    return next;
  }
  return alpha * next + (1 - alpha) * previous;
}
