import { ModelModality } from "../types";

export type BenchmarkMode =
  | "chat"
  | "agent"
  | "embeddings"
  | "image_generation"
  | "audio_transcription"
  | "audio_speech"
  | "omni_call";

export interface BenchmarkAssertions {
  contains?: string[];
  notContains?: string[];
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
  model?: string;
  timeoutMs?: number;
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
  scenarioPath?: string;
  modelOverride?: string;
  outPath?: string;
  configPath?: string;
  profile?: string;
  baselinePath?: string;
}

export interface BenchmarkDefaults {
  requestTimeoutMs: number;
  toolTimeoutMs: number;
  maxIterations: number;
  temperature: number;
  max_tokens: number;
  concurrency: number;
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
    scenarioPath?: string;
    model?: string;
    outPath?: string;
    profile?: string;
    baselinePath?: string;
  };
}

export interface BenchmarkRunPlan {
  suite?: string;
  scenarioPath?: string;
  modelOverride?: string;
  outPath?: string;
  baselinePath?: string;
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
  outputPreview: string;
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
  errorReasons: string[];
  outputPreview: string;
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
  suite?: string;
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
  scenarioRuns: Array<{ id: string; samples: ScenarioRunSample[] }>;
  gateResults: BenchmarkGateResults;
  warnings: string[];
  topFailureReasons: Array<{ reason: string; count: number }>;
}

export interface BenchmarkRunOutput {
  report: BenchmarkReport;
  artifactPath: string;
  textArtifactPath: string;
}

export const BENCHMARK_MODES: BenchmarkMode[] = [
  "chat",
  "agent",
  "embeddings",
  "image_generation",
  "audio_transcription",
  "audio_speech",
  "omni_call",
];

export interface BenchmarkModeRequirements {
  requiredInput: ModelModality[];
  requiredOutput: ModelModality[];
  preferredEndpointType?: "llm" | "diffusion" | "audio" | "embedding";
}
