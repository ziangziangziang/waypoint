import { inferenceV2ProtocolAdapter } from "./adapters/inferenceV2";
import { openAiProtocolAdapter } from "./adapters/openai";
import { ProtocolAdapter, ProtocolOperation } from "./types";

const PROTOCOL_ALIASES: Record<string, string> = {
  openai: "openai",
  inference_v2: "inference_v2",
  "kserve-v2": "inference_v2",
  kserve_v2: "inference_v2",
  ray_infer_v2: "inference_v2",
  "ray-infer-v2": "inference_v2",
  v2_infer: "inference_v2",
  "v2-infer": "inference_v2",
};

const ADAPTERS = new Map<string, ProtocolAdapter>([
  [openAiProtocolAdapter.id, openAiProtocolAdapter],
  [inferenceV2ProtocolAdapter.id, inferenceV2ProtocolAdapter],
]);

export function canonicalizeProtocol(raw: string | undefined): string {
  const normalized = (raw ?? "unknown").trim().toLowerCase();
  return (PROTOCOL_ALIASES[normalized] ?? normalized) || "unknown";
}

export function getProtocolAdapter(
  protocol: string | undefined
): ProtocolAdapter | null {
  const canonical = canonicalizeProtocol(protocol);
  return ADAPTERS.get(canonical) ?? null;
}

export function hasProtocolAdapter(protocol: string | undefined): boolean {
  return getProtocolAdapter(protocol) !== null;
}

export function listAdapterOperations(
  protocol: string | undefined
): {
  operations: ProtocolOperation[];
  streamOperations: ProtocolOperation[];
} | null {
  const adapter = getProtocolAdapter(protocol);
  if (!adapter) {
    return null;
  }
  return {
    operations: [...adapter.supportedOperations],
    streamOperations: [...adapter.streamSupportedOperations],
  };
}

export function routePathToOperation(path: string): ProtocolOperation | null {
  switch (path) {
    case "/v1/chat/completions":
      return "chat_completions";
    case "/v1/embeddings":
      return "embeddings";
    case "/v1/images/generations":
      return "images_generation";
    case "/v1/images/edits":
      return "images_edits";
    case "/v1/images/variations":
      return "images_variations";
    case "/v1/audio/transcriptions":
      return "audio_transcriptions";
    case "/v1/audio/translations":
      return "audio_translations";
    case "/v1/audio/speech":
      return "audio_speech";
    default:
      return null;
  }
}
