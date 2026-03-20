import { ModelModality } from "../types";

export type BenchmarkMode =
  | "chat"
  | "agent"
  | "responses"
  | "embeddings"
  | "image_generation"
  | "audio_transcription"
  | "audio_speech"
  | "omni_call";

export type BenchmarkExecutionMode = "showcase" | "diagnostic";

export type BenchmarkExampleSource = "opencode" | "builtin" | "file";

export type BenchmarkCapabilityKey =
  | "chat_basic"
  | "chat_streaming"
  | "chat_tool_calls"
  | "chat_vision_input"
  | "images_generation"
  | "images_edit"
  | "embeddings"
  | "audio_transcription"
  | "audio_speech"
  | "responses_compat";

export type BenchmarkCapabilityStatus =
  | "supported"
  | "unsupported"
  | "unknown"
  | "misconfigured";

export type BenchmarkCapabilityFreshness = "fresh" | "stale";

export interface BenchmarkAssertions {
  contains?: string[];
  notContains?: string[];
  requiredToolNames?: string[];
  minToolCalls?: number;
  maxToolCalls?: number;
  maxLatencyMs?: number;
  statusCode: number;
  minItems?: number;
  minVectorLength?: number;
  minImages?: number;
  containsText?: string[];
  notContainsText?: string[];
  minBytes?: number;
  contentType?: string;
}

export interface BenchmarkScenario {
  id: string;
  mode: BenchmarkMode;
  title?: string;
  summary?: string;
  userVisibleGoal?: string;
  exampleSource?: BenchmarkExampleSource;
  inputPreview?: string;
  successCriteria?: string;
  expectedHighlights?: string[];
  capability?: BenchmarkCapabilityKey;
  model?: string;
  timeoutMs?: number;
  requiresAvailableTools?: boolean;
  assertions: BenchmarkAssertions;

  // chat / agent
  prompt?: string;
  tools?: string[];
  maxIterations?: number;
  temperature?: number;
  max_tokens?: number;

  // embeddings
  input?: string | string[];

  // image generation
  n?: number;
  size?: string;

  // audio transcription
  audioFile?: string;

  // audio speech
  inputText?: string;
  voice?: string;
  response_format?: string;
}

export interface BenchmarkCliOptions {
  suite?: string;
  exampleId?: string;
  scenarioPath?: string;
  modelOverride?: string;
  outPath?: string;
  configPath?: string;
  profile?: string;
  baselinePath?: string;
  executionMode?: BenchmarkExecutionMode;
  listExamples?: boolean;
  updateCapCache?: boolean;
  capTtlDays?: number;
}

export interface BenchmarkDefaults {
  requestTimeoutMs: number;
  toolTimeoutMs: number;
  maxIterations: number;
  temperature: number;
  max_tokens: number;
}

export interface BenchmarkProfileSettings {
  warmupRuns: number;
  measuredRuns: number;
  minScenarioPassRate: number;
}

export interface BenchmarkGateHardConfig {
  smokeMinSuccessRate: number;
}

export interface BenchmarkGateSoftConfig {
  maxP95RegressionPct: number;
  maxThroughputDropPct: number;
}

export interface BenchmarkGateConfig {
  hard: BenchmarkGateHardConfig;
  soft: BenchmarkGateSoftConfig;
}

export interface BenchmarkConfigFile {
  version?: number;
  defaults?: Partial<BenchmarkDefaults>;
  profiles?: Record<string, Partial<BenchmarkProfileSettings>>;
  gates?: {
    hard?: Partial<BenchmarkGateHardConfig>;
    soft?: Partial<BenchmarkGateSoftConfig>;
  };
  run?: {
    suite?: string;
    exampleId?: string;
    scenarioPath?: string;
    model?: string;
    outPath?: string;
    profile?: string;
    baselinePath?: string;
    executionMode?: BenchmarkExecutionMode;
    listExamples?: boolean;
    updateCapCache?: boolean;
    capTtlDays?: number;
  };
}

export interface BenchmarkRunPlan {
  suite?: string;
  exampleId?: string;
  scenarioPath?: string;
  modelOverride?: string;
  outPath?: string;
  baselinePath?: string;
  executionMode?: BenchmarkExecutionMode;
  listExamples?: boolean;
  updateCapCache?: boolean;
  capTtlDays?: number;
}

export interface EffectiveBenchmarkConfig {
  version: number;
  profile: string;
  defaults: BenchmarkDefaults;
  profileSettings: BenchmarkProfileSettings;
  gates: BenchmarkGateConfig;
  run: BenchmarkRunPlan;
  configSource?: string;
}

export interface ValidationOutcome {
  scenarios: BenchmarkScenario[];
  warnings: string[];
}

export interface ScenarioRunSample {
  runIndex: number;
  success: boolean;
  latencyMs: number;
  statusCode: number;
  tokens: number;
  toolCalls: number;
  throughputTokensPerSec: number;
  finalOutput: string;
  outputPreview: string;
  verdict: string;
  usedToolNames: string[];
  error?: string;
  candidateAttempts?: number;
  failovers?: number;
  rateLimitSwitches?: number;
  distinctProviders?: number;
  distinctModels?: number;
  audioOutputPresent?: boolean;
}

export interface ScenarioResult {
  id: string;
  mode: BenchmarkMode;
  title?: string;
  summary?: string;
  userVisibleGoal?: string;
  exampleSource?: BenchmarkExampleSource;
  inputPreview?: string;
  successCriteria?: string;
  expectedHighlights?: string[];
  model: string;
  status: "passed" | "failed" | "skipped";
  success: boolean;
  skippedReason?: string;
  passRate: number;
  passedRuns: number;
  failedRuns: number;
  avgLatencyMs: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  p99LatencyMs: number;
  totalTokens: number;
  totalToolCalls: number;
  avgThroughputTokensPerSec: number;
  candidateAttempts: number;
  failovers: number;
  rateLimitSwitches: number;
  distinctProviders: number;
  distinctModels: number;
  audioOutputRuns: number;
  usedToolNames: string[];
  verdict: string;
  errorReasons: string[];
  outputPreview: string;
}

export interface BenchmarkScenarioSummary {
  id: string;
  suite: string;
  mode: BenchmarkMode;
  title: string;
  summary: string;
  userVisibleGoal: string;
  exampleSource: BenchmarkExampleSource;
  inputPreview: string;
  successCriteria: string;
  expectedHighlights: string[];
  requiresAvailableTools: boolean;
  model?: string;
}

export interface BenchmarkToolTraceStep {
  kind: "tool_call" | "tool_result";
  toolName: string;
  toolCallId?: string;
  argumentsText?: string;
  contentText?: string;
}

export interface BenchmarkExchangeSummary {
  timestamp?: string;
  mode: BenchmarkMode;
  model: string;
  requestPath: string;
  statusCode: number;
  contentType: string;
  requestSanitized: unknown;
  responseSanitized: unknown;
  requestRaw?: unknown;
  responseRaw?: unknown;
  requestPreview: string;
  responsePreview: string;
  endpointId?: string;
  endpointName?: string;
  upstreamModel?: string;
  toolTrace: BenchmarkToolTraceStep[];
}

export interface BenchmarkScenarioDetail {
  id: string;
  suite?: string;
  example?: BenchmarkScenarioSummary;
  model: string;
  status: "passed" | "failed" | "skipped";
  verdict: string;
  exchanges: BenchmarkExchangeSummary[];
  finalResponsePreview: string;
  usedToolNames: string[];
}

export interface BenchmarkGateResult {
  passed: boolean;
  messages: string[];
}

export interface BenchmarkGateResults {
  hard: BenchmarkGateResult;
  soft: BenchmarkGateResult;
}

export interface BenchmarkReport {
  id: string;
  createdAt: string;
  profile: string;
  executionMode: BenchmarkExecutionMode;
  suite?: string;
  exampleId?: string;
  scenarioPath?: string;
  modelOverride?: string;
  configSource?: string;
  total: number;
  executed: number;
  skipped: number;
  succeeded: number;
  failed: number;
  successRate: number;
  totalTokens: number;
  totalToolCalls: number;
  avgLatencyMs: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  p99LatencyMs: number;
  avgThroughputTokensPerSec: number;
  modeSummary: Record<
    BenchmarkMode,
    { total: number; executed: number; skipped: number; passed: number; failed: number }
  >;
  effectiveConfig: {
    defaults: BenchmarkDefaults;
    profileSettings: BenchmarkProfileSettings;
    gates: BenchmarkGateConfig;
  };
  results: ScenarioResult[];
  scenarioDetails: BenchmarkScenarioDetail[];
  scenarioRuns: Array<{ id: string; samples: ScenarioRunSample[] }>;
  gateResults: BenchmarkGateResults;
  warnings: string[];
  topFailureReasons: Array<{ reason: string; count: number }>;
  capabilityMatrix?: BenchmarkCapabilityMatrix;
}

export interface BenchmarkRunOutput {
  report: BenchmarkReport;
  artifactPath: string;
  textArtifactPath: string;
}

export const BENCHMARK_MODES: BenchmarkMode[] = [
  "chat",
  "agent",
  "responses",
  "embeddings",
  "image_generation",
  "audio_transcription",
  "audio_speech",
  "omni_call",
];

export const BENCHMARK_CAPABILITY_KEYS: BenchmarkCapabilityKey[] = [
  "chat_basic",
  "chat_streaming",
  "chat_tool_calls",
  "chat_vision_input",
  "images_generation",
  "images_edit",
  "embeddings",
  "audio_transcription",
  "audio_speech",
  "responses_compat",
];

export interface BenchmarkCapabilityFinding {
  capability: BenchmarkCapabilityKey;
  status: BenchmarkCapabilityStatus;
  confidence: number;
  evidence: string;
  scenarioId?: string;
  statusCode?: number;
  observedAt: string;
}

export interface BenchmarkModelCapabilitySnapshot {
  model: string;
  providerId: string;
  modelId: string;
  configFingerprint: string;
  confidence: number;
  lastVerifiedAt: string;
  expiresAt: string;
  freshness: BenchmarkCapabilityFreshness;
  findings: Record<BenchmarkCapabilityKey, BenchmarkCapabilityFinding>;
}

export interface BenchmarkCapabilityMatrix {
  generatedAt: string;
  ttlDays: number;
  models: BenchmarkModelCapabilitySnapshot[];
}

export interface BenchmarkModeRequirements {
  requiredInput: ModelModality[];
  requiredOutput: ModelModality[];
  preferredEndpointType?: "llm" | "diffusion" | "audio" | "embedding";
}
