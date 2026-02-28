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
