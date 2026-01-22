import { Agent, request } from "undici";
import { ModelMapping } from "../types";

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
  if (models.length !== 1) {
    return mappings;
  }
  const sole = models[0];
  return mappings.map((mapping) => {
    if (mapping.upstreamModel === sole || mapping.publicName === sole) {
      return mapping;
    }
    return { ...mapping, upstreamModel: sole };
  });
}

async function fetchModelList(endpoint: EndpointInfo): Promise<string[] | null> {
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
    const body = (await readJson(response.body)) as { data?: Array<{ id?: string }> } | null;
    response.body.resume();
    const list = Array.isArray(body?.data) ? body.data : [];
    return list
      .map((item: { id?: string }) => item.id)
      .filter((id: string | undefined): id is string => Boolean(id));
  } catch {
    return null;
  }
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
