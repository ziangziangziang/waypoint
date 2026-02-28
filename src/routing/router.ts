import { EndpointDoc, EndpointType, ModelModality, UpstreamError, UpstreamResult } from "../types";
import { classifyHttpStatus, classifyUpstreamError, proxyUpstream } from "../transport/httpClient";
import { StoragePaths } from "../storage/files";
import {
  buildEndpointFromCandidate,
  estimateTokensFromPayload,
  markPoolAttempt,
  markPoolFailure,
  markPoolSuccess,
  selectPoolCandidates,
} from "../pools/scheduler";
import { PoolCandidate } from "../pools/types";
import { getProtocolAdapter, routePathToOperation } from "../protocols/registry";
import { PreparedUpstreamRequest, ProtocolAdapter, ProtocolNormalizeResponseContext } from "../protocols/types";
import { resolveModel } from "../providers/modelRegistry";
import { setProviderModelInsecureTls } from "../providers/repository";

export interface RouteAttempt {
  endpoint: EndpointDoc;
  upstreamModel: string;
  response: UpstreamResult;
  pool?: {
    id: string;
    alias: string;
    candidateAttempts: number;
    failovers: number;
    rateLimitSwitches: number;
    distinctProviders: number;
    distinctModels: number;
  };
}

export interface RouteOutcome {
  attempt: RouteAttempt;
  retryable: boolean;
  errorType?: string;
}

interface RouteRequirements {
  endpointType?: EndpointType;
  requiredInput?: ModelModality[];
  requiredOutput?: ModelModality[];
}

export async function routeRequest(
  paths: StoragePaths,
  publicModel: string,
  path: string,
  payload: Record<string, unknown>,
  headers: Record<string, string | string[] | undefined>,
  signal: AbortSignal,
  requirements?: RouteRequirements
): Promise<RouteOutcome> {
  const operation = routePathToOperation(path);
  const streamRequested = payload.stream === true;
  const resolved = await resolveModel(
    paths,
    publicModel,
    {
      requiredInput: requirements?.requiredInput,
      requiredOutput: requirements?.requiredOutput,
    },
    operation ? { operation, stream: streamRequested } : undefined
  );

  if (resolved.kind === "ambiguous") {
    const error = new Error(
      `Model '${resolved.input}' is ambiguous. Use canonical model ID: ${resolved.matches.join(", ")}`
    ) as UpstreamError;
    error.type = "invalid_request";
    error.retryable = false;
    throw error;
  }
  if (resolved.kind === "deprecated_pool_alias") {
    const error = new Error(
      `Model alias '${resolved.input}' is deprecated. Use '${resolved.replacement}' instead.`
    ) as UpstreamError;
    error.type = "invalid_request";
    error.retryable = false;
    throw error;
  }
  if (resolved.kind === "none") {
    const error = new Error(`Unknown model '${resolved.input}'`) as UpstreamError;
    error.type = "no_endpoints";
    error.retryable = false;
    throw error;
  }

  if (resolved.kind === "pool") {
    const poolSelection = await selectPoolCandidates(
      paths,
      resolved.alias,
      {
        requiredInput: requirements?.requiredInput,
        requiredOutput: requirements?.requiredOutput,
      },
      operation ? { operation, stream: streamRequested } : undefined
    );
    if (!poolSelection || poolSelection.candidates.length === 0) {
      const exhaustedByLimits = poolSelection?.skipped.some(
        (item) => item.reason === "cooldown" || item.reason === "request_budget_exhausted"
      );
      const streamUnsupported = poolSelection?.skipped.some(
        (item) => item.reason === "stream_unsupported"
      );
      const error = new Error("No eligible endpoints for model") as UpstreamError;
      error.type = exhaustedByLimits
        ? "rate_limited"
        : streamUnsupported
          ? "protocol_stream_unsupported"
          : "no_endpoints";
      error.retryable = Boolean(exhaustedByLimits);
      throw error;
    }
    return routeWithPoolCandidates(
      paths,
      resolved.alias,
      path,
      payload,
      headers,
      signal,
      poolSelection.pool.id,
      poolSelection.candidates,
      requirements,
      operation,
      streamRequested
    );
  }

  if (resolved.candidates.length === 0) {
    const error = new Error("No eligible endpoints for model") as UpstreamError;
    error.type = "no_endpoints";
    error.retryable = false;
    throw error;
  }
  return routeWithPoolCandidates(
    paths,
    resolved.canonicalId,
    path,
    payload,
    headers,
    signal,
    `model:${resolved.canonicalId}`,
    resolved.candidates,
    requirements,
    operation,
    streamRequested
  );
}

async function routeWithPoolCandidates(
  paths: StoragePaths,
  publicModel: string,
  path: string,
  payload: Record<string, unknown>,
  headers: Record<string, string | string[] | undefined>,
  signal: AbortSignal,
  poolId: string,
  candidates: PoolCandidate[],
  requirements: RouteRequirements | undefined,
  operation: ReturnType<typeof routePathToOperation>,
  streamRequested: boolean
): Promise<RouteOutcome> {
  if (candidates.length === 0) {
    const error = new Error("No eligible endpoints for model") as UpstreamError;
    error.type = "no_endpoints";
    error.retryable = false;
    throw error;
  }

  let lastError: UpstreamError | null = null;
  let attempts = 0;
  let rateLimitSwitches = 0;
  const seenProviders = new Set<string>();
  const seenModels = new Set<string>();
  const triedModels: string[] = [];
  const triedModelSet = new Set<string>();
  const isSmartAlias = publicModel === "smart";

  for (const candidate of candidates) {
    attempts += 1;
    seenProviders.add(candidate.providerId);
    seenModels.add(candidate.modelId);
    const candidateName = `${candidate.providerId}/${candidate.modelId}`;
    if (!triedModelSet.has(candidateName)) {
      triedModelSet.add(candidateName);
      triedModels.push(candidateName);
    }
    const endpoint = buildEndpointFromCandidate(candidate);
    const adapter = getProtocolAdapter(candidate.protocol);
    if (!adapter) {
      continue;
    }
    const support = adapter.supports({
      operation: operation ?? "chat_completions",
      stream: streamRequested,
      capabilities: candidate.capabilities,
      requiredInput: requirements?.requiredInput,
      requiredOutput: requirements?.requiredOutput,
    });
    if (!support.supported) {
      continue;
    }

    const timeoutMs = candidate.limits?.timeoutMs ?? 60_000;
    const start = Date.now();
    await markPoolAttempt(paths, candidate, estimateTokensFromPayload(payload));
    let requestData: PreparedUpstreamRequest | null = null;

    try {
      requestData = await adapter.buildRequest({
        paths,
        operation: operation ?? "chat_completions",
        stream: streamRequested,
        path,
        payload: { ...payload, model: candidate.upstreamModel },
        publicModel,
        upstreamModel: candidate.upstreamModel,
        endpoint,
        auth: candidate.auth,
        config: candidate.protocolConfig,
      });

      const response = await proxyUpstream(
        endpoint,
        requestData.path,
        requestData.payload,
        mergeForwardHeaders(headers, requestData.headers),
        timeoutMs,
        signal,
        { skipDefaultAuth: requestData.skipDefaultAuth }
      );
      const latency = Date.now() - start;
      const classification = classifyHttpStatus(response.statusCode);
      if (isSmartAlias && shouldFailoverForIncompatibleStatus(response.statusCode)) {
        await markPoolFailure(paths, candidate, {
          error: `operation_unsupported_${response.statusCode}`,
          headers: response.headers,
        });
        await drainBody(response.body);
        lastError = new Error(`Incompatible status ${response.statusCode}`) as UpstreamError;
        lastError.type = classification.type;
        lastError.retryable = true;
        continue;
      }
      if (classification.retryable) {
        if (response.statusCode === 429) {
          rateLimitSwitches += 1;
        }
        await markPoolFailure(paths, candidate, {
          error: classification.type,
          rateLimited: response.statusCode === 429,
          headers: response.headers,
        });
        await drainBody(response.body);
        lastError = new Error(`Retryable status ${response.statusCode}`) as UpstreamError;
        lastError.type = classification.type;
        lastError.retryable = true;
        continue;
      }

      const normalizedResponse = await maybeNormalizeResponse(
        adapter,
        {
          operation: operation ?? "chat_completions",
          stream: streamRequested,
          path,
          publicModel,
          upstreamModel: candidate.upstreamModel,
          requestPayload: requestData.payload,
          upstreamResult: response,
          config: candidate.protocolConfig,
        },
        response
      );

      await markPoolSuccess(paths, candidate, latency);
      return {
        attempt: {
          endpoint,
          upstreamModel: candidate.upstreamModel,
          response: normalizedResponse,
          pool: {
            id: poolId,
            alias: publicModel,
            candidateAttempts: attempts,
            failovers: Math.max(0, attempts - 1),
            rateLimitSwitches,
            distinctProviders: seenProviders.size,
            distinctModels: seenModels.size,
          },
        },
        retryable: false,
      };
    } catch (error) {
      let classified = classifyUpstreamError(error);

      if (
        classified.type === "tls_verify_failed" &&
        endpoint.insecureTls !== true &&
        requestData &&
        isHostnameAllowlisted(candidate)
      ) {
        const insecureEndpoint = { ...endpoint, insecureTls: true };
        await markPoolAttempt(paths, candidate, estimateTokensFromPayload(payload));
        try {
          const retryResponse = await proxyUpstream(
            insecureEndpoint,
            requestData.path,
            requestData.payload,
            mergeForwardHeaders(headers, requestData.headers),
            timeoutMs,
            signal,
            { skipDefaultAuth: requestData.skipDefaultAuth }
          );
          const latency = Date.now() - start;
          const retryClassification = classifyHttpStatus(retryResponse.statusCode);
          if (isSmartAlias && shouldFailoverForIncompatibleStatus(retryResponse.statusCode)) {
            await markPoolFailure(paths, candidate, {
              error: `operation_unsupported_${retryResponse.statusCode}`,
              headers: retryResponse.headers,
            });
            await drainBody(retryResponse.body);
            lastError = new Error(`Incompatible status ${retryResponse.statusCode}`) as UpstreamError;
            lastError.type = retryClassification.type;
            lastError.retryable = true;
            continue;
          }
          if (retryClassification.retryable) {
            if (retryResponse.statusCode === 429) {
              rateLimitSwitches += 1;
            }
            await markPoolFailure(paths, candidate, {
              error: retryClassification.type,
              rateLimited: retryResponse.statusCode === 429,
              headers: retryResponse.headers,
            });
            await drainBody(retryResponse.body);
            lastError = new Error(`Retryable status ${retryResponse.statusCode}`) as UpstreamError;
            lastError.type = retryClassification.type;
            lastError.retryable = true;
            continue;
          }

          const normalizedRetryResponse = await maybeNormalizeResponse(
            adapter,
            {
              operation: operation ?? "chat_completions",
              stream: streamRequested,
              path,
              publicModel,
              upstreamModel: candidate.upstreamModel,
              requestPayload: requestData.payload,
              upstreamResult: retryResponse,
              config: candidate.protocolConfig,
            },
            retryResponse
          );

          if (retryClassification.type === "ok") {
            await setProviderModelInsecureTls(
              paths,
              candidate.providerId,
              candidate.providerModelId ?? candidate.modelId,
              true
            );
          }

          await markPoolSuccess(paths, candidate, latency);
          return {
            attempt: {
              endpoint: insecureEndpoint,
              upstreamModel: candidate.upstreamModel,
              response: normalizedRetryResponse,
              pool: {
                id: poolId,
                alias: publicModel,
                candidateAttempts: attempts,
                failovers: Math.max(0, attempts - 1),
                rateLimitSwitches,
                distinctProviders: seenProviders.size,
                distinctModels: seenModels.size,
              },
            },
            retryable: false,
          };
        } catch (retryError) {
          classified = classifyUpstreamError(retryError);
        }
      }

      if (classified.type === "tls_verify_failed") {
        classified.message = tlsVerifyFailureMessage(candidate);
      }
      lastError = classified;
      await markPoolFailure(paths, candidate, {
        error: classified.type,
        rateLimited: classified.type === "rate_limited",
      });
      if (!classified.retryable) {
        throw maybeEnrichSmartError(classified, triedModels, poolId, isSmartAlias);
      }
    }
  }

  if (lastError) {
    throw maybeEnrichSmartError(lastError, triedModels, poolId, isSmartAlias);
  }
  const error = new Error("No endpoints succeeded") as UpstreamError;
  error.type = "no_endpoints";
  error.retryable = true;
  throw maybeEnrichSmartError(error, triedModels, poolId, isSmartAlias);
}

function shouldFailoverForIncompatibleStatus(statusCode: number): boolean {
  return statusCode === 404 || statusCode === 405 || statusCode === 501;
}

function maybeEnrichSmartError(
  error: UpstreamError,
  triedModels: string[],
  poolId: string,
  shouldEnrich: boolean
): UpstreamError {
  if (!shouldEnrich) {
    return error;
  }
  error.poolId = poolId;
  error.triedModels = triedModels.slice(0, 10);
  if (error.triedModels.length > 0) {
    error.message = `Smart routing failed. Tried models: ${error.triedModels.join(", ")}. Cause: ${error.message}`;
  } else {
    error.message = `Smart routing failed. No eligible models. Cause: ${error.message}`;
  }
  return error;
}

function isHostnameAllowlisted(candidate: PoolCandidate): boolean {
  const allowlist = candidate.autoInsecureTlsDomains ?? [];
  if (allowlist.length === 0) {
    return false;
  }
  const hostname = getHostname(candidate.baseUrl);
  if (!hostname) {
    return false;
  }
  return allowlist.some((suffix) => matchesDomainSuffix(hostname, suffix));
}

function getHostname(baseUrl: string): string | null {
  try {
    return new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function matchesDomainSuffix(hostname: string, suffix: string): boolean {
  const normalizedSuffix = suffix.trim().toLowerCase();
  if (!normalizedSuffix) {
    return false;
  }
  return hostname === normalizedSuffix || hostname.endsWith(`.${normalizedSuffix}`);
}

function tlsVerifyFailureMessage(candidate: PoolCandidate): string {
  return `Upstream TLS verify failed for ${candidate.providerId}/${candidate.modelId}. Configure provider/model insecureTls or provider allowlist.`;
}

async function maybeNormalizeResponse(
  adapter: ProtocolAdapter,
  context: ProtocolNormalizeResponseContext,
  fallback: UpstreamResult
): Promise<UpstreamResult> {
  if (!adapter.normalizeResponse) {
    return fallback;
  }
  return adapter.normalizeResponse(context);
}

async function drainBody(stream: NodeJS.ReadableStream): Promise<void> {
  return new Promise((resolve) => {
    stream.on("end", resolve);
    stream.on("close", resolve);
    stream.on("error", resolve);
    stream.resume();
  });
}

function mergeForwardHeaders(
  base: Record<string, string | string[] | undefined>,
  extras?: Record<string, string>
): Record<string, string | string[] | undefined> {
  if (!extras || Object.keys(extras).length === 0) {
    return base;
  }
  return {
    ...base,
    ...extras,
  };
}
