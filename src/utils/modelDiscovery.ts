import { Agent, request } from "undici";
import { ModelCapabilities, ModelMapping, ModelModality } from "../types";

export interface EndpointInfo {
  baseUrl: string;
  apiKey?: string;
  insecureTls: boolean;
}

export async function resolveModelMappings(
  endpoint: EndpointInfo,
  mappings: ModelMapping[]
): Promise<ModelMapping[]> {
  const models = await fetchModelList(endpoint);
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

async function fetchModelList(endpoint: EndpointInfo): Promise<UpstreamModelInfo[] | null> {
  const dispatcher = endpoint.insecureTls
    ? new Agent({ connect: { rejectUnauthorized: false } })
    : undefined;
  const headers: Record<string, string> = {};
  if (endpoint.apiKey) {
    headers.authorization = `Bearer ${endpoint.apiKey}`;
  }
  try {
    const response = await request(new URL("/v1/models", endpoint.baseUrl).toString(), {
      method: "GET",
      headersTimeout: 3000,
      bodyTimeout: 3000,
      dispatcher,
      headers
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
  } catch {
    return null;
  }
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
