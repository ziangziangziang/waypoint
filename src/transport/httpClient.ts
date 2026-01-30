import { Agent, request } from "undici";
import { EndpointDoc, UpstreamError, UpstreamResult } from "../types";

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

export async function proxyUpstream(
  endpoint: EndpointDoc,
  path: string,
  payload: unknown,
  headers: Record<string, string | string[] | undefined>,
  timeoutMs: number,
  signal: AbortSignal
): Promise<UpstreamResult> {
  const url = new URL(path, endpoint.baseUrl).toString();
  const dispatcher = endpoint.insecureTls
    ? new Agent({ connect: { rejectUnauthorized: false } })
    : undefined;

  const requestHeaders: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
    ...filterHeaders(headers)
  };
  if (endpoint.apiKey && !requestHeaders.authorization) {
    requestHeaders.authorization = `Bearer ${endpoint.apiKey}`;
  }

  const response = await request(url, {
    method: "POST",
    body: JSON.stringify(payload),
    headers: requestHeaders,
    dispatcher,
    signal,
    headersTimeout: timeoutMs,
    bodyTimeout: timeoutMs
  });

  return {
    statusCode: response.statusCode,
    headers: response.headers as Record<string, string | string[]>,
    body: response.body
  };
}

export function classifyUpstreamError(error: unknown): UpstreamError {
  if (error instanceof Error) {
    const err = error as UpstreamError;
    const code = (err as NodeJS.ErrnoException).code;
    // Connection errors
    if (code === "ECONNREFUSED" || code === "ECONNRESET" || code === "ETIMEDOUT" || code === "ENOTFOUND") {
      err.type = "connection";
      err.retryable = true;
      return err;
    }
    // Undici timeout errors
    if (code === "UND_ERR_HEADERS_TIMEOUT" || code === "UND_ERR_BODY_TIMEOUT" || code === "UND_ERR_CONNECT_TIMEOUT") {
      err.type = "timeout";
      err.retryable = true;
      return err;
    }
    if (err.name === "AbortError") {
      err.type = "timeout";
      err.retryable = true;
      return err;
    }
    // Socket/stream errors during transfer
    if (code === "ERR_STREAM_PREMATURE_CLOSE" || code === "EPIPE" || code === "ECONNABORTED") {
      err.type = "stream_error";
      err.retryable = true;
      return err;
    }
    err.type = "unknown";
    err.retryable = false;
    return err;
  }
  const fallback = new Error("Unknown upstream error") as UpstreamError;
  fallback.type = "unknown";
  fallback.retryable = false;
  return fallback;
}

export function classifyHttpStatus(statusCode: number): { retryable: boolean; type: string } {
  if (RETRYABLE_STATUSES.has(statusCode)) {
    return { retryable: true, type: "upstream_5xx" };
  }
  if ([400, 401, 403].includes(statusCode)) {
    return { retryable: false, type: "upstream_4xx" };
  }
  if (statusCode >= 400) {
    return { retryable: false, type: "upstream_4xx" };
  }
  return { retryable: false, type: "ok" };
}

function filterHeaders(
  headers: Record<string, string | string[] | undefined>
): Record<string, string> {
  const filtered: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!value) {
      continue;
    }
    const lower = key.toLowerCase();
    if (lower === "host" || lower === "content-length") {
      continue;
    }
    filtered[lower] = Array.isArray(value) ? value.join(", ") : value;
  }
  return filtered;
}
