import { Agent, request } from "undici";
import { ModelCapabilities, ModelMapping, ModelModality } from "../types";
import { ProviderAuthConfig } from "../providers/types";

export interface EndpointInfo {
  baseUrl: string;
  apiKey?: string;
  insecureTls: boolean;
  auth?: ProviderAuthConfig;
}

export async function resolveModelMappings(
  endpoint: EndpointInfo,
  mappings: ModelMapping[]
): Promise<ModelMapping[]> {
  let models: UpstreamModelInfo[] | null = null;
  try {
    models = await discoverUpstreamModels(endpoint);
  } catch {
    models = null;
  }
  if (!models || models.length === 0) {
    return mappings;
  }
  
  // If exactly one model, use it as the upstream for all mappings
  // that don't already have an explicit upstream different from the public name
  if (models.length === 1) {
    const sole = models[0];
    console.log(`[model-discovery] Single model found: ${sole.id}`);
    return mappings.map((mapping) => {
      // If user specified explicit upstream (public=upstream format), keep it
      // Otherwise, use the discovered model as upstream
      if (mapping.publicName !== mapping.upstreamModel) {
        // User specified explicit mapping, keep it
        return mapping;
      }
      // Public and upstream are the same (user just gave public name)
      // Replace upstream with discovered model
      console.log(`[model-discovery] Mapping ${mapping.publicName} -> ${sole.id}`);
      return {
        ...mapping,
        upstreamModel: sole.id,
        capabilities: mapping.capabilities ?? sole.capabilities,
      };
    });
  }
  
  // Multiple models - check if any mapping's upstream matches available models
  console.log(
    `[model-discovery] ${models.length} models found: ${models
      .slice(0, 5)
      .map((model) => model.id)
      .join(", ")}${models.length > 5 ? "..." : ""}`
  );
  const byId = new Map(models.map((model) => [model.id, model]));
  return mappings.map((mapping) => {
    if (mapping.capabilities) {
      return mapping;
    }
    const matched = byId.get(mapping.upstreamModel) ?? byId.get(mapping.publicName);
    if (!matched?.capabilities) {
      return mapping;
    }
    return {
      ...mapping,
      capabilities: matched.capabilities,
    };
  });
}

interface UpstreamModelInfo {
  id: string;
  capabilities?: ModelCapabilities;
}

export async function discoverUpstreamModels(endpoint: EndpointInfo): Promise<UpstreamModelInfo[]> {
  const dispatcher = endpoint.insecureTls
    ? new Agent({ connect: { rejectUnauthorized: false } })
    : undefined;
  const { url, headers } = buildDiscoveryRequest(endpoint);
  const response = await request(url, {
    method: "GET",
    headersTimeout: 3000,
    bodyTimeout: 3000,
    dispatcher,
    headers,
  });
  const body = (await readJson(response.body)) as {
    data?: Array<{
      id?: string;
      input_modalities?: string[];
      output_modalities?: string[];
      capabilities?: { input?: string[]; output?: string[]; supportsTools?: boolean; supportsStreaming?: boolean };
    }>;
  } | null;
  response.body.resume();
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(`model discovery failed with status ${response.statusCode}`);
  }
  const list = Array.isArray(body?.data) ? body.data : [];
  const models: UpstreamModelInfo[] = [];
  for (const item of list) {
    if (!item.id) {
      continue;
    }
    const modelInfo: UpstreamModelInfo = { id: item.id };
    const capabilities = extractCapabilities(item);
    if (capabilities) {
      modelInfo.capabilities = capabilities;
    }
    models.push(modelInfo);
  }
  return models;
}

function buildDiscoveryRequest(endpoint: EndpointInfo): { url: string; headers: Record<string, string> } {
  const authType = endpoint.auth?.type ?? "bearer";
  const headers: Record<string, string> = {};
  const url = new URL(buildModelListUrl(endpoint.baseUrl));
  const apiKey = endpoint.apiKey?.trim();

  if (apiKey && authType === "query") {
    const keyParam = endpoint.auth?.keyParam?.trim() || "api_key";
    url.searchParams.set(keyParam, apiKey);
  } else if (apiKey && authType === "header") {
    const headerName = endpoint.auth?.headerName?.trim() || endpoint.auth?.keyParam?.trim() || "x-api-key";
    const prefix = endpoint.auth?.keyPrefix?.trim();
    headers[headerName] = prefix ? `${prefix} ${apiKey}` : apiKey;
  } else if (apiKey && authType !== "none") {
    headers.authorization = `Bearer ${apiKey}`;
  }

  return { url: url.toString(), headers };
}

function buildModelListUrl(baseUrl: string): string {
  const parsed = new URL(baseUrl);
  const pathname = parsed.pathname.replace(/\/+$/, "");
  if (!pathname) {
    parsed.pathname = "/v1/models";
  } else if (pathname.endsWith("/v1")) {
    parsed.pathname = `${pathname}/models`;
  } else {
    parsed.pathname = `${pathname}/v1/models`;
  }
  return parsed.toString();
}

function extractCapabilities(item: {
  input_modalities?: string[];
  output_modalities?: string[];
  capabilities?: { input?: string[]; output?: string[]; supportsTools?: boolean; supportsStreaming?: boolean };
}): ModelCapabilities | undefined {
  const fromCapabilities = item.capabilities;
  if (fromCapabilities?.input && fromCapabilities?.output) {
    const input = normalizeModalities(fromCapabilities.input);
    const output = normalizeModalities(fromCapabilities.output);
    if (input.length > 0 && output.length > 0) {
      return {
        input,
        output,
        supportsTools: fromCapabilities.supportsTools,
        supportsStreaming: fromCapabilities.supportsStreaming,
        source: "inferred",
      };
    }
  }

  const input = normalizeModalities(item.input_modalities ?? []);
  const output = normalizeModalities(item.output_modalities ?? []);
  if (input.length > 0 && output.length > 0) {
    return { input, output, source: "inferred" };
  }

  return undefined;
}

function normalizeModalities(values: string[]): ModelModality[] {
  const normalized = new Set<ModelModality>();
  for (const value of values) {
    const lower = value.toLowerCase();
    if (lower === "text" || lower === "image" || lower === "audio" || lower === "embedding") {
      normalized.add(lower);
    }
  }
  return Array.from(normalized);
}

async function readJson(stream: NodeJS.ReadableStream): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) {
    return null;
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
}
