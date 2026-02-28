import { StoragePaths } from "../storage/files";
import { EndpointDoc, ModelCapabilities, ModelModality, UpstreamResult } from "../types";

export type ProtocolOperation =
  | "chat_completions"
  | "embeddings"
  | "images_generation"
  | "images_edits"
  | "images_variations"
  | "audio_transcriptions"
  | "audio_translations"
  | "audio_speech";

export interface ProtocolAuthConfig {
  type: "bearer" | "query" | "header" | "none";
  keyParam?: string;
  headerName?: string;
  keyPrefix?: string;
}

export interface ProtocolAdapterConfig {
  router?: string;
  responseTextPaths?: string[];
  [key: string]: unknown;
}

export interface ProtocolSupportContext {
  operation: ProtocolOperation;
  stream: boolean;
  capabilities?: ModelCapabilities;
  requiredInput?: ModelModality[];
  requiredOutput?: ModelModality[];
}

export interface ProtocolSupportResult {
  supported: boolean;
  reason?: "unsupported_operation" | "stream_unsupported";
}

export interface PreparedUpstreamRequest {
  path: string;
  payload: Record<string, unknown>;
  headers?: Record<string, string>;
  skipDefaultAuth?: boolean;
}

export interface ProtocolBuildRequestContext {
  paths: StoragePaths;
  operation: ProtocolOperation;
  stream: boolean;
  path: string;
  payload: Record<string, unknown>;
  publicModel: string;
  upstreamModel: string;
  endpoint: EndpointDoc;
  auth?: ProtocolAuthConfig;
  config?: ProtocolAdapterConfig;
}

export interface ProtocolNormalizeResponseContext {
  operation: ProtocolOperation;
  stream: boolean;
  path: string;
  publicModel: string;
  upstreamModel: string;
  requestPayload: Record<string, unknown>;
  upstreamResult: UpstreamResult;
  config?: ProtocolAdapterConfig;
}

export interface ProtocolAdapter {
  id: string;
  supportedOperations: ProtocolOperation[];
  streamSupportedOperations: ProtocolOperation[];
  supports(context: ProtocolSupportContext): ProtocolSupportResult;
  buildRequest(context: ProtocolBuildRequestContext): Promise<PreparedUpstreamRequest>;
  normalizeResponse?(
    context: ProtocolNormalizeResponseContext
  ): Promise<UpstreamResult>;
}
