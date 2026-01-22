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

// ========================================
// Endpoints API
// ========================================

export interface EndpointHealth {
  status: 'up' | 'down';
  lastCheckedAt?: string;
  lastSuccessAt?: string;
  lastFailureAt?: string;
  consecutiveFailures: number;
  downUntil?: string;
  latencyMsEwma?: number;
}

export interface ModelMapping {
  publicName: string;
  upstreamModel: string;
}

export interface Endpoint {
  id: string;
  name: string;
  baseUrl: string;
  apiKey?: string;
  insecureTls: boolean;
  priority: number;
  weight?: number;
  type: 'llm' | 'diffusion' | 'audio' | 'embedding';
  models: ModelMapping[];
  health: EndpointHealth;
  limits?: { timeoutMs?: number; maxConcurrent?: number };
  createdAt: string;
  updatedAt: string;
}

export async function listEndpoints(): Promise<Endpoint[]> {
  const response = await fetch(`${API_BASE}/admin/endpoints`);
  return handleResponse<Endpoint[]>(response);
}

export async function getEndpointHealth(): Promise<Record<string, EndpointHealth>> {
  const response = await fetch(`${API_BASE}/admin/health`);
  return handleResponse<Record<string, EndpointHealth>>(response);
}

// ========================================
// Models API
// ========================================

export type EndpointType = 'llm' | 'diffusion' | 'audio' | 'embedding';

export interface Model {
  id: string;
  object: 'model';
  created?: number;
  owned_by?: string;
  endpoint_type?: EndpointType;
}

export interface ModelsResponse {
  object: 'list';
  data: Model[];
}

export async function listModels(): Promise<ModelsResponse> {
  const response = await fetch(`${API_BASE}/v1/models`);
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
  min: number;
  max: number;
  avg: number;
  p50: number;
  p95: number;
  p99: number;
  histogram: Record<string, number>;
}

export async function getLatencyDistribution(window: string = '7d'): Promise<LatencyDistribution> {
  const response = await fetch(`${API_BASE}/admin/stats/latency?window=${window}`);
  return handleResponse<LatencyDistribution>(response);
}

export interface TokenUsage {
  window: string;
  totalTokens: number;
  totalRequests: number;
  avgTokensPerRequest: number;
  byDay: Array<{ date: string; count: number; tokens: number; estimated: number }>;
}

export async function getTokenUsage(window: string = '7d'): Promise<TokenUsage> {
  const response = await fetch(`${API_BASE}/admin/stats/tokens?window=${window}`);
  return handleResponse<TokenUsage>(response);
}

// ========================================
// Chat Completions API (for Playground)
// ========================================

// Content can be a string or array of content parts (multimodal)
export type ContentPart = 
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

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

/**
 * Stream chat completion using Server-Sent Events
 */
export async function* streamChatCompletion(
  request: ChatCompletionRequest,
  signal?: AbortSignal
): AsyncGenerator<string, void, unknown> {
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
          const content = parsed.choices?.[0]?.delta?.content;
          if (content) {
            yield content;
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
  timestamp: string;
}

export interface ChatSession {
  id: string;
  name: string;
  model?: string;
  messages: ChatSessionMessage[];
  createdAt: string;
  updatedAt: string;
}

export interface SessionListItem {
  id: string;
  name: string;
  model?: string;
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
  return handleResponse<ChatSession>(response);
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
): Promise<{ messageIndex: number }> {
  const response = await fetch(`${API_BASE}/admin/sessions/${sessionId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(message),
  });
  return handleResponse<{ messageIndex: number }>(response);
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

export async function getImageCacheStats(): Promise<ImageCacheStats> {
  const response = await fetch(`${API_BASE}/admin/images/stats`);
  return handleResponse<ImageCacheStats>(response);
}

export function getCachedImageUrl(hash: string): string {
  return `${API_BASE}/admin/images/${hash}`;
}

export async function storeImage(
  data: string, 
  model?: string
): Promise<{ hash: string; url: string; evicted: string[] }> {
  const response = await fetch(`${API_BASE}/admin/images`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data, model }),
  });
  return handleResponse<{ hash: string; url: string; evicted: string[] }>(response);
}

export async function clearImageCache(): Promise<{ deleted: number }> {
  const response = await fetch(`${API_BASE}/admin/images`, {
    method: 'DELETE',
  });
  return handleResponse<{ deleted: number }>(response);
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
