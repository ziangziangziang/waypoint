import { promises as fs } from "fs";
import path from "path";
import { randomUUID } from "crypto";
import YAML from "yaml";
import { routeRequest } from "../routing/router";
import { pickBestModelByCapabilities } from "../storage/repositories";
import { StoragePaths } from "../storage/files";
import {
  discoverAllTools,
  disconnectAllServers,
  executeTool,
  getCachedTools,
  summarizeMcpError,
} from "../mcp/discovery";
import { writeBenchmarkArtifacts } from "./artifacts";
import { resolveBenchmarkConfig } from "./config";
import { evaluateGates } from "./gates";
import { validateScenarioCollection } from "./schema";
import { builtInSuite } from "./suites";
import {
  BENCHMARK_MODES,
  BenchmarkCliOptions,
  BenchmarkMode,
  BenchmarkModeRequirements,
  BenchmarkReport,
  BenchmarkRunOutput,
  BenchmarkScenario,
  EffectiveBenchmarkConfig,
  ScenarioResult,
  ScenarioRunSample,
} from "./types";

export type BenchmarkProgressEventType =
  | "run_started"
  | "scenario_started"
  | "exchange"
  | "sample_completed"
  | "scenario_completed"
  | "warning"
  | "run_completed";

export interface BenchmarkExchangeEvent {
  mode: BenchmarkMode;
  model: string;
  requestPath: string;
  statusCode: number;
  contentType: string;
  requestRaw: unknown;
  requestSanitized: unknown;
  responseRaw: unknown;
  responseSanitized: unknown;
}

export interface BenchmarkProgressEvent {
  type: BenchmarkProgressEventType;
  timestamp: string;
  runId?: string;
  scenarioId?: string;
  scenarioIndex?: number;
  totalScenarios?: number;
  runIndex?: number;
  totalRuns?: number;
  phase?: "warmup" | "measured";
  exchange?: BenchmarkExchangeEvent;
  sample?: ScenarioRunSample;
  result?: ScenarioResult;
  warning?: string;
  summary?: Pick<BenchmarkReport, "total" | "executed" | "succeeded" | "failed" | "successRate">;
}

export interface BenchmarkRunHooks {
  runId?: string;
  onEvent?: (event: BenchmarkProgressEvent) => void;
}

interface ChatToolCall {
  id?: string;
  function?: {
    name?: string;
    arguments?: string;
  };
}

interface ChatResponse {
  choices?: Array<{
    message?: {
      content?: unknown;
      tool_calls?: ChatToolCall[];
    };
  }>;
  usage?: {
    total_tokens?: number;
  };
}

interface JsonResponseEnvelope {
  statusCode: number;
  payload: unknown;
  contentType: string;
  requestPayload: Record<string, unknown>;
  poolMetrics?: {
    candidateAttempts: number;
    failovers: number;
    rateLimitSwitches: number;
    distinctProviders: number;
    distinctModels: number;
  };
}

interface BinaryResponseEnvelope {
  statusCode: number;
  buffer: Buffer;
  contentType: string;
  requestPayload: Record<string, unknown>;
  poolMetrics?: {
    candidateAttempts: number;
    failovers: number;
    rateLimitSwitches: number;
    distinctProviders: number;
    distinctModels: number;
  };
}

interface ScenarioExecution {
  result: ScenarioResult;
  samples: ScenarioRunSample[];
  warnings: string[];
}

type ScenarioExchangeCallback = (event: BenchmarkExchangeEvent) => void;

export async function runBenchmark(
  paths: StoragePaths,
  options: BenchmarkCliOptions,
  hooks?: BenchmarkRunHooks
): Promise<BenchmarkRunOutput> {
  const effective = await resolveBenchmarkConfig(paths, options);
  const loaded = await loadScenarios(effective);
  const runId = hooks?.runId;

  if (loaded.scenarios.length === 0) {
    throw new Error("No benchmark scenarios found. Use --suite and/or --scenario.");
  }

  emitEvent(hooks, {
    type: "run_started",
    timestamp: new Date().toISOString(),
    runId,
    totalScenarios: loaded.scenarios.length,
  });

  const warnings = [...loaded.warnings];
  for (const warning of loaded.warnings) {
    emitEvent(hooks, {
      type: "warning",
      timestamp: new Date().toISOString(),
      runId,
      warning,
    });
  }

  const hasAgentScenarios = loaded.scenarios.some((scenario) => scenario.mode === "agent");
  if (hasAgentScenarios) {
    try {
      await discoverAllTools(paths);
    } catch (error) {
      const warning = `MCP discovery failed for benchmark: ${summarizeMcpError(error)}`;
      warnings.push(warning);
      emitEvent(hooks, {
        type: "warning",
        timestamp: new Date().toISOString(),
        runId,
        warning,
      });
      if (process.env.WAYPOINT_DEBUG_ERRORS === "1") {
        console.error(error);
      }
    }
  }

  const executions: ScenarioExecution[] = [];
  for (const [scenarioIndex, scenario] of loaded.scenarios.entries()) {
    emitEvent(hooks, {
      type: "scenario_started",
      timestamp: new Date().toISOString(),
      runId,
      scenarioId: scenario.id,
      scenarioIndex: scenarioIndex + 1,
      totalScenarios: loaded.scenarios.length,
    });

    const execution = await runScenarioWithSampling(
      paths,
      scenario,
      effective,
      (sample, runIndex, phase, totalRuns) => {
        emitEvent(hooks, {
          type: "sample_completed",
          timestamp: new Date().toISOString(),
          runId,
          scenarioId: scenario.id,
          scenarioIndex: scenarioIndex + 1,
          totalScenarios: loaded.scenarios.length,
          runIndex,
          totalRuns,
          phase,
          sample,
        });
      },
      (exchange, runIndex, phase, totalRuns) => {
        emitEvent(hooks, {
          type: "exchange",
          timestamp: new Date().toISOString(),
          runId,
          scenarioId: scenario.id,
          scenarioIndex: scenarioIndex + 1,
          totalScenarios: loaded.scenarios.length,
          runIndex,
          totalRuns,
          phase,
          exchange,
        });
      }
    );
    warnings.push(...execution.warnings);
    for (const warning of execution.warnings) {
      emitEvent(hooks, {
        type: "warning",
        timestamp: new Date().toISOString(),
        runId,
        scenarioId: scenario.id,
        scenarioIndex: scenarioIndex + 1,
        totalScenarios: loaded.scenarios.length,
        warning,
      });
    }
    emitEvent(hooks, {
      type: "scenario_completed",
      timestamp: new Date().toISOString(),
      runId,
      scenarioId: scenario.id,
      scenarioIndex: scenarioIndex + 1,
      totalScenarios: loaded.scenarios.length,
      result: execution.result,
    });
    executions.push(execution);
  }

  const reportBase = buildReport(effective, warnings, loaded.scenarioPath, executions, runId);
  const gateResults = await evaluateGates(reportBase, effective);
  const report: BenchmarkReport = {
    ...reportBase,
    gateResults,
  };

  const artifacts = await writeBenchmarkArtifacts(paths, report, effective.run.outPath);

  await disconnectAllServers();

  emitEvent(hooks, {
    type: "run_completed",
    timestamp: new Date().toISOString(),
    runId: report.id,
    summary: {
      total: report.total,
      executed: report.executed,
      succeeded: report.succeeded,
      failed: report.failed,
      successRate: report.successRate,
    },
  });

  return {
    report,
    artifactPath: artifacts.jsonPath,
    textArtifactPath: artifacts.textPath,
  };
}

async function loadScenarios(effective: EffectiveBenchmarkConfig): Promise<{
  scenarios: BenchmarkScenario[];
  warnings: string[];
  scenarioPath?: string;
}> {
  const allScenarios: BenchmarkScenario[] = [];
  const warnings: string[] = [];

  if (effective.run.suite) {
    allScenarios.push(...builtInSuite(effective.run.suite));
  }

  if (effective.run.scenarioPath) {
    const filePath = path.resolve(effective.run.scenarioPath);
    const fromFile = await loadScenarioFile(filePath);
    const validated = validateScenarioCollection(fromFile, filePath);
    allScenarios.push(...validated.scenarios);
    warnings.push(...validated.warnings);
  }

  ensureUniqueScenarioIds(allScenarios);

  return {
    scenarios: allScenarios,
    warnings,
    scenarioPath: effective.run.scenarioPath ? path.resolve(effective.run.scenarioPath) : undefined,
  };
}

async function loadScenarioFile(filePath: string): Promise<unknown[]> {
  const raw = await fs.readFile(filePath, "utf8");
  const ext = path.extname(filePath).toLowerCase();

  if (ext === ".jsonl") {
    const rows = raw
      .split("\n")
      .map((line, index) => ({ line: line.trim(), lineNumber: index + 1 }))
      .filter((entry) => entry.line.length > 0);

    return rows.map((entry) => {
      try {
        return JSON.parse(entry.line) as unknown;
      } catch (error) {
        throw new Error(
          `Failed to parse scenario JSONL ${filePath}:${entry.lineNumber}: ${(error as Error).message}`
        );
      }
    });
  }

  if (ext === ".yaml" || ext === ".yml") {
    let parsed: unknown;
    try {
      parsed = YAML.parse(raw) as unknown;
    } catch (error) {
      throw new Error(`Failed to parse YAML scenario file ${filePath}: ${(error as Error).message}`);
    }
    return extractScenarioArray(parsed, filePath);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error(`Failed to parse JSON scenario file ${filePath}: ${(error as Error).message}`);
  }
  return extractScenarioArray(parsed, filePath);
}

function extractScenarioArray(parsed: unknown, source: string): unknown[] {
  if (Array.isArray(parsed)) {
    return parsed;
  }

  if (
    parsed &&
    typeof parsed === "object" &&
    Array.isArray((parsed as { scenarios?: unknown[] }).scenarios)
  ) {
    return (parsed as { scenarios: unknown[] }).scenarios;
  }

  throw new Error(`${source}: scenario file must be an array or an object with 'scenarios' array.`);
}

function ensureUniqueScenarioIds(scenarios: BenchmarkScenario[]): void {
  const ids = new Set<string>();
  for (const scenario of scenarios) {
    if (ids.has(scenario.id)) {
      throw new Error(`Scenario ID '${scenario.id}' is duplicated.`);
    }
    ids.add(scenario.id);
  }
}

async function runScenarioWithSampling(
  paths: StoragePaths,
  scenario: BenchmarkScenario,
  effective: EffectiveBenchmarkConfig,
  onSampleComplete?: (
    sample: ScenarioRunSample,
    runIndex: number,
    phase: "warmup" | "measured",
    totalRuns: number
  ) => void,
  onExchange?: (
    event: BenchmarkExchangeEvent,
    runIndex: number,
    phase: "warmup" | "measured",
    totalRuns: number
  ) => void
): Promise<ScenarioExecution> {
  const warnings: string[] = [];
  const model =
    effective.run.modelOverride ||
    scenario.model ||
    (await pickBestModelForScenario(paths, scenario));

  if (!model) {
    const reason = `No model available for mode '${scenario.mode}'.`;
    warnings.push(`Scenario '${scenario.id}' skipped: ${reason}`);
    return {
      result: buildSkippedScenarioResult(scenario, reason),
      samples: [],
      warnings,
    };
  }

  const totalRuns =
    effective.profileSettings.warmupRuns + effective.profileSettings.measuredRuns;
  const measuredSamples: ScenarioRunSample[] = [];

  for (let index = 0; index < totalRuns; index++) {
    const phase = index < effective.profileSettings.warmupRuns ? "warmup" : "measured";
    const runIndex = index + 1;
    const sample = await runSingleScenario(
      paths,
      scenario,
      model,
      effective,
      runIndex,
      (event) => onExchange?.(event, runIndex, phase, totalRuns)
    );
    onSampleComplete?.(sample, index + 1, phase, totalRuns);
    if (index >= effective.profileSettings.warmupRuns) {
      measuredSamples.push(sample);
    }
  }

  return {
    result: buildScenarioResult(
      scenario,
      model,
      measuredSamples,
      effective.profileSettings.minScenarioPassRate
    ),
    samples: measuredSamples,
    warnings,
  };
}

async function pickBestModelForScenario(
  paths: StoragePaths,
  scenario: BenchmarkScenario
): Promise<string | null> {
  const requirements = getModeRequirements(scenario.mode);
  return pickBestModelByCapabilities(
    paths,
    {
      requiredInput: requirements.requiredInput,
      requiredOutput: requirements.requiredOutput,
    },
    requirements.preferredEndpointType
  );
}

function getModeRequirements(mode: BenchmarkMode): BenchmarkModeRequirements {
  switch (mode) {
    case "chat":
    case "agent":
      return { requiredInput: ["text"], requiredOutput: ["text"], preferredEndpointType: "llm" };
    case "embeddings":
      return { requiredInput: ["text"], requiredOutput: ["embedding"], preferredEndpointType: "embedding" };
    case "image_generation":
      return { requiredInput: ["text"], requiredOutput: ["image"], preferredEndpointType: "diffusion" };
    case "audio_transcription":
      return { requiredInput: ["audio"], requiredOutput: ["text"], preferredEndpointType: "audio" };
    case "audio_speech":
      return { requiredInput: ["text"], requiredOutput: ["audio"], preferredEndpointType: "audio" };
    case "omni_call":
      return { requiredInput: ["text", "audio"], requiredOutput: ["text"], preferredEndpointType: "llm" };
  }
}

async function runSingleScenario(
  paths: StoragePaths,
  scenario: BenchmarkScenario,
  model: string,
  effective: EffectiveBenchmarkConfig,
  runIndex: number,
  onExchange?: ScenarioExchangeCallback
): Promise<ScenarioRunSample> {
  const startTime = Date.now();

  try {
    const sample = await runModeScenario(paths, scenario, model, effective, startTime, onExchange);
    return { ...sample, runIndex };
  } catch (error) {
    const latencyMs = Date.now() - startTime;
    return {
      runIndex,
      success: false,
      latencyMs,
      statusCode: 0,
      tokens: 0,
      toolCalls: 0,
      throughputTokensPerSec: 0,
      outputPreview: "",
      error: (error as Error).message,
      candidateAttempts: 0,
      failovers: 0,
      rateLimitSwitches: 0,
      distinctProviders: 0,
      distinctModels: 0,
    };
  }
}

async function runModeScenario(
  paths: StoragePaths,
  scenario: BenchmarkScenario,
  model: string,
  effective: EffectiveBenchmarkConfig,
  startTime: number,
  onExchange?: ScenarioExchangeCallback
): Promise<Omit<ScenarioRunSample, "runIndex">> {
  switch (scenario.mode) {
    case "chat":
      return runChatScenario(paths, scenario, model, effective, startTime, onExchange);
    case "agent":
      return runAgentScenario(paths, scenario, model, effective, startTime, onExchange);
    case "embeddings":
      return runEmbeddingsScenario(paths, scenario, model, effective, startTime, onExchange);
    case "image_generation":
      return runImageScenario(paths, scenario, model, effective, startTime, onExchange);
    case "audio_transcription":
      return runAudioTranscriptionScenario(paths, scenario, model, effective, startTime, onExchange);
    case "audio_speech":
      return runAudioSpeechScenario(paths, scenario, model, effective, startTime, onExchange);
    case "omni_call":
      return runOmniCallScenario(paths, scenario, model, effective, startTime, onExchange);
  }
}

async function runChatScenario(
  paths: StoragePaths,
  scenario: BenchmarkScenario,
  model: string,
  effective: EffectiveBenchmarkConfig,
  startTime: number,
  onExchange?: ScenarioExchangeCallback
): Promise<Omit<ScenarioRunSample, "runIndex">> {
  const timeoutMs = scenario.timeoutMs ?? effective.defaults.requestTimeoutMs;
  const payload: Record<string, unknown> = {
    model,
    messages: [{ role: "user", content: scenario.prompt }],
    stream: false,
    temperature: scenario.temperature ?? effective.defaults.temperature,
    max_tokens: scenario.max_tokens ?? effective.defaults.max_tokens,
  };

  const envelope = await requestJson(
    paths,
    model,
    "/v1/chat/completions",
    payload,
    timeoutMs,
    getModeRequirements("chat")
  );
  onExchange?.(
    buildExchangeEvent({
      mode: "chat",
      model,
      requestPath: "/v1/chat/completions",
      requestPayload: envelope.requestPayload,
      responsePayload: envelope.payload,
      statusCode: envelope.statusCode,
      contentType: envelope.contentType,
    })
  );

  const response = (envelope.payload as ChatResponse) ?? {};
  const output = parseAssistantContent(response);
  const tokens = Number(response.usage?.total_tokens ?? 0);
  const latencyMs = Date.now() - startTime;

  const assertionError = evaluateAssertions(scenario, {
    output,
    toolCalls: 0,
    latencyMs,
    statusCode: envelope.statusCode,
  });

  return {
    success: !assertionError,
    latencyMs,
    statusCode: envelope.statusCode,
    tokens,
    toolCalls: 0,
    throughputTokensPerSec: calculateThroughput(tokens, latencyMs),
    outputPreview: truncate(output, 180),
    error: assertionError ?? undefined,
    candidateAttempts: envelope.poolMetrics?.candidateAttempts ?? 0,
    failovers: envelope.poolMetrics?.failovers ?? 0,
    rateLimitSwitches: envelope.poolMetrics?.rateLimitSwitches ?? 0,
    distinctProviders: envelope.poolMetrics?.distinctProviders ?? 0,
    distinctModels: envelope.poolMetrics?.distinctModels ?? 0,
  };
}

async function runAgentScenario(
  paths: StoragePaths,
  scenario: BenchmarkScenario,
  model: string,
  effective: EffectiveBenchmarkConfig,
  startTime: number,
  onExchange?: ScenarioExchangeCallback
): Promise<Omit<ScenarioRunSample, "runIndex">> {
  const selectedTools = getSelectedTools(scenario.tools);
  const messages: Array<Record<string, unknown>> = [{ role: "user", content: scenario.prompt }];
  const maxIterations = scenario.maxIterations ?? effective.defaults.maxIterations;
  const timeoutMs = scenario.timeoutMs ?? effective.defaults.requestTimeoutMs;
  const toolTimeoutMs = effective.defaults.toolTimeoutMs;

  let toolCalls = 0;
  let totalTokens = 0;
  let finalOutput = "";
  let statusCode = 200;
  let reachedIterationCap = true;
  let candidateAttempts = 0;
  let failovers = 0;
  let rateLimitSwitches = 0;
  let distinctProviders = 0;
  let distinctModels = 0;

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    const payload: Record<string, unknown> = {
      model,
      messages,
      stream: false,
      temperature: scenario.temperature ?? effective.defaults.temperature,
      max_tokens: scenario.max_tokens ?? effective.defaults.max_tokens,
    };

    if (selectedTools.length > 0) {
      payload.tools = selectedTools.map((tool) => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description ?? "",
          parameters: tool.inputSchema,
        },
      }));
      payload.tool_choice = "auto";
    }

    const envelope = await requestJson(
      paths,
      model,
      "/v1/chat/completions",
      payload,
      timeoutMs,
      getModeRequirements("agent")
    );
    onExchange?.(
      buildExchangeEvent({
        mode: "agent",
        model,
        requestPath: "/v1/chat/completions",
        requestPayload: envelope.requestPayload,
        responsePayload: envelope.payload,
        statusCode: envelope.statusCode,
        contentType: envelope.contentType,
      })
    );

    statusCode = envelope.statusCode;
    const response = (envelope.payload as ChatResponse) ?? {};
    totalTokens += Number(response.usage?.total_tokens ?? 0);
    candidateAttempts += envelope.poolMetrics?.candidateAttempts ?? 0;
    failovers += envelope.poolMetrics?.failovers ?? 0;
    rateLimitSwitches += envelope.poolMetrics?.rateLimitSwitches ?? 0;
    distinctProviders = Math.max(distinctProviders, envelope.poolMetrics?.distinctProviders ?? 0);
    distinctModels = Math.max(distinctModels, envelope.poolMetrics?.distinctModels ?? 0);

    const assistantMessage = response.choices?.[0]?.message;
    const assistantContent = parseMessageContent(assistantMessage?.content);
    finalOutput = assistantContent || finalOutput;
    const toolCallList = Array.isArray(assistantMessage?.tool_calls)
      ? assistantMessage.tool_calls
      : [];

    if (toolCallList.length === 0) {
      messages.push({ role: "assistant", content: assistantContent });
      reachedIterationCap = false;
      break;
    }

    messages.push({
      role: "assistant",
      content: assistantContent || null,
      tool_calls: toolCallList,
    });

    for (const call of toolCallList) {
      const name = call.function?.name;
      if (!name) {
        throw new Error(`Scenario ${scenario.id}: tool call is missing function.name.`);
      }

      let args: Record<string, unknown> = {};
      const rawArguments = call.function?.arguments;
      if (rawArguments && rawArguments.trim().length > 0) {
        try {
          args = JSON.parse(rawArguments) as Record<string, unknown>;
        } catch {
          throw new Error(`Scenario ${scenario.id}: invalid tool arguments for ${name}.`);
        }
      }

      const result = await withTimeout(
        executeTool(name, args),
        toolTimeoutMs,
        `Tool execution timed out for ${name} after ${toolTimeoutMs}ms`
      );

      toolCalls += 1;
      messages.push({
        role: "tool",
        tool_call_id: call.id ?? `tool-${iteration + 1}-${toolCalls}`,
        content: result.content,
      });
    }
  }

  const latencyMs = Date.now() - startTime;
  const capError = reachedIterationCap ? "max_iterations_reached" : null;
  const assertionError = evaluateAssertions(scenario, {
    output: finalOutput,
    toolCalls,
    latencyMs,
    statusCode,
  });
  const error = capError ?? assertionError;

  return {
    success: !error,
    latencyMs,
    statusCode,
    tokens: totalTokens,
    toolCalls,
    throughputTokensPerSec: calculateThroughput(totalTokens, latencyMs),
    outputPreview: truncate(finalOutput, 180),
    error: error ?? undefined,
    candidateAttempts,
    failovers,
    rateLimitSwitches,
    distinctProviders,
    distinctModels,
  };
}

async function runEmbeddingsScenario(
  paths: StoragePaths,
  scenario: BenchmarkScenario,
  model: string,
  effective: EffectiveBenchmarkConfig,
  startTime: number,
  onExchange?: ScenarioExchangeCallback
): Promise<Omit<ScenarioRunSample, "runIndex">> {
  const timeoutMs = scenario.timeoutMs ?? effective.defaults.requestTimeoutMs;
  const payload: Record<string, unknown> = {
    model,
    input: scenario.input,
  };

  const envelope = await requestJson(
    paths,
    model,
    "/v1/embeddings",
    payload,
    timeoutMs,
    getModeRequirements("embeddings")
  );
  onExchange?.(
    buildExchangeEvent({
      mode: "embeddings",
      model,
      requestPath: "/v1/embeddings",
      requestPayload: envelope.requestPayload,
      responsePayload: envelope.payload,
      statusCode: envelope.statusCode,
      contentType: envelope.contentType,
    })
  );

  const response = envelope.payload as {
    data?: Array<{ embedding?: number[] }>;
    usage?: { total_tokens?: number };
  };

  const data = Array.isArray(response?.data) ? response.data : [];
  const firstVectorLength = Array.isArray(data[0]?.embedding) ? data[0].embedding.length : 0;
  const text = `items=${data.length},vectorLength=${firstVectorLength}`;
  const tokens = Number(response?.usage?.total_tokens ?? 0);
  const latencyMs = Date.now() - startTime;

  const assertionError = evaluateAssertions(scenario, {
    output: text,
    toolCalls: 0,
    latencyMs,
    statusCode: envelope.statusCode,
    embeddingsItems: data.length,
    embeddingsVectorLength: firstVectorLength,
  });

  return {
    success: !assertionError,
    latencyMs,
    statusCode: envelope.statusCode,
    tokens,
    toolCalls: 0,
    throughputTokensPerSec: calculateThroughput(tokens, latencyMs),
    outputPreview: truncate(text, 180),
    error: assertionError ?? undefined,
    candidateAttempts: envelope.poolMetrics?.candidateAttempts ?? 0,
    failovers: envelope.poolMetrics?.failovers ?? 0,
    rateLimitSwitches: envelope.poolMetrics?.rateLimitSwitches ?? 0,
    distinctProviders: envelope.poolMetrics?.distinctProviders ?? 0,
    distinctModels: envelope.poolMetrics?.distinctModels ?? 0,
  };
}

async function runImageScenario(
  paths: StoragePaths,
  scenario: BenchmarkScenario,
  model: string,
  effective: EffectiveBenchmarkConfig,
  startTime: number,
  onExchange?: ScenarioExchangeCallback
): Promise<Omit<ScenarioRunSample, "runIndex">> {
  const timeoutMs = scenario.timeoutMs ?? effective.defaults.requestTimeoutMs;
  const payload: Record<string, unknown> = {
    model,
    prompt: scenario.prompt,
    n: scenario.n,
    size: scenario.size,
  };

  const envelope = await requestJson(
    paths,
    model,
    "/v1/images/generations",
    payload,
    timeoutMs,
    getModeRequirements("image_generation")
  );
  onExchange?.(
    buildExchangeEvent({
      mode: "image_generation",
      model,
      requestPath: "/v1/images/generations",
      requestPayload: envelope.requestPayload,
      responsePayload: envelope.payload,
      statusCode: envelope.statusCode,
      contentType: envelope.contentType,
    })
  );

  const response = envelope.payload as { data?: Array<{ url?: string; b64_json?: string }> };
  const images = Array.isArray(response?.data) ? response.data : [];
  const text = `images=${images.length}`;
  const latencyMs = Date.now() - startTime;

  const assertionError = evaluateAssertions(scenario, {
    output: text,
    toolCalls: 0,
    latencyMs,
    statusCode: envelope.statusCode,
    imagesCount: images.length,
  });

  return {
    success: !assertionError,
    latencyMs,
    statusCode: envelope.statusCode,
    tokens: 0,
    toolCalls: 0,
    throughputTokensPerSec: 0,
    outputPreview: truncate(text, 180),
    error: assertionError ?? undefined,
    candidateAttempts: envelope.poolMetrics?.candidateAttempts ?? 0,
    failovers: envelope.poolMetrics?.failovers ?? 0,
    rateLimitSwitches: envelope.poolMetrics?.rateLimitSwitches ?? 0,
    distinctProviders: envelope.poolMetrics?.distinctProviders ?? 0,
    distinctModels: envelope.poolMetrics?.distinctModels ?? 0,
  };
}

async function runAudioTranscriptionScenario(
  paths: StoragePaths,
  scenario: BenchmarkScenario,
  model: string,
  effective: EffectiveBenchmarkConfig,
  startTime: number,
  onExchange?: ScenarioExchangeCallback
): Promise<Omit<ScenarioRunSample, "runIndex">> {
  const timeoutMs = scenario.timeoutMs ?? effective.defaults.requestTimeoutMs;
  const audioPath = path.resolve(scenario.audioFile as string);
  const audioBuffer = await fs.readFile(audioPath);

  const payload: Record<string, unknown> = {
    model,
    file: audioBuffer.toString("base64"),
    response_format: "json",
  };

  const envelope = await requestJson(
    paths,
    model,
    "/v1/audio/transcriptions",
    payload,
    timeoutMs,
    getModeRequirements("audio_transcription")
  );
  onExchange?.(
    buildExchangeEvent({
      mode: "audio_transcription",
      model,
      requestPath: "/v1/audio/transcriptions",
      requestPayload: envelope.requestPayload,
      responsePayload: envelope.payload,
      statusCode: envelope.statusCode,
      contentType: envelope.contentType,
    })
  );

  const response = envelope.payload as { text?: string };
  const text = response?.text ?? "";
  const latencyMs = Date.now() - startTime;

  const assertionError = evaluateAssertions(scenario, {
    output: text,
    toolCalls: 0,
    latencyMs,
    statusCode: envelope.statusCode,
  });

  return {
    success: !assertionError,
    latencyMs,
    statusCode: envelope.statusCode,
    tokens: 0,
    toolCalls: 0,
    throughputTokensPerSec: 0,
    outputPreview: truncate(text, 180),
    error: assertionError ?? undefined,
    candidateAttempts: envelope.poolMetrics?.candidateAttempts ?? 0,
    failovers: envelope.poolMetrics?.failovers ?? 0,
    rateLimitSwitches: envelope.poolMetrics?.rateLimitSwitches ?? 0,
    distinctProviders: envelope.poolMetrics?.distinctProviders ?? 0,
    distinctModels: envelope.poolMetrics?.distinctModels ?? 0,
  };
}

async function runAudioSpeechScenario(
  paths: StoragePaths,
  scenario: BenchmarkScenario,
  model: string,
  effective: EffectiveBenchmarkConfig,
  startTime: number,
  onExchange?: ScenarioExchangeCallback
): Promise<Omit<ScenarioRunSample, "runIndex">> {
  const timeoutMs = scenario.timeoutMs ?? effective.defaults.requestTimeoutMs;
  const payload: Record<string, unknown> = {
    model,
    input: scenario.inputText,
    voice: scenario.voice,
    response_format: scenario.response_format,
  };

  const envelope = await requestBinary(
    paths,
    model,
    "/v1/audio/speech",
    payload,
    timeoutMs,
    getModeRequirements("audio_speech")
  );
  onExchange?.(
    buildExchangeEvent({
      mode: "audio_speech",
      model,
      requestPath: "/v1/audio/speech",
      requestPayload: envelope.requestPayload,
      responsePayload: {
        bytes: envelope.buffer.length,
      },
      statusCode: envelope.statusCode,
      contentType: envelope.contentType,
    })
  );

  const latencyMs = Date.now() - startTime;
  const output = `bytes=${envelope.buffer.length}`;
  const assertionError = evaluateAssertions(scenario, {
    output,
    toolCalls: 0,
    latencyMs,
    statusCode: envelope.statusCode,
    bytesLength: envelope.buffer.length,
    contentType: envelope.contentType,
  });

  return {
    success: !assertionError,
    latencyMs,
    statusCode: envelope.statusCode,
    tokens: 0,
    toolCalls: 0,
    throughputTokensPerSec: 0,
    outputPreview: truncate(output, 180),
    error: assertionError ?? undefined,
    candidateAttempts: envelope.poolMetrics?.candidateAttempts ?? 0,
    failovers: envelope.poolMetrics?.failovers ?? 0,
    rateLimitSwitches: envelope.poolMetrics?.rateLimitSwitches ?? 0,
    distinctProviders: envelope.poolMetrics?.distinctProviders ?? 0,
    distinctModels: envelope.poolMetrics?.distinctModels ?? 0,
  };
}

async function runOmniCallScenario(
  paths: StoragePaths,
  scenario: BenchmarkScenario,
  model: string,
  effective: EffectiveBenchmarkConfig,
  startTime: number,
  onExchange?: ScenarioExchangeCallback
): Promise<Omit<ScenarioRunSample, "runIndex">> {
  const timeoutMs = scenario.timeoutMs ?? effective.defaults.requestTimeoutMs;
  const audioPath = path.resolve(scenario.audioFile as string);
  const audioBuffer = await fs.readFile(audioPath);
  const audioFormat = audioFormatFromFile(audioPath);

  const payload: Record<string, unknown> = {
    model,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "input_audio",
            input_audio: {
              data: audioBuffer.toString("base64"),
              format: audioFormat,
            },
          },
          {
            type: "text",
            text:
              scenario.prompt ??
              "Summarize this audio briefly and answer as transcript text.",
          },
        ],
      },
    ],
    stream: false,
    temperature: scenario.temperature ?? effective.defaults.temperature,
    max_tokens: scenario.max_tokens ?? effective.defaults.max_tokens,
  };

  const envelope = await requestJson(
    paths,
    model,
    "/v1/chat/completions",
    payload,
    timeoutMs,
    getModeRequirements("omni_call")
  );
  onExchange?.(
    buildExchangeEvent({
      mode: "omni_call",
      model,
      requestPath: "/v1/chat/completions",
      requestPayload: envelope.requestPayload,
      responsePayload: envelope.payload,
      statusCode: envelope.statusCode,
      contentType: envelope.contentType,
    })
  );

  const response = (envelope.payload as ChatResponse) ?? {};
  const output = parseAssistantContent(response);
  const tokens = Number(response.usage?.total_tokens ?? 0);
  const audioOutputPresent = responseHasAudioOutput(response);
  const latencyMs = Date.now() - startTime;

  const assertionError = evaluateAssertions(scenario, {
    output,
    toolCalls: 0,
    latencyMs,
    statusCode: envelope.statusCode,
  });

  return {
    success: !assertionError,
    latencyMs,
    statusCode: envelope.statusCode,
    tokens,
    toolCalls: 0,
    throughputTokensPerSec: calculateThroughput(tokens, latencyMs),
    outputPreview: truncate(`${output}\naudio_output=${audioOutputPresent ? "yes" : "no"}`, 180),
    error: assertionError ?? undefined,
    candidateAttempts: envelope.poolMetrics?.candidateAttempts ?? 0,
    failovers: envelope.poolMetrics?.failovers ?? 0,
    rateLimitSwitches: envelope.poolMetrics?.rateLimitSwitches ?? 0,
    distinctProviders: envelope.poolMetrics?.distinctProviders ?? 0,
    distinctModels: envelope.poolMetrics?.distinctModels ?? 0,
    audioOutputPresent,
  };
}

function audioFormatFromFile(filePath: string): string {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  if (ext === "mp3") return "mp3";
  if (ext === "wav") return "wav";
  if (ext === "ogg") return "ogg";
  if (ext === "m4a" || ext === "mp4") return "m4a";
  if (ext === "webm") return "webm";
  return "wav";
}

function responseHasAudioOutput(response: ChatResponse): boolean {
  const message = response.choices?.[0]?.message;
  if (!message || typeof message !== "object") {
    return false;
  }
  const directAudio = (message as { audio?: unknown }).audio;
  if (directAudio && typeof directAudio === "object") {
    const audio = directAudio as { url?: unknown; data?: unknown };
    if (typeof audio.url === "string" || typeof audio.data === "string") {
      return true;
    }
  }

  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return false;
  }
  for (const part of content) {
    if (!part || typeof part !== "object") {
      continue;
    }
    const typed = part as { type?: unknown; audio?: unknown };
    if (typed.type !== "audio" && typed.type !== "output_audio") {
      continue;
    }
    if (!typed.audio || typeof typed.audio !== "object") {
      continue;
    }
    const audio = typed.audio as { url?: unknown; data?: unknown };
    if (typeof audio.url === "string" || typeof audio.data === "string") {
      return true;
    }
  }
  return false;
}

async function requestJson(
  paths: StoragePaths,
  model: string,
  requestPath: string,
  payload: Record<string, unknown>,
  timeoutMs: number,
  requirements: BenchmarkModeRequirements
): Promise<JsonResponseEnvelope> {
  const requestPayload = JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;
  const outcome = await routeRequest(
    paths,
    model,
    requestPath,
    requestPayload,
    {},
    AbortSignal.timeout(timeoutMs),
    {
      endpointType: requirements.preferredEndpointType,
      requiredInput: requirements.requiredInput,
      requiredOutput: requirements.requiredOutput,
    }
  );

  const { buffer, contentType } = await readBody(outcome.attempt.response.body, outcome.attempt.response.headers);
  const payloadData = parseJson(buffer);
  return {
    statusCode: outcome.attempt.response.statusCode,
    payload: payloadData,
    contentType,
    requestPayload,
    poolMetrics: outcome.attempt.pool,
  };
}

async function requestBinary(
  paths: StoragePaths,
  model: string,
  requestPath: string,
  payload: Record<string, unknown>,
  timeoutMs: number,
  requirements: BenchmarkModeRequirements
): Promise<BinaryResponseEnvelope> {
  const requestPayload = JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;
  const outcome = await routeRequest(
    paths,
    model,
    requestPath,
    requestPayload,
    {},
    AbortSignal.timeout(timeoutMs),
    {
      endpointType: requirements.preferredEndpointType,
      requiredInput: requirements.requiredInput,
      requiredOutput: requirements.requiredOutput,
    }
  );

  const { buffer, contentType } = await readBody(outcome.attempt.response.body, outcome.attempt.response.headers);
  return {
    statusCode: outcome.attempt.response.statusCode,
    buffer,
    contentType,
    requestPayload,
    poolMetrics: outcome.attempt.pool,
  };
}

async function readBody(
  stream: NodeJS.ReadableStream,
  headers: Record<string, string | string[]>
): Promise<{ buffer: Buffer; contentType: string }> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const buffer = Buffer.concat(chunks);
  const contentTypeHeader = headers["content-type"] ?? headers["Content-Type"];
  const contentType = Array.isArray(contentTypeHeader)
    ? contentTypeHeader.join(", ")
    : (contentTypeHeader ?? "");

  return { buffer, contentType };
}

function parseJson(buffer: Buffer): unknown {
  const text = buffer.toString("utf8").trim();
  if (!text) {
    return {};
  }
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function getSelectedTools(requestedNames?: string[]) {
  const tools = getCachedTools();
  if (!requestedNames || requestedNames.length === 0) {
    return tools;
  }
  const requested = new Set(requestedNames);
  return tools.filter((tool) => requested.has(tool.name));
}

function parseAssistantContent(response: ChatResponse): string {
  const content = response.choices?.[0]?.message?.content;
  return parseMessageContent(content);
}

function parseMessageContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    const parts = content
      .map((part) => {
        if (typeof part === "string") {
          return part;
        }
        if (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") {
          return (part as { text: string }).text;
        }
        return "";
      })
      .filter((part) => part.length > 0);
    return parts.join("\n");
  }
  return "";
}

interface AssertionRuntime {
  output: string;
  toolCalls: number;
  latencyMs: number;
  statusCode: number;
  embeddingsItems?: number;
  embeddingsVectorLength?: number;
  imagesCount?: number;
  bytesLength?: number;
  contentType?: string;
}

function evaluateAssertions(scenario: BenchmarkScenario, runtime: AssertionRuntime): string | null {
  const assertions = scenario.assertions;

  for (const required of assertions.contains ?? []) {
    if (!runtime.output.includes(required)) {
      return `Assertion failed: output must include '${required}'.`;
    }
  }

  for (const forbidden of assertions.notContains ?? []) {
    if (runtime.output.includes(forbidden)) {
      return `Assertion failed: output must not include '${forbidden}'.`;
    }
  }

  if (typeof assertions.minToolCalls === "number" && runtime.toolCalls < assertions.minToolCalls) {
    return `Assertion failed: expected at least ${assertions.minToolCalls} tool calls, got ${runtime.toolCalls}.`;
  }

  if (typeof assertions.maxToolCalls === "number" && runtime.toolCalls > assertions.maxToolCalls) {
    return `Assertion failed: expected at most ${assertions.maxToolCalls} tool calls, got ${runtime.toolCalls}.`;
  }

  if (typeof assertions.maxLatencyMs === "number" && runtime.latencyMs > assertions.maxLatencyMs) {
    return `Assertion failed: latency ${runtime.latencyMs}ms exceeded ${assertions.maxLatencyMs}ms.`;
  }

  if (runtime.statusCode !== assertions.statusCode) {
    return `Assertion failed: expected status ${assertions.statusCode}, got ${runtime.statusCode}.`;
  }

  if (typeof assertions.minItems === "number") {
    const items = runtime.embeddingsItems ?? 0;
    if (items < assertions.minItems) {
      return `Assertion failed: expected at least ${assertions.minItems} embeddings, got ${items}.`;
    }
  }

  if (typeof assertions.minVectorLength === "number") {
    const vectorLength = runtime.embeddingsVectorLength ?? 0;
    if (vectorLength < assertions.minVectorLength) {
      return `Assertion failed: expected vector length >= ${assertions.minVectorLength}, got ${vectorLength}.`;
    }
  }

  if (typeof assertions.minImages === "number") {
    const images = runtime.imagesCount ?? 0;
    if (images < assertions.minImages) {
      return `Assertion failed: expected at least ${assertions.minImages} images, got ${images}.`;
    }
  }

  for (const text of assertions.containsText ?? []) {
    if (!runtime.output.includes(text)) {
      return `Assertion failed: transcription must include '${text}'.`;
    }
  }

  for (const text of assertions.notContainsText ?? []) {
    if (runtime.output.includes(text)) {
      return `Assertion failed: transcription must not include '${text}'.`;
    }
  }

  if (typeof assertions.minBytes === "number") {
    const bytes = runtime.bytesLength ?? 0;
    if (bytes < assertions.minBytes) {
      return `Assertion failed: expected at least ${assertions.minBytes} bytes, got ${bytes}.`;
    }
  }

  if (assertions.contentType) {
    const contentType = runtime.contentType ?? "";
    if (!contentType.toLowerCase().includes(assertions.contentType.toLowerCase())) {
      return `Assertion failed: expected content type to include '${assertions.contentType}', got '${contentType}'.`;
    }
  }

  return null;
}

function buildSkippedScenarioResult(
  scenario: BenchmarkScenario,
  reason: string
): ScenarioResult {
  return {
    id: scenario.id,
    mode: scenario.mode,
    model: scenario.model ?? "unresolved",
    status: "skipped",
    success: true,
    skippedReason: reason,
    passRate: 1,
    passedRuns: 0,
    failedRuns: 0,
    avgLatencyMs: 0,
    p50LatencyMs: 0,
    p95LatencyMs: 0,
    p99LatencyMs: 0,
    totalTokens: 0,
    totalToolCalls: 0,
    avgThroughputTokensPerSec: 0,
    candidateAttempts: 0,
    failovers: 0,
    rateLimitSwitches: 0,
    distinctProviders: 0,
    distinctModels: 0,
    errorReasons: [],
    outputPreview: "",
    audioOutputRuns: 0,
  };
}

function buildScenarioResult(
  scenario: BenchmarkScenario,
  model: string,
  samples: ScenarioRunSample[],
  minScenarioPassRate: number
): ScenarioResult {
  const latencies = samples.map((sample) => sample.latencyMs).sort((a, b) => a - b);
  const passedRuns = samples.filter((sample) => sample.success).length;
  const failedRuns = samples.length - passedRuns;
  const totalTokens = samples.reduce((sum, sample) => sum + sample.tokens, 0);
  const totalToolCalls = samples.reduce((sum, sample) => sum + sample.toolCalls, 0);
  const passRate = samples.length > 0 ? passedRuns / samples.length : 0;
  const candidateAttempts = samples.reduce((sum, sample) => sum + (sample.candidateAttempts ?? 0), 0);
  const failovers = samples.reduce((sum, sample) => sum + (sample.failovers ?? 0), 0);
  const rateLimitSwitches = samples.reduce((sum, sample) => sum + (sample.rateLimitSwitches ?? 0), 0);
  const distinctProviders = samples.reduce((max, sample) => Math.max(max, sample.distinctProviders ?? 0), 0);
  const distinctModels = samples.reduce((max, sample) => Math.max(max, sample.distinctModels ?? 0), 0);
  const audioOutputRuns = samples.reduce((sum, sample) => sum + (sample.audioOutputPresent ? 1 : 0), 0);
  const avgLatencyMs =
    latencies.length > 0
      ? Math.round(latencies.reduce((sum, value) => sum + value, 0) / latencies.length)
      : 0;
  const avgThroughputTokensPerSec =
    samples.length > 0
      ? samples.reduce((sum, sample) => sum + sample.throughputTokensPerSec, 0) / samples.length
      : 0;

  const failureReasonCounts = new Map<string, number>();
  for (const sample of samples) {
    if (!sample.error) {
      continue;
    }
    failureReasonCounts.set(sample.error, (failureReasonCounts.get(sample.error) ?? 0) + 1);
  }

  const errorReasons = [...failureReasonCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([reason, count]) => `${reason} (${count})`);

  const outputPreview =
    [...samples].reverse().find((sample) => sample.outputPreview)?.outputPreview ?? "";

  const status = passRate >= minScenarioPassRate ? "passed" : "failed";

  return {
    id: scenario.id,
    mode: scenario.mode,
    model,
    status,
    success: status === "passed",
    passRate: Number(passRate.toFixed(4)),
    passedRuns,
    failedRuns,
    avgLatencyMs,
    p50LatencyMs: percentile(latencies, 50),
    p95LatencyMs: percentile(latencies, 95),
    p99LatencyMs: percentile(latencies, 99),
    totalTokens,
    totalToolCalls,
    avgThroughputTokensPerSec: Number(avgThroughputTokensPerSec.toFixed(3)),
    candidateAttempts,
    failovers,
    rateLimitSwitches,
    distinctProviders,
    distinctModels,
    audioOutputRuns,
    errorReasons,
    outputPreview,
  };
}

function buildReport(
  effective: EffectiveBenchmarkConfig,
  warnings: string[],
  scenarioPath: string | undefined,
  executions: ScenarioExecution[],
  reportId?: string
): Omit<BenchmarkReport, "gateResults"> {
  const results = executions.map((item) => item.result);
  const executedResults = results.filter((result) => result.status !== "skipped");
  const allSamples = executions.flatMap((item) => item.samples);
  const latencies = allSamples.map((sample) => sample.latencyMs).sort((a, b) => a - b);

  const total = results.length;
  const executed = executedResults.length;
  const skipped = results.filter((result) => result.status === "skipped").length;
  const succeeded = results.filter((result) => result.status === "passed").length;
  const failed = results.filter((result) => result.status === "failed").length;

  const totalTokens = executedResults.reduce((sum, result) => sum + result.totalTokens, 0);
  const totalToolCalls = executedResults.reduce((sum, result) => sum + result.totalToolCalls, 0);
  const avgLatencyMs =
    latencies.length > 0
      ? Math.round(latencies.reduce((sum, value) => sum + value, 0) / latencies.length)
      : 0;
  const avgThroughputTokensPerSec =
    allSamples.length > 0
      ? allSamples.reduce((sum, sample) => sum + sample.throughputTokensPerSec, 0) /
        allSamples.length
      : 0;

  const topFailureReasons = collectTopFailureReasons(allSamples);
  const modeSummary = summarizeByMode(results);

  return {
    id: reportId ?? randomUUID(),
    createdAt: new Date().toISOString(),
    profile: effective.profile,
    suite: effective.run.suite,
    scenarioPath,
    modelOverride: effective.run.modelOverride,
    configSource: effective.configSource,
    total,
    executed,
    skipped,
    succeeded,
    failed,
    successRate: executed > 0 ? Number((succeeded / executed).toFixed(4)) : 0,
    totalTokens,
    totalToolCalls,
    avgLatencyMs,
    p50LatencyMs: percentile(latencies, 50),
    p95LatencyMs: percentile(latencies, 95),
    p99LatencyMs: percentile(latencies, 99),
    avgThroughputTokensPerSec: Number(avgThroughputTokensPerSec.toFixed(3)),
    modeSummary,
    effectiveConfig: {
      defaults: effective.defaults,
      profileSettings: effective.profileSettings,
      gates: effective.gates,
    },
    results,
    scenarioRuns: executions.map((execution) => ({
      id: execution.result.id,
      samples: execution.samples,
    })),
    warnings,
    topFailureReasons,
  };
}

function buildExchangeEvent(args: {
  mode: BenchmarkMode;
  model: string;
  requestPath: string;
  requestPayload: unknown;
  responsePayload: unknown;
  statusCode: number;
  contentType: string;
}): BenchmarkExchangeEvent {
  return {
    mode: args.mode,
    model: args.model,
    requestPath: args.requestPath,
    statusCode: args.statusCode,
    contentType: args.contentType,
    requestRaw: safeSerialize(args.requestPayload),
    requestSanitized: sanitizeForTrace(args.requestPayload),
    responseRaw: safeSerialize(args.responsePayload),
    responseSanitized: sanitizeForTrace(args.responsePayload),
  };
}

function safeSerialize(value: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return { preview: String(value) };
  }
}

function sanitizeForTrace(value: unknown, depth = 0): unknown {
  if (depth > 6) {
    return "[truncated-depth]";
  }
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (looksLikeBase64(trimmed) && trimmed.length > 64) {
      return `<base64 omitted len=${trimmed.length}>`;
    }
    if (trimmed.startsWith("data:") && trimmed.length > 80) {
      const mime = trimmed.slice(5, trimmed.indexOf(";")) || "unknown";
      return `<data-url ${mime} omitted len=${trimmed.length}>`;
    }
    if (trimmed.length > 500) {
      return `${trimmed.slice(0, 500)}…`;
    }
    return trimmed;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 50) {
      return {
        summary: `array(${value.length})`,
        sample: value.slice(0, 10).map((item) => sanitizeForTrace(item, depth + 1)),
      };
    }
    return value.map((item) => sanitizeForTrace(item, depth + 1));
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (/(api[-_]?key|authorization|token|secret)/i.test(key)) {
        out[key] = "***";
        continue;
      }
      if (key === "embedding" && Array.isArray(item)) {
        out[key] = {
          summary: `vector(${item.length})`,
          sample: item.slice(0, 8),
        };
        continue;
      }
      out[key] = sanitizeForTrace(item, depth + 1);
    }
    return out;
  }
  return String(value);
}

function looksLikeBase64(value: string): boolean {
  if (value.length < 32 || value.length % 4 !== 0) {
    return false;
  }
  return /^[A-Za-z0-9+/=]+$/.test(value);
}

function emitEvent(hooks: BenchmarkRunHooks | undefined, event: BenchmarkProgressEvent): void {
  hooks?.onEvent?.(event);
}

function summarizeByMode(
  results: ScenarioResult[]
): BenchmarkReport["modeSummary"] {
  const summary = Object.fromEntries(
    BENCHMARK_MODES.map((mode) => [
      mode,
      { total: 0, executed: 0, skipped: 0, passed: 0, failed: 0 },
    ])
  ) as BenchmarkReport["modeSummary"];

  for (const result of results) {
    const row = summary[result.mode];
    row.total += 1;
    if (result.status === "skipped") {
      row.skipped += 1;
      continue;
    }
    row.executed += 1;
    if (result.status === "passed") {
      row.passed += 1;
    } else {
      row.failed += 1;
    }
  }

  return summary;
}

function collectTopFailureReasons(samples: ScenarioRunSample[]): Array<{ reason: string; count: number }> {
  const counts = new Map<string, number>();
  for (const sample of samples) {
    if (!sample.error) {
      continue;
    }
    counts.set(sample.error, (counts.get(sample.error) ?? 0) + 1);
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([reason, count]) => ({ reason, count }));
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) {
    return 0;
  }
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength - 1)}…`;
}

function calculateThroughput(tokens: number, latencyMs: number): number {
  if (tokens <= 0 || latencyMs <= 0) {
    return 0;
  }
  return (tokens * 1000) / latencyMs;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeoutId: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}
