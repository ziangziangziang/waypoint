import {
  BENCHMARK_CAPABILITY_KEYS,
  BENCHMARK_MODES,
  BenchmarkAssertions,
  BenchmarkCapabilityKey,
  BenchmarkMode,
  BenchmarkScenario,
  ValidationOutcome,
} from "./types";

const SCENARIO_KEYS = new Set([
  "id",
  "mode",
  "title",
  "summary",
  "userVisibleGoal",
  "exampleSource",
  "inputPreview",
  "successCriteria",
  "expectedHighlights",
  "capability",
  "model",
  "timeoutMs",
  "requiresAvailableTools",
  "assertions",
  "prompt",
  "tools",
  "maxIterations",
  "temperature",
  "max_tokens",
  "input",
  "n",
  "size",
  "audioFile",
  "inputText",
  "voice",
  "response_format",
]);

const ASSERTION_KEYS = new Set([
  "contains",
  "notContains",
  "requiredToolNames",
  "minToolCalls",
  "maxToolCalls",
  "maxLatencyMs",
  "statusCode",
  "minItems",
  "minVectorLength",
  "minImages",
  "containsText",
  "notContainsText",
  "minBytes",
  "contentType",
]);

export function validateScenarioCollection(
  rawScenarios: unknown[],
  sourceLabel: string
): ValidationOutcome {
  const warnings: string[] = [];
  const scenarios: BenchmarkScenario[] = rawScenarios.map((raw, index) =>
    validateScenario(raw, sourceLabel, index, warnings)
  );

  const ids = new Set<string>();
  for (const scenario of scenarios) {
    if (ids.has(scenario.id)) {
      throw new Error(`${sourceLabel} scenario '${scenario.id}' is duplicated.`);
    }
    ids.add(scenario.id);
  }

  return { scenarios, warnings };
}

function validateScenario(
  raw: unknown,
  sourceLabel: string,
  index: number,
  warnings: string[]
): BenchmarkScenario {
  const ctx = `${sourceLabel} scenario[${index}]`;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${ctx}: expected object.`);
  }

  const input = raw as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (!SCENARIO_KEYS.has(key)) {
      warnings.push(`${ctx}: unknown field '${key}' is ignored.`);
    }
  }

  const id = requiredString(input.id, `${ctx}.id`);
  const mode = validateMode(input.mode, `${ctx}.mode`);
  const capability = optionalCapabilityKey(input.capability, `${ctx}.capability`);
  const model = optionalString(input.model, `${ctx}.model`);
  const timeoutMs = optionalInteger(input.timeoutMs, `${ctx}.timeoutMs`, 1);
  const assertions = validateAssertions(input.assertions, `${ctx}.assertions`, warnings);

  const scenario: BenchmarkScenario = {
    id,
    mode,
    capability,
    model,
    timeoutMs,
    assertions,
  };

  scenario.title = optionalString(input.title, `${ctx}.title`);
  scenario.summary = optionalString(input.summary, `${ctx}.summary`);
  scenario.userVisibleGoal = optionalString(input.userVisibleGoal, `${ctx}.userVisibleGoal`);
  scenario.exampleSource = optionalExampleSource(input.exampleSource, `${ctx}.exampleSource`);
  scenario.inputPreview = optionalString(input.inputPreview, `${ctx}.inputPreview`);
  scenario.successCriteria = optionalString(input.successCriteria, `${ctx}.successCriteria`);
  scenario.expectedHighlights = optionalStringArray(
    input.expectedHighlights,
    `${ctx}.expectedHighlights`
  );
  scenario.prompt = optionalString(input.prompt, `${ctx}.prompt`);
  scenario.tools = optionalStringArray(input.tools, `${ctx}.tools`);
  scenario.maxIterations = optionalInteger(input.maxIterations, `${ctx}.maxIterations`, 1, 20);
  scenario.temperature = optionalFiniteNumber(input.temperature, `${ctx}.temperature`);
  scenario.max_tokens = optionalInteger(input.max_tokens, `${ctx}.max_tokens`, 1);
  scenario.requiresAvailableTools = optionalBoolean(
    input.requiresAvailableTools,
    `${ctx}.requiresAvailableTools`
  );
  scenario.input = optionalInputValue(input.input, `${ctx}.input`);
  scenario.n = optionalInteger(input.n, `${ctx}.n`, 1);
  scenario.size = optionalString(input.size, `${ctx}.size`);
  scenario.audioFile = optionalString(input.audioFile, `${ctx}.audioFile`);
  scenario.inputText = optionalString(input.inputText, `${ctx}.inputText`);
  scenario.voice = optionalString(input.voice, `${ctx}.voice`);
  scenario.response_format = optionalString(input.response_format, `${ctx}.response_format`);

  validateScenarioByMode(scenario, ctx);

  return scenario;
}

function validateScenarioByMode(scenario: BenchmarkScenario, ctx: string): void {
  if (
    scenario.mode === "chat" ||
    scenario.mode === "agent" ||
    scenario.mode === "responses" ||
    scenario.mode === "image_generation"
  ) {
    if (!scenario.prompt) {
      throw new Error(`${ctx}.prompt: required for mode '${scenario.mode}'.`);
    }
  }

  if (scenario.mode === "embeddings") {
    if (scenario.input === undefined) {
      throw new Error(`${ctx}.input: required for mode 'embeddings'.`);
    }
  }

  if (scenario.mode === "audio_transcription") {
    if (!scenario.audioFile) {
      throw new Error(`${ctx}.audioFile: required for mode 'audio_transcription'.`);
    }
  }

  if (scenario.mode === "omni_call") {
    if (!scenario.audioFile) {
      throw new Error(`${ctx}.audioFile: required for mode 'omni_call'.`);
    }
  }

  if (scenario.mode === "audio_speech") {
    if (!scenario.inputText) {
      throw new Error(`${ctx}.inputText: required for mode 'audio_speech'.`);
    }
    if (!scenario.voice) {
      throw new Error(`${ctx}.voice: required for mode 'audio_speech'.`);
    }
  }
}

function validateAssertions(
  raw: unknown,
  field: string,
  warnings: string[]
): BenchmarkAssertions {
  if (raw === undefined || raw === null) {
    return { statusCode: 200 };
  }

  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${field}: expected object.`);
  }

  const input = raw as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (!ASSERTION_KEYS.has(key)) {
      warnings.push(`${field}: unknown field '${key}' is ignored.`);
    }
  }

  const contains = optionalStringArray(input.contains, `${field}.contains`);
  const notContains = optionalStringArray(input.notContains, `${field}.notContains`);
  const requiredToolNames = optionalStringArray(
    input.requiredToolNames,
    `${field}.requiredToolNames`
  );
  const minToolCalls = optionalInteger(input.minToolCalls, `${field}.minToolCalls`, 0);
  const maxToolCalls = optionalInteger(input.maxToolCalls, `${field}.maxToolCalls`, 0);
  const maxLatencyMs = optionalInteger(input.maxLatencyMs, `${field}.maxLatencyMs`, 1);
  const statusCode = optionalInteger(input.statusCode, `${field}.statusCode`, 100, 599) ?? 200;
  const minItems = optionalInteger(input.minItems, `${field}.minItems`, 1);
  const minVectorLength = optionalInteger(input.minVectorLength, `${field}.minVectorLength`, 1);
  const minImages = optionalInteger(input.minImages, `${field}.minImages`, 1);
  const containsText = optionalStringArray(input.containsText, `${field}.containsText`);
  const notContainsText = optionalStringArray(input.notContainsText, `${field}.notContainsText`);
  const minBytes = optionalInteger(input.minBytes, `${field}.minBytes`, 1);
  const contentType = optionalString(input.contentType, `${field}.contentType`);

  if (
    typeof minToolCalls === "number" &&
    typeof maxToolCalls === "number" &&
    maxToolCalls < minToolCalls
  ) {
    throw new Error(`${field}: maxToolCalls must be >= minToolCalls.`);
  }

  return {
    contains,
    notContains,
    requiredToolNames,
    minToolCalls,
    maxToolCalls,
    maxLatencyMs,
    statusCode,
    minItems,
    minVectorLength,
    minImages,
    containsText,
    notContainsText,
    minBytes,
    contentType,
  };
}

function optionalExampleSource(
  value: unknown,
  field: string
): BenchmarkScenario["exampleSource"] | undefined {
  const parsed = optionalString(value, field);
  if (!parsed) {
    return undefined;
  }
  if (parsed !== "opencode" && parsed !== "builtin" && parsed !== "file") {
    throw new Error(`${field}: expected 'opencode', 'builtin', or 'file'.`);
  }
  return parsed;
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new Error(`${field}: expected boolean.`);
  }
  return value;
}

function validateMode(value: unknown, field: string): BenchmarkMode {
  if (typeof value !== "string") {
    throw new Error(`${field}: expected mode string.`);
  }
  if (!BENCHMARK_MODES.includes(value as BenchmarkMode)) {
    throw new Error(`${field}: unsupported mode '${value}'.`);
  }
  return value as BenchmarkMode;
}

function requiredString(value: unknown, field: string): string {
  const parsed = optionalString(value, field);
  if (!parsed) {
    throw new Error(`${field}: required non-empty string.`);
  }
  return parsed;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field}: expected non-empty string.`);
  }
  return value.trim();
}

function optionalStringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === "string") {
    const single = value.trim();
    if (!single) {
      throw new Error(`${field}: string must be non-empty.`);
    }
    return [single];
  }
  if (!Array.isArray(value)) {
    throw new Error(`${field}: expected string or string array.`);
  }

  return value.map((entry, index) => {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      throw new Error(`${field}[${index}]: expected non-empty string.`);
    }
    return entry.trim();
  });
}

function optionalInputValue(value: unknown, field: string): string | string[] | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === "string") {
    if (!value.trim()) {
      throw new Error(`${field}: expected non-empty string.`);
    }
    return value;
  }
  if (!Array.isArray(value)) {
    throw new Error(`${field}: expected string or string array.`);
  }
  const normalized = value.map((entry, index) => {
    if (typeof entry !== "string" || !entry.trim()) {
      throw new Error(`${field}[${index}]: expected non-empty string.`);
    }
    return entry;
  });
  return normalized;
}

function optionalCapabilityKey(value: unknown, field: string): BenchmarkCapabilityKey | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`${field}: expected capability key string.`);
  }
  if (!BENCHMARK_CAPABILITY_KEYS.includes(value as BenchmarkCapabilityKey)) {
    throw new Error(`${field}: unsupported capability '${value}'.`);
  }
  return value as BenchmarkCapabilityKey;
}

function optionalInteger(
  value: unknown,
  field: string,
  min: number,
  max?: number
): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Number.isInteger(value)) {
    throw new Error(`${field}: expected integer.`);
  }
  const num = value as number;
  if (num < min) {
    throw new Error(`${field}: must be >= ${min}.`);
  }
  if (typeof max === "number" && num > max) {
    throw new Error(`${field}: must be <= ${max}.`);
  }
  return num;
}

function optionalFiniteNumber(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${field}: expected finite number.`);
  }
  return value;
}
