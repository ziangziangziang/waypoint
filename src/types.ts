export type HealthStatus = "up" | "down";
export type EndpointType = "llm" | "diffusion" | "audio" | "embedding";

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

// ========================================
// Image Generation Types
// ========================================

export interface ImageGenerationRequest {
  model?: string;
  prompt: string;
  n?: number;
  size?: string;
  quality?: string;
  style?: string;
  response_format?: "url" | "b64_json";
  user?: string;
}

export interface ImageObject {
  url?: string;
  b64_json?: string;
  revised_prompt?: string;
}

export interface ImageGenerationResponse {
  created: number;
  data: ImageObject[];
}

// ========================================
// Audio Types
// ========================================

export interface AudioTranscriptionRequest {
  file: Buffer;
  model: string;
  language?: string;
  prompt?: string;
  response_format?: "json" | "text" | "srt" | "verbose_json" | "vtt";
  temperature?: number;
  timestamp_granularities?: Array<"word" | "segment">;
}

export interface AudioTranscriptionResponse {
  text: string;
  task?: string;
  language?: string;
  duration?: number;
  words?: Array<{ word: string; start: number; end: number }>;
  segments?: Array<{
    id: number;
    seek: number;
    start: number;
    end: number;
    text: string;
    tokens: number[];
    temperature: number;
    avg_logprob: number;
    compression_ratio: number;
    no_speech_prob: number;
  }>;
}

export interface AudioSpeechRequest {
  model: string;
  input: string;
  voice: string;
  response_format?: "mp3" | "opus" | "aac" | "flac" | "wav" | "pcm";
  speed?: number;
}

// ========================================
// Responses API Types (Shim)
// ========================================

export interface ResponsesApiRequest {
  model: string;
  input: string | Array<{ role: string; content: string }>;
  instructions?: string;
  tools?: unknown[];
  tool_choice?: unknown;
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
  [key: string]: unknown;
}

// ========================================
// Statistics Types
// ========================================

export interface RequestStats {
  requestId: string;
  timestamp: Date;
  route: string;
  method: string;
  publicModel?: string;
  endpointId?: string;
  endpointName?: string;
  upstreamModel?: string;
  requestBytes: number;
  responseBytes: number;
  latencyMs: number;
  statusCode: number;
  errorType?: string;
  totalTokens?: number | null;
  promptTokens?: number | null;
  completionTokens?: number | null;
}

export interface StatsAggregation {
  window: string;
  total: number;
  success: number;
  errors: number;
  avgLatencyMs: number | null;
  p50LatencyMs: number | null;
  p95LatencyMs: number | null;
  p99LatencyMs: number | null;
  totalTokens: number;
  tokensPerHour: number | null;
  byModel: Record<string, { count: number; avgLatencyMs: number; tokens: number }>;
  byEndpoint: Record<string, { count: number; avgLatencyMs: number; tokens: number; errors: number }>;
}

// ========================================
// Session Types (for Playground)
// ========================================

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string | null;
  name?: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
  images?: string[]; // Local file paths for AIGC outputs or VL inputs
  createdAt: Date;
}

export interface ChatSession {
  id: string;
  name: string;
  model?: string;
  messages: ChatMessage[];
  createdAt: Date;
  updatedAt: Date;
}

// ========================================
// MCP Types
// ========================================

export interface McpServer {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  status: "connected" | "disconnected" | "error" | "unknown";
  toolCount?: number;
  lastConnectedAt?: Date;
  lastError?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface McpTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}
