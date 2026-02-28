import { EndpointType, ModelCapabilities, ModelModality } from "../types";

export type ProviderProtocol = "openai" | "inference_v2" | "unknown";

export type ProviderAuthType = "bearer" | "query" | "header" | "none";

export interface ProviderAuthConfig {
  type: ProviderAuthType;
  keyParam?: string;
  headerName?: string;
  keyPrefix?: string;
}

export interface ProviderProtocolConfig {
  router?: string;
  responseTextPaths?: string[];
  [key: string]: unknown;
}

export interface ProviderLimits {
  requests?: {
    perMinute?: number;
    perDay?: number;
    perMonth?: number;
  };
  tokens?: {
    perMinute?: number;
    perDay?: number;
    perMonth?: number;
  };
  concurrent?: number;
}

export interface ProviderModelRecord {
  providerModelId: string;
  providerId: string;
  modelId: string;
  upstreamModel: string;
  baseUrl?: string;
  apiKey?: string;
  insecureTls?: boolean;
  enabled?: boolean;
  aliases?: string[];
  free: boolean;
  modalities: string[];
  capabilities: ModelCapabilities;
  endpointType: EndpointType;
  benchmark?: {
    livebench?: number;
  };
  limits?: ProviderLimits;
}

export interface ProviderRecord {
  id: string;
  name: string;
  description?: string;
  docs?: string;
  protocol: ProviderProtocol;
  protocolRaw?: string;
  protocolConfig?: ProviderProtocolConfig;
  baseUrl: string;
  insecureTls?: boolean;
  autoInsecureTlsDomains?: string[];
  enabled: boolean;
  supportsRouting: boolean;
  auth?: ProviderAuthConfig;
  envVar?: string;
  apiKey?: string;
  limits?: ProviderLimits;
  models: ProviderModelRecord[];
  warnings?: string[];
  importedAt: string;
}

export interface ProviderStoreFile {
  version: number;
  updatedAt: string;
  providers: ProviderRecord[];
}

export interface ProviderRegistryEntry {
  id: string;
  name?: string;
  file: string;
  protocol?: string;
}

export interface ProviderImportOptions {
  registryPath: string;
  envFilePath?: string;
  overwriteAuth?: boolean;
}

export interface ProviderImportResult {
  importedProviders: number;
  importedModels: number;
  warnings: string[];
  providers: ProviderRecord[];
}

export interface EnvMap {
  [key: string]: string;
}

export interface ProviderCapabilityRequirements {
  requiredInput: ModelModality[];
  requiredOutput: ModelModality[];
}
