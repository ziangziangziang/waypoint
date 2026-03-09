import { BenchmarkScenario } from "./types";

const SUITES: Record<string, BenchmarkScenario[]> = {
  smoke: [
    {
      id: "smoke-chat-exact",
      mode: "chat",
      prompt: "Reply exactly with: WAYPOINT_SMOKE_OK",
      assertions: {
        contains: ["WAYPOINT_SMOKE_OK"],
        statusCode: 200,
      },
    },
    {
      id: "smoke-agent-loop",
      mode: "agent",
      prompt:
        "If tools are available, call exactly one and summarize. If no tools are available, output NO_TOOLS_AVAILABLE. Prefix final answer with WAYPOINT_AGENT_DONE:",
      maxIterations: 4,
      assertions: {
        contains: ["WAYPOINT_AGENT_DONE"],
        statusCode: 200,
      },
    },
    {
      id: "smoke-embeddings-basic",
      mode: "embeddings",
      input: "waypoint benchmark smoke",
      assertions: {
        minItems: 1,
        minVectorLength: 1,
        statusCode: 200,
      },
    },
    {
      id: "smoke-image-generation",
      mode: "image_generation",
      prompt: "A tiny blue square on white background",
      assertions: {
        minImages: 1,
        statusCode: 200,
      },
    },
    {
      id: "smoke-audio-speech",
      mode: "audio_speech",
      inputText: "Waypoint benchmark smoke",
      voice: "alloy",
      assertions: {
        minBytes: 1,
        statusCode: 200,
      },
    },
  ],
  proxy: [
    {
      id: "proxy-chat-short",
      mode: "chat",
      prompt: "Answer with one word: waypoint",
      assertions: {
        contains: ["waypoint"],
        statusCode: 200,
      },
    },
    {
      id: "proxy-embeddings",
      mode: "embeddings",
      input: ["waypoint", "proxy", "benchmark"],
      assertions: {
        minItems: 3,
        minVectorLength: 1,
        statusCode: 200,
      },
    },
    {
      id: "proxy-image",
      mode: "image_generation",
      prompt: "A minimal icon of a gateway",
      assertions: {
        minImages: 1,
        statusCode: 200,
      },
    },
  ],
  agent: [
    {
      id: "agent-tool-loop-basic",
      mode: "agent",
      prompt:
        "Use available tools if useful, then provide a concise final answer prefixed with WAYPOINT_AGENT_DONE:",
      maxIterations: 6,
      assertions: {
        contains: ["WAYPOINT_AGENT_DONE"],
        statusCode: 200,
      },
    },
    {
      id: "agent-tool-required",
      mode: "agent",
      prompt: "Use at least one tool before answering.",
      maxIterations: 6,
      assertions: {
        minToolCalls: 1,
        statusCode: 200,
      },
    },
  ],
  pool_smoke: [
    {
      id: "pool-smart-chat",
      mode: "chat",
      model: "smart",
      prompt: "Reply exactly with: WAYPOINT_POOL_SMOKE_OK",
      assertions: {
        contains: ["WAYPOINT_POOL_SMOKE_OK"],
        statusCode: 200,
      },
    },
    {
      id: "pool-smart-agent",
      mode: "agent",
      model: "smart",
      prompt: "Answer with prefix WAYPOINT_POOL_AGENT_DONE:",
      assertions: {
        contains: ["WAYPOINT_POOL_AGENT_DONE"],
        statusCode: 200,
      },
    },
  ],
  omni_call_smoke: [
    {
      id: "omni-call-basic",
      mode: "omni_call",
      prompt: "Please transcribe this audio and summarize it in one sentence.",
      audioFile: "examples/scenarios/assets/omni-call-sample.wav",
      assertions: {
        statusCode: 200,
      },
    },
  ],
  capabilities: [
    {
      id: "cap.chat_basic",
      mode: "chat",
      capability: "chat_basic",
      prompt: "Reply exactly with: WAYPOINT_CAP_CHAT_BASIC_OK",
      assertions: {
        contains: ["WAYPOINT_CAP_CHAT_BASIC_OK"],
        statusCode: 200,
      },
    },
    {
      id: "cap.chat_streaming",
      mode: "chat",
      capability: "chat_streaming",
      prompt: "Reply exactly with: WAYPOINT_CAP_STREAMING_OK",
      assertions: {
        contains: ["WAYPOINT_CAP_STREAMING_OK"],
        statusCode: 200,
      },
    },
    {
      id: "cap.chat_tool_calls",
      mode: "agent",
      capability: "chat_tool_calls",
      prompt: "Use at least one tool if available, then output WAYPOINT_CAP_TOOL_CALLS_OK.",
      maxIterations: 4,
      assertions: {
        contains: ["WAYPOINT_CAP_TOOL_CALLS_OK"],
        minToolCalls: 1,
        statusCode: 200,
      },
    },
    {
      id: "cap.chat_vision_input",
      mode: "chat",
      capability: "chat_vision_input",
      prompt: "Vision probe placeholder: reply with WAYPOINT_CAP_VISION_UNKNOWN when image input is unavailable.",
      assertions: {
        statusCode: 200,
      },
    },
    {
      id: "cap.images_generation",
      mode: "image_generation",
      capability: "images_generation",
      prompt: "A monochrome square icon.",
      assertions: {
        minImages: 1,
        statusCode: 200,
      },
    },
    {
      id: "cap.images_edit",
      mode: "image_generation",
      capability: "images_edit",
      prompt: "Image edit probe placeholder",
      assertions: {
        statusCode: 200,
      },
    },
    {
      id: "cap.embeddings",
      mode: "embeddings",
      capability: "embeddings",
      input: "waypoint capability embeddings probe",
      assertions: {
        minItems: 1,
        minVectorLength: 1,
        statusCode: 200,
      },
    },
    {
      id: "cap.audio_transcription",
      mode: "audio_transcription",
      capability: "audio_transcription",
      audioFile: "examples/scenarios/assets/omni-call-sample.wav",
      assertions: {
        statusCode: 200,
      },
    },
    {
      id: "cap.audio_speech",
      mode: "audio_speech",
      capability: "audio_speech",
      inputText: "Waypoint capability speech probe",
      voice: "alloy",
      assertions: {
        minBytes: 1,
        statusCode: 200,
      },
    },
    {
      id: "cap.responses_compat",
      mode: "omni_call",
      capability: "responses_compat",
      prompt: "Please transcribe and summarize.",
      audioFile: "examples/scenarios/assets/omni-call-sample.wav",
      assertions: {
        statusCode: 200,
      },
    },
    {
      id: "cap.concurrent_chat_basic",
      mode: "chat",
      capability: "chat_basic",
      prompt: "Reply exactly with: WAYPOINT_CAP_CONCURRENT_CHAT_OK",
      assertions: {
        contains: ["WAYPOINT_CAP_CONCURRENT_CHAT_OK"],
        statusCode: 200,
      },
    },
    {
      id: "cap.agent_tool_calls_under_load",
      mode: "agent",
      capability: "chat_tool_calls",
      prompt: "Use one tool then reply with WAYPOINT_CAP_AGENT_LOAD_OK.",
      maxIterations: 4,
      assertions: {
        contains: ["WAYPOINT_CAP_AGENT_LOAD_OK"],
        minToolCalls: 1,
        statusCode: 200,
      },
    },
  ],
};

export function builtInSuite(name: string): BenchmarkScenario[] {
  const suite = SUITES[name];
  if (!suite) {
    throw new Error(`Unknown suite: ${name}. Supported suites: ${listBuiltInSuites().join(", ")}`);
  }
  return suite.map((scenario) => ({
    ...scenario,
    assertions: { ...scenario.assertions },
    tools: scenario.tools ? [...scenario.tools] : undefined,
    input: Array.isArray(scenario.input) ? [...scenario.input] : scenario.input,
  }));
}

export function listBuiltInSuites(): string[] {
  return Object.keys(SUITES).sort();
}
