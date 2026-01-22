import { EndpointDoc, UpstreamError, UpstreamResult } from "../types";
import {
  getEligibleEndpointsForModel,
  sortEndpointsForRouting,
  updateHealthFailure,
  updateHealthSuccess,
  markEndpointDown
} from "../storage/repositories";
import { classifyHttpStatus, classifyUpstreamError, proxyUpstream } from "../transport/httpClient";
import { StoragePaths } from "../storage/files";

export interface RouteAttempt {
  endpoint: EndpointDoc;
  upstreamModel: string;
  response: UpstreamResult;
}

export interface RouteOutcome {
  attempt: RouteAttempt;
  retryable: boolean;
  errorType?: string;
}

export async function routeRequest(
  paths: StoragePaths,
  publicModel: string,
  path: string,
  payload: Record<string, unknown>,
  headers: Record<string, string | string[] | undefined>,
  signal: AbortSignal
): Promise<RouteOutcome> {
  const candidates = await getEligibleEndpointsForModel(paths, publicModel);
  if (candidates.length === 0) {
    const error = new Error("No eligible endpoints for model") as UpstreamError;
    error.type = "no_endpoints";
    error.retryable = false;
    throw error;
  }

  const sorted = sortEndpointsForRouting(candidates);
  let lastError: UpstreamError | null = null;

  for (const endpoint of sorted) {
    const mapping = endpoint.models.find((model) => model.publicName === publicModel);
    if (!mapping) {
      continue;
    }
    const upstreamPayload = { ...payload, model: mapping.upstreamModel };
    const timeoutMs = endpoint.limits?.timeoutMs ?? 60000;
    const start = Date.now();
    try {
      const response = await proxyUpstream(
        endpoint,
        path,
        upstreamPayload,
        headers,
        timeoutMs,
        signal
      );
      const latency = Date.now() - start;
      const classification = classifyHttpStatus(response.statusCode);
      if (classification.retryable) {
        await recordFailure(paths, endpoint);
        await drainBody(response.body);
        lastError = new Error(`Retryable status ${response.statusCode}`) as UpstreamError;
        lastError.type = classification.type;
        lastError.retryable = true;
        continue;
      }
      await updateHealthSuccess(paths, endpoint.id, latency);
      return {
        attempt: {
          endpoint,
          upstreamModel: mapping.upstreamModel,
          response
        },
        retryable: false
      };
    } catch (error) {
      const classified = classifyUpstreamError(error);
      lastError = classified;
      await recordFailure(paths, endpoint);
      if (!classified.retryable) {
        throw classified;
      }
    }
  }

  if (lastError) {
    throw lastError;
  }
  const error = new Error("No endpoints succeeded") as UpstreamError;
  error.type = "no_endpoints";
  error.retryable = true;
  throw error;
}

async function recordFailure(paths: StoragePaths, endpoint: EndpointDoc): Promise<void> {
  const result = await updateHealthFailure(paths, endpoint.id);
  if (result && result.consecutiveFailures >= 3) {
    const downUntil = new Date(Date.now() + 5 * 60 * 1000);
    await markEndpointDown(paths, endpoint.id, downUntil);
  }
}

async function drainBody(stream: NodeJS.ReadableStream): Promise<void> {
  return new Promise((resolve) => {
    stream.on("end", resolve);
    stream.on("close", resolve);
    stream.on("error", resolve);
    stream.resume();
  });
}
