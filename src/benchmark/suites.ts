import { BenchmarkScenario, BenchmarkScenarioSummary } from "./types";

const SUITES: Record<string, BenchmarkScenario[]> = {
  showcase: [
    {
      id: "showcase-chat-welcome",
      mode: "chat",
      title: "Plain Chat Reply",
      summary: "Shows the simplest OpenAI-compatible chat completion through Waypoint.",
      userVisibleGoal: "Send a normal user prompt and inspect the exact request and final answer.",
      exampleSource: "opencode",
      inputPreview: "In one sentence, explain what Waypoint does for an OpenAI-compatible client.",
      successCriteria: "Returns a short explanation and completes with HTTP 200.",
      expectedHighlights: ["chat request shape", "selected model", "final assistant reply"],
      prompt: "In one sentence, explain what Waypoint does for an OpenAI-compatible client.",
      assertions: {
        statusCode: 200,
      },
    },
    {
      id: "showcase-responses-basic",
      mode: "responses",
      title: "Responses API Compatibility",
      summary: "Demonstrates the /v1/responses compatibility shim using a real text input.",
      userVisibleGoal: "Show that a Responses-style client can use Waypoint without changing the upstream provider.",
      exampleSource: "opencode",
      inputPreview: "List two reasons a local OpenAI-compatible gateway is useful for an agent client.",
      successCriteria: "Returns two concrete reasons through /v1/responses.",
      expectedHighlights: ["responses request shape", "responses output_text payload", "OpenAI compatibility path"],
      prompt: "List two reasons a local OpenAI-compatible gateway is useful for an agent client.",
      assertions: {
        statusCode: 200,
      },
    },
    {
      id: "showcase-agent-tool-call",
      mode: "agent",
      title: "Agent Tool Calling",
      summary: "Demonstrates a real tool-calling loop with visible tool arguments and tool results.",
      userVisibleGoal: "Watch an agent choose a tool, call it, and reference the result in the final answer.",
      exampleSource: "opencode",
      inputPreview: "Use one available tool, then summarize what you learned in one sentence prefixed with WAYPOINT_TOOL_SHOWCASE_DONE:.",
      successCriteria: "Calls at least one tool and returns a final answer with the required prefix.",
      expectedHighlights: ["tool definitions on request", "tool call arguments", "tool result payload", "final answer after tool use"],
      prompt: "Use one available tool, then summarize what you learned in one sentence prefixed with WAYPOINT_TOOL_SHOWCASE_DONE:.",
      maxIterations: 4,
      requiresAvailableTools: true,
      assertions: {
        contains: ["WAYPOINT_TOOL_SHOWCASE_DONE:"],
        minToolCalls: 1,
        statusCode: 200,
      },
    },
    {
      id: "showcase-agent-tool-loop",
      mode: "agent",
      title: "Agent Multi-Step Loop",
      summary: "Shows a longer agent exchange where the model can inspect a tool result before answering.",
      userVisibleGoal: "Observe a multi-step agent flow rather than a single chat turn.",
      exampleSource: "opencode",
      inputPreview: "Use one available tool, then answer in two bullet points prefixed with WAYPOINT_AGENT_LOOP_DONE:.",
      successCriteria: "Uses a tool and produces a concise, tool-informed final answer.",
      expectedHighlights: ["multiple assistant turns", "tool result inserted into conversation", "verdict after assertions"],
      prompt: "Use one available tool, then answer in two bullet points prefixed with WAYPOINT_AGENT_LOOP_DONE:.",
      maxIterations: 5,
      requiresAvailableTools: true,
      assertions: {
        contains: ["WAYPOINT_AGENT_LOOP_DONE:"],
        minToolCalls: 1,
        statusCode: 200,
      },
    },
    {
      id: "showcase-image-generation",
      mode: "image_generation",
      title: "Image Generation",
      summary: "Demonstrates the image generation path with a simple prompt and returned image payload.",
      userVisibleGoal: "Show the exact prompt sent to the model and the returned image metadata.",
      exampleSource: "opencode",
      inputPreview: "Create a minimal poster-style icon of a gateway with strong contrast.",
      successCriteria: "Returns at least one image result.",
      expectedHighlights: ["image request payload", "image response payload", "file-first compatible output"],
      prompt: "Create a minimal poster-style icon of a gateway with strong contrast.",
      assertions: {
        minImages: 1,
        statusCode: 200,
      },
    },
    {
      id: "showcase-omni-call",
      mode: "omni_call",
      title: "Audio + Text Turn",
      summary: "Demonstrates a real multimodal audio input request and final text response.",
      userVisibleGoal: "Show how Waypoint packages audio and text together for an OpenAI-compatible turn.",
      exampleSource: "opencode",
      inputPreview: "Use the sample audio file and summarize it in one sentence.",
      successCriteria: "Completes with HTTP 200 and returns a text answer.",
      expectedHighlights: ["audio payload in request", "multimodal chat request", "final text summary"],
      prompt: "Please transcribe this audio and summarize it in one sentence.",
      audioFile: "examples/scenarios/assets/omni-call-sample.wav",
      assertions: {
        statusCode: 200,
      },
    },
  ],
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
      requiresAvailableTools: true,
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
        contains: ["WAYPOINT_POOL_AGENT_DONE:"],
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
      requiresAvailableTools: true,
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
      mode: "responses",
      capability: "responses_compat",
      prompt: "Summarize why the Responses API compatibility route matters in one sentence.",
      assertions: {
        statusCode: 200,
      },
    },
  ],
};

export function builtInSuite(name: string): BenchmarkScenario[] {
  const suite = SUITES[name];
  if (!suite) {
    const available = Object.keys(SUITES).sort().join(", ");
    throw new Error(`Unknown benchmark suite '${name}'. Available: ${available}`);
  }
  return suite.map(cloneScenario);
}

export function listBuiltInSuites(): string[] {
  return Object.keys(SUITES).sort();
}

export function listSuiteExamples(name: string): BenchmarkScenarioSummary[] {
  return builtInSuite(name).map((scenario) => toScenarioSummary(name, scenario));
}

function cloneScenario(scenario: BenchmarkScenario): BenchmarkScenario {
  return {
    ...scenario,
    assertions: { ...scenario.assertions },
    expectedHighlights: scenario.expectedHighlights ? [...scenario.expectedHighlights] : undefined,
    tools: scenario.tools ? [...scenario.tools] : undefined,
    input: Array.isArray(scenario.input) ? [...scenario.input] : scenario.input,
  };
}

function toScenarioSummary(suite: string, scenario: BenchmarkScenario): BenchmarkScenarioSummary {
  return {
    id: scenario.id,
    suite,
    mode: scenario.mode,
    title: scenario.title ?? scenario.id,
    summary: scenario.summary ?? "Built-in benchmark scenario.",
    userVisibleGoal: scenario.userVisibleGoal ?? "Exercise the configured model path and inspect the result.",
    exampleSource: scenario.exampleSource ?? "builtin",
    inputPreview:
      scenario.inputPreview ??
      scenario.prompt ??
      scenario.inputText ??
      (typeof scenario.input === "string" ? scenario.input : Array.isArray(scenario.input) ? scenario.input.join(" | ") : ""),
    successCriteria: scenario.successCriteria ?? "All configured assertions pass.",
    expectedHighlights: scenario.expectedHighlights ?? [],
    requiresAvailableTools: scenario.requiresAvailableTools === true,
    model: scenario.model,
  };
}
