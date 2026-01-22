export type HealthStatus = "up" | "down";
export type EndpointType = "llm" | "diffusion";

export interface ModelMapping {
  publicName: string;
  upstreamModel: string;
}

export interface EndpointHealth {
  status: HealthStatus;
  lastCheckedAt?: Date;
  lastSuccessAt?: Date;
  lastFailureAt?: Date;
  consecutiveFailures: number;
  downUntil?: Date;
  latencyMsEwma?: number;
}

export interface EndpointLimits {
  timeoutMs?: number;
  maxConcurrent?: number;
}

export interface EndpointDoc {
  id: string;
  name: string;
  baseUrl: string;
  apiKey?: string;
  insecureTls: boolean;
  priority: number;
  weight?: number;
  type: EndpointType;
  models: ModelMapping[];
  health: EndpointHealth;
  limits?: EndpointLimits;
  createdAt: Date;
  updatedAt: Date;
}

export interface RequestLog {
  requestId: string;
  ts: Date;
  route: {
    publicModel: string;
    endpointId?: string;
    endpointName?: string;
    upstreamModel?: string;
  };
  request: {
    stream: boolean;
    maxTokens?: number;
  };
  result: {
    statusCode?: number;
    latencyMs?: number;
    errorType?: string;
    errorMessage?: string;
    totalTokens?: number | null;
  };
}

export interface UpstreamResult {
  statusCode: number;
  headers: Record<string, string | string[]>;
  body: NodeJS.ReadableStream;
  rawBody?: Buffer;
}

export interface UpstreamError extends Error {
  type: string;
  statusCode?: number;
  retryable: boolean;
}
