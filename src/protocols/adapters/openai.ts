import {
  PreparedUpstreamRequest,
  ProtocolAdapter,
  ProtocolBuildRequestContext,
  ProtocolSupportContext,
} from "../types";

const ALL_OPERATIONS = [
  "chat_completions",
  "embeddings",
  "images_generation",
  "images_edits",
  "images_variations",
  "audio_transcriptions",
  "audio_translations",
  "audio_speech",
] as const;

export const openAiProtocolAdapter: ProtocolAdapter = {
  id: "openai",
  supportedOperations: [...ALL_OPERATIONS],
  streamSupportedOperations: [...ALL_OPERATIONS],
  supports(_context: ProtocolSupportContext) {
    return { supported: true };
  },
  async buildRequest(context: ProtocolBuildRequestContext): Promise<PreparedUpstreamRequest> {
    return {
      path: context.path,
      payload: context.payload,
    };
  },
};
