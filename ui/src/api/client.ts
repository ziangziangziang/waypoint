/**
 * Waypoint API Client
 * 
 * Centralized API layer for communicating with the Waypoint proxy server.
 */

const API_BASE = '';

export class ApiError extends Error {
  constructor(
    public status: number,
    public statusText: string,
    public body?: unknown
  ) {
    super(`API Error: ${status} ${statusText}`);
    this.name = 'ApiError';
  }
}

async function handleResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = await response.text();
    }
    throw new ApiError(response.status, response.statusText, body);
  }
  return response.json();
}

export interface AdminMeta {
  name: string;
  version: string;
  now: string;
}

export async function getAdminMeta(): Promise<AdminMeta> {
  const response = await fetch(`${API_BASE}/admin/meta`);
  return handleResponse<AdminMeta>(response);
}

// ========================================
// Providers API
// ========================================

export interface ProviderModel {
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

export interface DiscoveredProviderModel {
  id: string;
  capabilities?: ModelCapabilities;
}

export interface ProviderModelDiscoveryResponse {
  baseUrl: string;
  models: DiscoveredProviderModel[];
}

export interface ProviderAuthConfig {
  type: 'bearer' | 'query' | 'header' | 'none';
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

export interface Provider {
  id: string;
  name: string;
  description?: string;
  docs?: string;
  protocol: string;
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
  models: ProviderModel[];
  warnings?: string[];
  importedAt?: string;
}

export async function listProviders(): Promise<Provider[]> {
  const response = await fetch(`${API_BASE}/admin/providers`);
  return handleResponse<Provider[]>(response);
}

export async function addProvider(payload: Partial<Provider>): Promise<Provider> {
  const response = await fetch(`${API_BASE}/admin/providers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return handleResponse<Provider>(response);
}

export async function updateProvider(providerId: string, payload: Partial<Provider>): Promise<Provider> {
  const response = await fetch(`${API_BASE}/admin/providers/${encodeURIComponent(providerId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return handleResponse<Provider>(response);
}

export async function deleteProvider(providerId: string): Promise<{ deleted: string }> {
  const response = await fetch(`${API_BASE}/admin/providers/${encodeURIComponent(providerId)}`, {
    method: 'DELETE',
  });
  return handleResponse<{ deleted: string }>(response);
}

export async function enableProvider(providerId: string): Promise<Provider> {
  const response = await fetch(`${API_BASE}/admin/providers/${encodeURIComponent(providerId)}/enable`, {
    method: 'POST',
  });
  return handleResponse<Provider>(response);
}

export async function disableProvider(providerId: string): Promise<Provider> {
  const response = await fetch(`${API_BASE}/admin/providers/${encodeURIComponent(providerId)}/disable`, {
    method: 'POST',
  });
  return handleResponse<Provider>(response);
}

export async function listProviderModels(providerId: string): Promise<ProviderModel[]> {
  const response = await fetch(`${API_BASE}/admin/providers/${encodeURIComponent(providerId)}/models`);
  return handleResponse<ProviderModel[]>(response);
}

export async function addProviderModel(
  providerId: string,
  payload: Partial<ProviderModel>
): Promise<ProviderModel> {
  const response = await fetch(`${API_BASE}/admin/providers/${encodeURIComponent(providerId)}/models`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return handleResponse<ProviderModel>(response);
}

export async function updateProviderModel(
  providerId: string,
  modelRef: string,
  payload: Partial<ProviderModel>
): Promise<ProviderModel> {
  const response = await fetch(
    `${API_BASE}/admin/providers/${encodeURIComponent(providerId)}/models/${encodeURIComponent(modelRef)}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }
  );
  return handleResponse<ProviderModel>(response);
}

export async function deleteProviderModel(providerId: string, modelRef: string): Promise<{ deleted: string }> {
  const response = await fetch(
    `${API_BASE}/admin/providers/${encodeURIComponent(providerId)}/models/${encodeURIComponent(modelRef)}`,
    { method: 'DELETE' }
  );
  return handleResponse<{ deleted: string }>(response);
}

export async function enableProviderModel(providerId: string, modelRef: string): Promise<ProviderModel> {
  const response = await fetch(
    `${API_BASE}/admin/providers/${encodeURIComponent(providerId)}/models/${encodeURIComponent(modelRef)}/enable`,
    { method: 'POST' }
  );
  return handleResponse<ProviderModel>(response);
}

export async function disableProviderModel(providerId: string, modelRef: string): Promise<ProviderModel> {
  const response = await fetch(
    `${API_BASE}/admin/providers/${encodeURIComponent(providerId)}/models/${encodeURIComponent(modelRef)}/disable`,
    { method: 'POST' }
  );
  return handleResponse<ProviderModel>(response);
}

export async function discoverProviderModels(
  providerId: string,
  payload?: { baseUrl?: string; apiKey?: string; insecureTls?: boolean }
): Promise<ProviderModelDiscoveryResponse> {
  const response = await fetch(
    `${API_BASE}/admin/providers/${encodeURIComponent(providerId)}/models/discover`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload ?? {}),
    }
  );
  return handleResponse<ProviderModelDiscoveryResponse>(response);
}

// ========================================
// Models API
// ========================================

export type EndpointType = 'llm' | 'diffusion' | 'audio' | 'embedding';
export type ModelModality = 'text' | 'image' | 'audio' | 'embedding';

export interface ModelCapabilities {
  input: ModelModality[];
  output: ModelModality[];
  supportsTools?: boolean;
  supportsStreaming?: boolean;
  source?: 'configured' | 'inferred';
}

export interface Model {
  id: string;
  object: 'model';
  created?: number;
  owned_by?: string;
  endpoint_type?: EndpointType;
  capabilities?: ModelCapabilities;
  waypoint_health?: {
    status: 'up' | 'down' | 'unknown';
    lastCheckedAt?: string;
    consecutiveFailures?: number;
    latencyMsEwma?: number;
  };
  waypoint_pool?: {
    id: string;
    strategy: string;
    candidateCount: number;
    scoreSource: string;
  };
}

export interface ModelsResponse {
  object: 'list';
  data: Model[];
}

export async function listModels(options?: { availableOnly?: boolean }): Promise<ModelsResponse> {
  const params = new URLSearchParams();
  if (options?.availableOnly) {
    params.set('available_only', 'true');
  }
  const qs = params.toString();
  const response = await fetch(`${API_BASE}/v1/models${qs ? `?${qs}` : ''}`);
  return handleResponse<ModelsResponse>(response);
}

// ========================================
// Stats API
// ========================================

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

export async function getStats(window: string = '24h'): Promise<StatsAggregation> {
  const response = await fetch(`${API_BASE}/admin/stats?window=${window}`);
  return handleResponse<StatsAggregation>(response);
}

export interface LatencyDistribution {
  window: string;
  count: number;
  min: number | null;
  max: number | null;
  avg: number | null;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  histogram: Record<string, number>;
}

export async function getLatencyDistribution(window: string = '7d'): Promise<LatencyDistribution> {
  const response = await fetch(`${API_BASE}/admin/stats/latency?window=${window}`);
  return handleResponse<LatencyDistribution>(response);
}

export interface TokenUsage {
  window: string;
  totalTokens: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalRequests: number;
  avgTokensPerRequest: number;
  tokenEstimatedCount?: number;
  tokenEstimatedRate?: number;
  splitUnknownCount?: number;
  splitUnknownRate?: number;
  bucketGranularity?: 'hour' | 'day';
  bucketTimeZone?: string;
  byDay: Array<{
    date: string;
    count: number;
    tokens: number;
    estimated: number;
    inputTokens: number;
    outputTokens: number;
    splitUnknown: number;
  }>;
}

export async function getTokenUsage(window: string = '7d', options?: { timeZone?: string }): Promise<TokenUsage> {
  const params = new URLSearchParams({ window });
  if (options?.timeZone) params.set('timeZone', options.timeZone);
  const response = await fetch(`${API_BASE}/admin/stats/tokens?${params.toString()}`);
  return handleResponse<TokenUsage>(response);
}

// ========================================
// Chat Completions API (for Playground)
// ========================================

// Content can be a string or array of content parts (multimodal)
export type ContentPart = 
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }
  | { type: 'input_audio'; input_audio: { url?: string; data?: string; format?: string } }
  | { type: 'audio'; audio: { url?: string; data?: string; format?: string } }

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string | ContentPart[] | null;
  name?: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  tools?: unknown[];
  tool_choice?: unknown;
}

export interface ChatCompletionChoice {
  index: number;
  message: ChatMessage;
  finish_reason: string | null;
}

export interface ChatCompletionResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: ChatCompletionChoice[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface ChatCompletionRawResponse {
  id?: string;
  object?: string;
  created?: number;
  model?: string;
  choices?: Array<{
    index?: number;
    finish_reason?: string | null;
    message?: {
      role?: string;
      content?: string | ContentPart[] | null;
      audio?: { url?: string; data?: string; format?: string };
      [key: string]: unknown;
    };
    [key: string]: unknown;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  [key: string]: unknown;
}

export async function createChatCompletion(
  request: ChatCompletionRequest
): Promise<ChatCompletionResponse> {
  const response = await fetch(`${API_BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...request, stream: false }),
  });
  return handleResponse<ChatCompletionResponse>(response);
}

export async function createChatCompletionRaw(
  request: ChatCompletionRequest
): Promise<ChatCompletionRawResponse> {
  const response = await fetch(`${API_BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...request, stream: false }),
  });
  return handleResponse<ChatCompletionRawResponse>(response);
}

export interface StreamChunk {
  content: string;
  reasoning?: string;
}

/**
 * Stream chat completion using Server-Sent Events
 * Yields chunks containing both content and optional reasoning content
 */
export async function* streamChatCompletion(
  request: ChatCompletionRequest,
  signal?: AbortSignal
): AsyncGenerator<StreamChunk, void, unknown> {
  const response = await fetch(`${API_BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...request, stream: true }),
    signal,
  });

  if (!response.ok) {
    throw new ApiError(response.status, response.statusText);
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error('No response body');

  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (line.startsWith('data: ')) {
        const data = line.slice(6);
        if (data === '[DONE]') return;

        try {
          const parsed = JSON.parse(data);
          const delta = parsed.choices?.[0]?.delta;
          const content = delta?.content;
          // Support both reasoning_content (DeepSeek) and reasoning (other providers)
          const reasoning = delta?.reasoning_content || delta?.reasoning;

          if (content || reasoning) {
            yield {
              content: content || '',
              reasoning: reasoning || undefined,
            };
          }
        } catch {
          // Skip malformed JSON
        }
      }
    }
  }
}

// ========================================
// Image Generation API
// ========================================

export interface ImageGenerationRequest {
  model?: string;
  prompt: string;
  image_url?: string;
  n?: number;
  size?: string;
  quality?: string;
  style?: string;
  response_format?: 'url' | 'b64_json';
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

export async function generateImage(
  request: ImageGenerationRequest
): Promise<ImageGenerationResponse> {
  const response = await fetch(`${API_BASE}/v1/images/generations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });
  return handleResponse<ImageGenerationResponse>(response);
}

// ========================================
// Sessions API (Playground)
// ========================================

export interface ChatSessionMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string | ContentPart[] | null;
  images?: string[];
  toolCalls?: Array<{
    id: string;
    name: string;
    arguments: string;
    result?: string;
  }>;
  // New API uses createdAt; timestamp is preserved for legacy payloads.
  timestamp?: string;
  createdAt?: string;
}

export interface ChatSession {
  id: string;
  name: string;
  model?: string;
  titleStatus?: 'pending' | 'generated' | 'manual' | 'failed';
  titleUpdatedAt?: string;
  storageVersion?: number;
  messages: ChatSessionMessage[];
  createdAt: string;
  updatedAt: string;
}

export interface SessionListItem {
  id: string;
  name: string;
  model?: string;
  titleStatus?: 'pending' | 'generated' | 'manual' | 'failed';
  titleUpdatedAt?: string;
  storageVersion?: number;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface SessionsListResponse {
  object: 'list';
  data: SessionListItem[];
}

export async function listSessions(): Promise<SessionsListResponse> {
  const response = await fetch(`${API_BASE}/admin/sessions`);
  return handleResponse<SessionsListResponse>(response);
}

export async function getSession(sessionId: string): Promise<ChatSession> {
  const response = await fetch(`${API_BASE}/admin/sessions/${sessionId}`);
  const session = await handleResponse<ChatSession>(response);
  return {
    ...session,
    messages: session.messages.map(normalizeSessionMessageMedia),
  };
}

export async function createSession(name?: string, model?: string): Promise<ChatSession> {
  const response = await fetch(`${API_BASE}/admin/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, model }),
  });
  return handleResponse<ChatSession>(response);
}

export async function updateSession(
  sessionId: string, 
  updates: { name?: string; model?: string }
): Promise<ChatSession> {
  const response = await fetch(`${API_BASE}/admin/sessions/${sessionId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updates),
  });
  return handleResponse<ChatSession>(response);
}

export async function autoTitleSession(
  sessionId: string,
  payload: { model?: string; seedText?: string }
): Promise<{
  id: string;
  name: string;
  titleStatus?: 'pending' | 'generated' | 'manual' | 'failed';
  titleUpdatedAt?: string;
  generated: boolean;
  model?: string;
}> {
  const response = await fetch(`${API_BASE}/admin/sessions/${sessionId}/auto-title`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return handleResponse<{
    id: string;
    name: string;
    titleStatus?: 'pending' | 'generated' | 'manual' | 'failed';
    titleUpdatedAt?: string;
    generated: boolean;
    model?: string;
  }>(response);
}

export async function deleteSession(sessionId: string): Promise<void> {
  const response = await fetch(`${API_BASE}/admin/sessions/${sessionId}`, {
    method: 'DELETE',
  });
  if (!response.ok) {
    throw new ApiError(response.status, response.statusText);
  }
}

export async function addMessageToSession(
  sessionId: string,
  message: ChatSessionMessage
): Promise<{ messageId?: string; createdAt?: string }> {
  const response = await fetch(`${API_BASE}/admin/sessions/${sessionId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(message),
  });
  return handleResponse<{ messageId?: string; createdAt?: string }>(response);
}

export async function appendMessageContent(
  sessionId: string,
  messageIndex: number,
  content: string
): Promise<void> {
  const response = await fetch(`${API_BASE}/admin/sessions/${sessionId}/messages/${messageIndex}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  });
  if (!response.ok) {
    throw new ApiError(response.status, response.statusText);
  }
}

// ========================================
// Image Cache API
// ========================================

export interface ImageCacheStats {
  count: number;
  totalSizeBytes: number;
  oldestEntry?: string;
  newestEntry?: string;
}

export type MediaCacheStats = ImageCacheStats;

export async function getImageCacheStats(): Promise<ImageCacheStats> {
  const response = await fetch(`${API_BASE}/admin/images/stats`);
  return handleResponse<ImageCacheStats>(response);
}

export async function getMediaCacheStats(): Promise<MediaCacheStats> {
  const response = await fetch(`${API_BASE}/admin/media/stats`);
  return handleResponse<MediaCacheStats>(response);
}

export function getCachedImageUrl(hash: string): string {
  return `${API_BASE}/admin/images/${hash}`;
}

export function resolveMediaUrl(hashOrUrl: string): string {
  const value = hashOrUrl.trim();
  if (value.length === 0) {
    return value;
  }
  if (/^https?:\/\//i.test(value) || /^data:/i.test(value) || value.startsWith('/')) {
    return value;
  }
  if (value.startsWith('admin/')) {
    return `${API_BASE}/${value}`;
  }
  if (value.startsWith('media/')) {
    return `${API_BASE}/admin/${value}`;
  }
  if (value.startsWith('images/')) {
    return `${API_BASE}/admin/${value}`;
  }
  return `${API_BASE}/admin/media/${value}`;
}

export function normalizeSessionMessageMedia(message: ChatSessionMessage): ChatSessionMessage {
  const normalizedContent = normalizeContentMedia(message.content);
  const normalizedImages = message.images?.map(resolveMediaUrl);
  return {
    ...message,
    content: normalizedContent,
    images: normalizedImages,
  };
}

export function normalizeContentMedia(
  content: string | ContentPart[] | null
): string | ContentPart[] | null {
  if (!Array.isArray(content)) {
    return content;
  }
  return content.map((part) => {
    if (part.type === 'image_url') {
      return {
        ...part,
        image_url: { ...part.image_url, url: resolveMediaUrl(part.image_url.url) },
      };
    }
    if (part.type === 'input_audio' && part.input_audio?.url) {
      return {
        ...part,
        input_audio: { ...part.input_audio, url: resolveMediaUrl(part.input_audio.url) },
      };
    }
    if (part.type === 'audio' && part.audio?.url) {
      return {
        ...part,
        audio: { ...part.audio, url: resolveMediaUrl(part.audio.url) },
      };
    }
    return part;
  });
}

export async function storeMedia(
  data: string,
  model?: string,
  mimeType?: string
): Promise<{ hash: string; url: string; mimeType?: string; evicted: string[] }> {
  const response = await fetch(`${API_BASE}/admin/media`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data, model, mimeType }),
  });
  return handleResponse<{ hash: string; url: string; mimeType?: string; evicted: string[] }>(response);
}

export async function storeImage(
  data: string, 
  model?: string
): Promise<{ hash: string; url: string; evicted: string[] }> {
  const result = await storeMedia(data, model);
  return { hash: result.hash, url: result.url, evicted: result.evicted };
}

export async function clearImageCache(): Promise<{ deleted: number }> {
  const response = await fetch(`${API_BASE}/admin/images`, {
    method: 'DELETE',
  });
  return handleResponse<{ deleted: number }>(response);
}

export interface BenchmarkRunSummary {
  id: string;
  status: 'running' | 'completed' | 'failed';
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  suite?: string;
  exampleId?: string;
  profile?: string;
  scenarioPath?: string;
  succeeded?: number;
  failed?: number;
  successRate?: number;
  artifactPath?: string;
}

export interface BenchmarkExampleSummary {
  id: string
  suite: string
  mode: string
  title: string
  summary: string
  userVisibleGoal: string
  exampleSource: 'opencode' | 'builtin' | 'file'
  inputPreview: string
  successCriteria: string
  expectedHighlights: string[]
  requiresAvailableTools: boolean
  model?: string
}

export type BenchmarkCapabilityKey =
  | 'chat_basic'
  | 'chat_streaming'
  | 'chat_tool_calls'
  | 'chat_vision_input'
  | 'images_generation'
  | 'images_edit'
  | 'embeddings'
  | 'audio_transcription'
  | 'audio_speech'
  | 'responses_compat'

export type BenchmarkCapabilityStatus = 'supported' | 'unsupported' | 'unknown' | 'misconfigured'

export interface BenchmarkCapabilityFinding {
  capability: BenchmarkCapabilityKey
  status: BenchmarkCapabilityStatus
  confidence: number
  evidence: string
  scenarioId?: string
  statusCode?: number
  observedAt: string
}

export interface BenchmarkModelCapabilitySnapshot {
  model: string
  providerId: string
  modelId: string
  configFingerprint: string
  confidence: number
  lastVerifiedAt: string
  expiresAt: string
  freshness: 'fresh' | 'stale'
  findings: Record<BenchmarkCapabilityKey, BenchmarkCapabilityFinding>
}

export interface BenchmarkCapabilityMatrix {
  generatedAt: string
  ttlDays: number
  models: BenchmarkModelCapabilitySnapshot[]
}

export interface BenchmarkRunEvent {
  type: string;
  timestamp: string;
  runId?: string;
  scenarioId?: string;
  scenarioIndex?: number;
  totalScenarios?: number;
  runIndex?: number;
  totalRuns?: number;
  phase?: 'warmup' | 'measured';
  scenario?: BenchmarkExampleSummary;
  warning?: string;
  summary?: {
    total: number;
    executed: number;
    succeeded: number;
    failed: number;
    successRate: number;
  };
  exchange?: {
    mode: string;
    model: string;
    scenarioInput: string;
    requestPreview: string;
    responsePreview: string;
    requestPath: string;
    statusCode: number;
    contentType: string;
    endpointId?: string;
    endpointName?: string;
    upstreamModel?: string;
    toolTrace: Array<{
      kind: 'tool_call' | 'tool_result';
      toolName: string;
      toolCallId?: string;
      argumentsText?: string;
      contentText?: string;
    }>;
    requestRaw: unknown;
    requestSanitized: unknown;
    responseRaw: unknown;
    responseSanitized: unknown;
  };
}

export interface BenchmarkScenarioDetail {
  id: string
  suite?: string
  example?: BenchmarkExampleSummary
  model: string
  status: 'passed' | 'failed' | 'skipped'
  verdict: string
  exchanges: Array<{
    timestamp?: string
    mode: string
    model: string
    requestPath: string
    statusCode: number
    contentType: string
    requestSanitized: unknown
    responseSanitized: unknown
    requestPreview: string
    responsePreview: string
    endpointId?: string
    endpointName?: string
    upstreamModel?: string
    toolTrace: Array<{
      kind: 'tool_call' | 'tool_result'
      toolName: string
      toolCallId?: string
      argumentsText?: string
      contentText?: string
    }>
  }>
  finalResponsePreview: string
  usedToolNames: string[]
}

export interface BenchmarkReport {
  id: string
  profile: string
  executionMode: 'showcase' | 'diagnostic'
  suite?: string
  exampleId?: string
  scenarioPath?: string
  modelOverride?: string
  total: number
  executed: number
  skipped: number
  succeeded: number
  failed: number
  successRate: number
  avgLatencyMs: number
  p95LatencyMs: number
  totalTokens: number
  totalToolCalls: number
  avgThroughputTokensPerSec: number
  results: Array<{
    id: string
    mode: string
    title?: string
    model: string
    status: 'passed' | 'failed' | 'skipped'
    passRate: number
    outputPreview: string
    verdict: string
    usedToolNames: string[]
    errorReasons: string[]
    skippedReason?: string
    totalTokens: number
    failovers: number
    p95LatencyMs: number
  }>
  scenarioDetails: BenchmarkScenarioDetail[]
  capabilityMatrix?: BenchmarkCapabilityMatrix
  gateResults: {
    hard: { passed: boolean; messages: string[] }
    soft: { passed: boolean; messages: string[] }
  }
  warnings: string[]
}

export interface BenchmarkRunRecord extends BenchmarkRunSummary {
  request?: {
    suite?: string;
    exampleId?: string;
    scenarioPath?: string;
    modelOverride?: string;
    outPath?: string;
    configPath?: string;
    profile?: string;
    baselinePath?: string;
    executionMode?: 'showcase' | 'diagnostic';
    updateCapCache?: boolean;
    capTtlDays?: number;
  };
  progress?: {
    totalScenarios: number;
    completedScenarios: number;
    currentScenarioId?: string;
    currentScenarioIndex?: number;
    currentRunIndex?: number;
    totalRuns?: number;
    phase?: 'warmup' | 'measured';
  };
  report?: BenchmarkReport;
  events?: BenchmarkRunEvent[];
  error?: string;
}

export async function startBenchmarkRun(payload: {
  suite?: string;
  exampleId?: string;
  scenarioPath?: string;
  modelOverride?: string;
  configPath?: string;
  profile?: string;
  baselinePath?: string;
  executionMode?: 'showcase' | 'diagnostic';
  updateCapCache?: boolean;
  capTtlDays?: number;
}): Promise<BenchmarkRunRecord> {
  const response = await fetch(`${API_BASE}/admin/benchmarks/runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return handleResponse<BenchmarkRunRecord>(response);
}

export async function listBenchmarkExamples(suite = 'showcase'): Promise<{ object: 'list'; suite: string; data: BenchmarkExampleSummary[] }> {
  const query = `?suite=${encodeURIComponent(suite)}`
  const response = await fetch(`${API_BASE}/admin/benchmarks/examples${query}`)
  return handleResponse<{ object: 'list'; suite: string; data: BenchmarkExampleSummary[] }>(response)
}

export async function listBenchmarkCapabilities(ttlDays?: number): Promise<BenchmarkCapabilityMatrix> {
  const query = typeof ttlDays === 'number' ? `?ttlDays=${encodeURIComponent(String(ttlDays))}` : ''
  const response = await fetch(`${API_BASE}/admin/benchmarks/capabilities${query}`)
  return handleResponse<BenchmarkCapabilityMatrix>(response)
}

export async function getBenchmarkCapability(modelId: string, ttlDays?: number): Promise<BenchmarkModelCapabilitySnapshot> {
  const query = typeof ttlDays === 'number' ? `?ttlDays=${encodeURIComponent(String(ttlDays))}` : ''
  const response = await fetch(
    `${API_BASE}/admin/benchmarks/capabilities/${encodeURIComponent(modelId)}${query}`
  )
  return handleResponse<BenchmarkModelCapabilitySnapshot>(response)
}

export async function listBenchmarkRuns(): Promise<{ object: 'list'; data: BenchmarkRunSummary[] }> {
  const response = await fetch(`${API_BASE}/admin/benchmarks/runs`);
  return handleResponse<{ object: 'list'; data: BenchmarkRunSummary[] }>(response);
}

export async function getBenchmarkRun(runId: string): Promise<BenchmarkRunRecord> {
  const response = await fetch(`${API_BASE}/admin/benchmarks/runs/${encodeURIComponent(runId)}`);
  return handleResponse<BenchmarkRunRecord>(response);
}

// ========================================
// MCP API (Model Context Protocol)
// ========================================

export interface McpServer {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  status: 'connected' | 'disconnected' | 'error' | 'unknown';
  connected: boolean;
  toolCount?: number;
  lastConnectedAt?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

export interface McpTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  serverId: string;
  serverName: string;
  serverUrl: string;
}

export interface McpServersResponse {
  object: 'list';
  data: McpServer[];
}

export interface McpToolsResponse {
  object: 'list';
  data: McpTool[];
}

export async function listMcpServers(): Promise<McpServersResponse> {
  const response = await fetch(`${API_BASE}/admin/mcp/servers`);
  return handleResponse<McpServersResponse>(response);
}

export async function getMcpServer(serverId: string): Promise<McpServer & { tools: McpTool[] }> {
  const response = await fetch(`${API_BASE}/admin/mcp/servers/${serverId}`);
  return handleResponse<McpServer & { tools: McpTool[] }>(response);
}

export async function addMcpServer(
  name: string,
  url: string,
  enabled?: boolean
): Promise<McpServer> {
  const response = await fetch(`${API_BASE}/admin/mcp/servers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, url, enabled }),
  });
  return handleResponse<McpServer>(response);
}

export async function updateMcpServer(
  serverId: string,
  updates: { name?: string; url?: string; enabled?: boolean }
): Promise<McpServer> {
  const response = await fetch(`${API_BASE}/admin/mcp/servers/${serverId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updates),
  });
  return handleResponse<McpServer>(response);
}

export async function deleteMcpServer(serverId: string): Promise<void> {
  const response = await fetch(`${API_BASE}/admin/mcp/servers/${serverId}`, {
    method: 'DELETE',
  });
  if (!response.ok) {
    throw new ApiError(response.status, response.statusText);
  }
}

export async function connectMcpServer(
  serverId: string
): Promise<{ connected: boolean; toolCount: number; tools: { name: string; description?: string }[] }> {
  const response = await fetch(`${API_BASE}/admin/mcp/servers/${serverId}/connect`, {
    method: 'POST',
  });
  return handleResponse<{ connected: boolean; toolCount: number; tools: { name: string; description?: string }[] }>(response);
}

export async function disconnectMcpServer(serverId: string): Promise<{ disconnected: boolean }> {
  const response = await fetch(`${API_BASE}/admin/mcp/servers/${serverId}/disconnect`, {
    method: 'POST',
  });
  return handleResponse<{ disconnected: boolean }>(response);
}

export async function listMcpTools(): Promise<McpToolsResponse> {
  const response = await fetch(`${API_BASE}/admin/mcp/tools`);
  return handleResponse<McpToolsResponse>(response);
}

export async function discoverMcpTools(): Promise<{ discovered: number; tools: { name: string; description?: string; serverName: string }[] }> {
  const response = await fetch(`${API_BASE}/admin/mcp/tools/discover`, {
    method: 'POST',
  });
  return handleResponse<{ discovered: number; tools: { name: string; description?: string; serverName: string }[] }>(response);
}

export async function executeMcpTool(
  name: string,
  args: Record<string, unknown>
): Promise<{ result: string }> {
  const response = await fetch(`${API_BASE}/admin/mcp/tools/execute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, arguments: args }),
  });
  return handleResponse<{ result: string }>(response);
}

// ========================================
// Capture API
// ========================================

export interface CaptureConfig {
  enabled: boolean;
  retentionDays: number;
  maxBytes: number;
}

export interface CaptureRecordSummary {
  id: string;
  timestamp: string;
  route: string;
  method: string;
  statusCode: number;
  latencyMs: number;
  model?: string;
}

export interface CaptureTimelineEntry {
  direction: 'request' | 'response';
  kind: 'message' | 'tool_definition' | 'tool_call' | 'tool_result' | 'reasoning' | 'instructions' | 'stream_preview' | 'error';
  index: number;
  sourcePath: string;
  role?: 'system' | 'user' | 'assistant' | 'tool' | 'developer';
  content?: string;
  name?: string;
  arguments?: string;
  toolCallId?: string;
  metadata?: Record<string, unknown>;
}

export interface CaptureCalendarDaySummary {
  date: string;
  count: number;
}

export interface CaptureRecordDetail {
  id: string;
  timestamp: string;
  route: string;
  method: string;
  captureEnabledSnapshot: boolean;
  statusCode: number;
  latencyMs: number;
  request: {
    headers: Record<string, string>;
    body?: unknown;
    derived?: Record<string, unknown>;
  };
  response: {
    headers: Record<string, string>;
    body?: unknown;
    error?: { type?: string; message?: string };
  };
  routing: {
    publicModel?: string;
    endpointId?: string;
    endpointName?: string;
    upstreamModel?: string;
  };
  analysis: {
    systemMessages: CaptureTextMessage[];
    userMessages: CaptureTextMessage[];
    assistantMessages: CaptureAssistantMessage[];
    toolMessages?: CaptureToolMessage[];
    requestTimeline?: CaptureTimelineEntry[];
    responseTimeline?: CaptureTimelineEntry[];
    tools: Array<{ name: string; description?: string }>;
    mcpToolDescriptions: string[];
    agentsMdHints: string[];
    rawSections: string[];
    tokenFlow?: {
      eligible: boolean;
      reason?: string;
      method: 'exact_totals_estimated_categories' | 'estimated_only' | 'unavailable';
      totals: {
        inputTokens: number | null;
        outputTokens: number | null;
        totalTokens: number | null;
      };
      input: Array<{ key: string; label: string; tokens: number }>;
      output: Array<{ key: string; label: string; tokens: number }>;
      notes?: string[];
    };
  };
  artifacts: Array<{
    hash: string;
    mime: string;
    bytes: number;
    blobRef: string;
    kind: 'image' | 'audio' | 'binary';
  }>;
}

export interface CaptureTextMessage {
  content: string;
  truncated?: boolean;
  originalLength?: number;
}

export interface CaptureAssistantMessage extends CaptureTextMessage {
  reasoningContent?: string;
  toolCalls?: CaptureToolCall[];
  asksForClarification?: boolean;
}

export interface CaptureToolMessage extends CaptureTextMessage {
  toolCallId?: string;
}

export interface CaptureToolCall {
  id?: string;
  type?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
}

export async function getCaptureConfig(): Promise<CaptureConfig> {
  const response = await fetch(`${API_BASE}/admin/capture/config`);
  return handleResponse<CaptureConfig>(response);
}

export async function updateCaptureConfig(
  patch: Partial<CaptureConfig>
): Promise<CaptureConfig> {
  const response = await fetch(`${API_BASE}/admin/capture/config`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  return handleResponse<CaptureConfig>(response);
}

export async function listCaptureRecords(
  options: { limit?: number; offset?: number; date?: string } = {}
): Promise<{ object: 'list'; data: CaptureRecordSummary[]; total: number }> {
  const params = new URLSearchParams()
  if (options.limit !== undefined) params.set('limit', String(options.limit))
  if (options.offset !== undefined) params.set('offset', String(options.offset))
  if (options.date) params.set('date', options.date)
  const response = await fetch(`${API_BASE}/admin/capture/records?${params.toString()}`);
  return handleResponse<{ object: 'list'; data: CaptureRecordSummary[]; total: number }>(response);
}

export async function getCaptureRecord(id: string): Promise<CaptureRecordDetail> {
  const response = await fetch(`${API_BASE}/admin/capture/records/${encodeURIComponent(id)}`);
  return handleResponse<CaptureRecordDetail>(response);
}

export async function getCaptureCalendar(
  month: string
): Promise<{ month: string; days: CaptureCalendarDaySummary[] }> {
  const response = await fetch(`${API_BASE}/admin/capture/calendar?month=${encodeURIComponent(month)}`);
  return handleResponse<{ month: string; days: CaptureCalendarDaySummary[] }>(response);
}
