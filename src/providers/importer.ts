import { promises as fs } from "fs";
import path from "path";
import YAML from "yaml";
import { ModelCapabilities, ModelModality } from "../types";
import { StoragePaths } from "../storage/files";
import { canonicalizeProtocol, hasProtocolAdapter } from "../protocols/registry";
import { loadProviderStore, normalizeDomainSuffixes, saveProviderStore } from "./repository";
import {
  EnvMap,
  ProviderAuthConfig,
  ProviderImportOptions,
  ProviderImportResult,
  ProviderLimits,
  ProviderProtocol,
  ProviderProtocolConfig,
  ProviderRecord,
  ProviderRegistryEntry,
} from "./types";

interface RegistryFile {
  providers?: ProviderRegistryEntry[];
}

interface ProviderConfigFile {
  $id?: string;
  name?: string;
  description?: string;
  docs?: string;
  endpoint?: {
    baseUrl?: string;
    protocol?: string;
    insecureTls?: boolean;
    router?: string;
    responseTextPaths?: string[];
  };
  auth?: {
    type?: string;
    keyParam?: string;
    headerName?: string;
    keyPrefix?: string;
  };
  env?: string;
  autoInsecureTlsDomains?: string[];
  responseTextPaths?: string[];
  limits?: ProviderLimits;
  models?: Array<{
    id?: string;
    upstream?: string;
    baseUrl?: string;
    apiKey?: string;
    insecureTls?: boolean;
    enabled?: boolean;
    free?: boolean;
    modalities?: string[];
    capabilities?: {
      tools?: boolean;
      streaming?: boolean;
      vision?: boolean;
    };
    benchmark?: {
      livebench?: number;
    };
    limits?: ProviderLimits;
  }>;
}

export async function importProviders(
  paths: StoragePaths,
  options: ProviderImportOptions
): Promise<ProviderImportResult> {
  const registryPath = path.resolve(options.registryPath);
  const registryDir = path.dirname(registryPath);
  const registryRaw = await fs.readFile(registryPath, "utf8");
  const registry = (YAML.parse(registryRaw) ?? {}) as RegistryFile;
  const envMap = await loadEnvMap(options.envFilePath);

  const warnings: string[] = [];
  const providers: ProviderRecord[] = [];
  const existing = await loadProviderStore(paths);
  const existingById = new Map(existing.providers.map((provider) => [provider.id, provider]));

  for (const entry of registry.providers ?? []) {
    if (!entry?.id || !entry.file) {
      warnings.push(`Skipping malformed registry entry: ${JSON.stringify(entry)}`);
      continue;
    }

    const providerConfigPath = path.resolve(registryDir, entry.file);
    let configRaw: string;
    try {
      configRaw = await fs.readFile(providerConfigPath, "utf8");
    } catch (error) {
      warnings.push(`Failed to load provider config ${providerConfigPath}: ${(error as Error).message}`);
      continue;
    }

    const config = (YAML.parse(configRaw) ?? {}) as ProviderConfigFile;

    const protocolRaw = (config.endpoint?.protocol ?? entry.protocol ?? "unknown").toLowerCase();
    const normalizedProtocol = canonicalizeProtocol(protocolRaw);
    const protocol: ProviderProtocol =
      normalizedProtocol === "openai" || normalizedProtocol === "inference_v2"
        ? normalizedProtocol
        : "unknown";
    const auth = parseAuthConfig(config.auth);
    const protocolConfig = parseProtocolConfig(config, protocol);
    let supportsRouting = hasProtocolAdapter(protocol);

    const providerId = config.$id ?? entry.id;
    const previous = existingById.get(providerId);
    const envVar = typeof config.env === "string" ? config.env : undefined;
    const apiKey = resolveApiKey(
      envVar,
      envMap,
      previous?.apiKey,
      options.overwriteAuth ?? false
    );
    const baseUrl = config.endpoint?.baseUrl;

    if (!baseUrl) {
      warnings.push(`Provider '${providerId}' has no endpoint.baseUrl; skipped.`);
      continue;
    }

    if (protocol === "inference_v2" && !protocolConfig?.router) {
      warnings.push(`Provider '${providerId}' protocol '${protocolRaw}' requires endpoint.router; imported non-routable.`);
      supportsRouting = false;
    }

    if (!supportsRouting) {
      warnings.push(
        `Provider '${providerId}' protocol '${protocolRaw}' imported as non-routable in v1.`
      );
    }

    const models = (config.models ?? [])
      .map((model) => {
        if (!model.id) {
          warnings.push(`Provider '${providerId}' has model without id; skipped.`);
          return null;
        }
        const providerModelId = `${providerId}/${model.id}`;
        const capabilities = toCapabilities(model.modalities ?? [], model.capabilities ?? {});
        return {
          providerModelId,
          providerId,
          modelId: model.id,
          upstreamModel: model.upstream ?? model.id,
          baseUrl: typeof model.baseUrl === "string" ? model.baseUrl : undefined,
          apiKey: typeof model.apiKey === "string" ? model.apiKey : undefined,
          insecureTls: model.insecureTls === true,
          enabled: model.enabled !== false,
          aliases: [],
          free: model.free !== false,
          modalities: model.modalities ?? [],
          capabilities,
          endpointType: inferEndpointType(capabilities),
          benchmark: normalizeBenchmark(model.benchmark),
          limits: model.limits,
        };
      })
      .filter((model): model is NonNullable<typeof model> => model !== null);

    providers.push({
      id: providerId,
      name: config.name ?? entry.name ?? providerId,
      description: config.description,
      docs: config.docs,
      protocol,
      protocolRaw,
      protocolConfig,
      baseUrl,
      insecureTls: previous?.insecureTls ?? (config.endpoint?.insecureTls === true),
      autoInsecureTlsDomains:
        previous?.autoInsecureTlsDomains ?? normalizeDomainSuffixes(config.autoInsecureTlsDomains),
      enabled: previous?.enabled ?? true,
      supportsRouting,
      auth,
      envVar,
      apiKey,
      limits: config.limits,
      models,
      warnings: supportsRouting ? undefined : [`Unsupported protocol: ${protocolRaw}`],
      importedAt: new Date().toISOString(),
    });
  }

  await saveProviderStore(paths, providers);

  return {
    importedProviders: providers.length,
    importedModels: providers.reduce((sum, provider) => sum + provider.models.length, 0),
    warnings,
    providers,
  };
}

function parseAuthConfig(
  auth?: ProviderConfigFile["auth"]
): ProviderAuthConfig | undefined {
  if (!auth || typeof auth !== "object") {
    return undefined;
  }
  const type = typeof auth.type === "string" ? auth.type.trim().toLowerCase() : "";
  if (!type || !["bearer", "query", "header", "none"].includes(type)) {
    return undefined;
  }
  return {
    type: type as ProviderAuthConfig["type"],
    keyParam: typeof auth.keyParam === "string" ? auth.keyParam : undefined,
    headerName: typeof auth.headerName === "string" ? auth.headerName : undefined,
    keyPrefix: typeof auth.keyPrefix === "string" ? auth.keyPrefix : undefined,
  };
}

function parseProtocolConfig(
  config: ProviderConfigFile,
  protocol: ProviderProtocol
): ProviderProtocolConfig | undefined {
  if (protocol !== "inference_v2") {
    return undefined;
  }
  const router =
    typeof config.endpoint?.router === "string"
      ? config.endpoint.router.trim()
      : undefined;
  const responseTextPaths = extractStringArray(
    config.endpoint?.responseTextPaths ?? config.responseTextPaths
  );
  return {
    router: router && router.length > 0 ? router : undefined,
    responseTextPaths: responseTextPaths.length > 0 ? responseTextPaths : undefined,
  };
}

function extractStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter((entry) => entry.length > 0);
}

function resolveApiKey(
  envVar: string | undefined,
  envMap: EnvMap,
  previous: string | undefined,
  overwriteAuth: boolean
): string | undefined {
  if (!envVar) {
    return previous;
  }
  const fromEnvFile = envMap[envVar];
  const fromProcess = process.env[envVar];
  const value = fromEnvFile ?? fromProcess;
  if (!value && !previous) {
    return undefined;
  }
  if (!overwriteAuth && previous) {
    return previous;
  }
  return value ?? previous;
}

async function loadEnvMap(envFilePath?: string): Promise<EnvMap> {
  const loaded: EnvMap = {};
  const candidates = [envFilePath, ".env"].filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    const fullPath = path.resolve(candidate);
    try {
      const raw = await fs.readFile(fullPath, "utf8");
      parseEnvInto(raw, loaded);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }

  return loaded;
}

function parseEnvInto(raw: string, out: EnvMap): void {
  const lines = raw.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const equals = trimmed.indexOf("=");
    if (equals <= 0) {
      continue;
    }
    const key = trimmed.slice(0, equals).trim();
    let value = trimmed.slice(equals + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key) {
      out[key] = value;
    }
  }
}

function normalizeBenchmark(
  benchmark: { livebench?: number } | undefined
): { livebench?: number } | undefined {
  if (!benchmark || typeof benchmark.livebench !== "number" || !Number.isFinite(benchmark.livebench)) {
    return undefined;
  }
  return { livebench: benchmark.livebench };
}

function toCapabilities(
  modalities: string[],
  caps: { tools?: boolean; streaming?: boolean; vision?: boolean }
): ModelCapabilities {
  const input = new Set<ModelModality>();
  const output = new Set<ModelModality>();

  for (const modality of modalities) {
    switch (modality) {
      case "text-to-text":
        input.add("text");
        output.add("text");
        break;
      case "image-to-text":
        input.add("image");
        input.add("text");
        output.add("text");
        break;
      case "text-to-image":
        input.add("text");
        output.add("image");
        break;
      case "audio-to-text":
        input.add("audio");
        output.add("text");
        break;
      case "text-to-audio":
        input.add("text");
        output.add("audio");
        break;
      case "text-to-embedding":
        input.add("text");
        output.add("embedding");
        break;
    }
  }

  if (input.size === 0 || output.size === 0) {
    input.add("text");
    output.add(caps.vision ? "text" : "text");
  }

  if (caps.vision && !input.has("image")) {
    input.add("image");
  }

  return {
    input: Array.from(input),
    output: Array.from(output),
    supportsTools: caps.tools,
    supportsStreaming: caps.streaming,
    source: "configured",
  };
}

function inferEndpointType(
  capabilities: ModelCapabilities
): "llm" | "diffusion" | "audio" | "embedding" {
  if (capabilities.output.includes("embedding")) {
    return "embedding";
  }
  if (capabilities.output.includes("image")) {
    return "diffusion";
  }
  if (capabilities.output.includes("audio")) {
    return "audio";
  }
  return "llm";
}
