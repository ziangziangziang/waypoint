import { promises as fs } from "fs";
import path from "path";
import YAML from "yaml";
import { StoragePaths } from "../storage/files";
import {
  BenchmarkCliOptions,
  BenchmarkConfigFile,
  BenchmarkDefaults,
  BenchmarkExecutionMode,
  BenchmarkGateConfig,
  BenchmarkProfileSettings,
  EffectiveBenchmarkConfig,
} from "./types";

const DEFAULT_VERSION = 1;
const DEFAULT_CAP_TTL_DAYS = 7;

const DEFAULTS: BenchmarkDefaults = {
  requestTimeoutMs: 120000,
  toolTimeoutMs: 15000,
  maxIterations: 6,
  temperature: 0,
  max_tokens: 512,
};

const DEFAULT_PROFILES: Record<string, BenchmarkProfileSettings> = {
  local: {
    warmupRuns: 1,
    measuredRuns: 3,
    minScenarioPassRate: 1.0,
  },
  ci: {
    warmupRuns: 2,
    measuredRuns: 5,
    minScenarioPassRate: 1.0,
  },
};

const DEFAULT_GATES: BenchmarkGateConfig = {
  hard: {
    smokeMinSuccessRate: 1.0,
  },
  soft: {
    maxP95RegressionPct: 20,
    maxThroughputDropPct: 20,
  },
};

export async function resolveBenchmarkConfig(
  paths: StoragePaths,
  cli: BenchmarkCliOptions
): Promise<EffectiveBenchmarkConfig> {
  const { fileConfig, configSource } = await loadConfigFile(paths, cli.configPath);

  const mergedDefaults: BenchmarkDefaults = {
    ...DEFAULTS,
    ...(fileConfig?.defaults ?? {}),
  };

  const mergedProfiles: Record<string, BenchmarkProfileSettings> = {
    ...DEFAULT_PROFILES,
  };
  for (const [profileName, profilePatch] of Object.entries(fileConfig?.profiles ?? {})) {
    mergedProfiles[profileName] = {
      ...(mergedProfiles[profileName] ?? DEFAULT_PROFILES.local),
      ...profilePatch,
    };
  }

  const selectedProfile =
    cli.profile ?? fileConfig?.run?.profile ?? "local";
  const profileSettings = mergedProfiles[selectedProfile];
  if (!profileSettings) {
    const names = Object.keys(mergedProfiles).sort().join(", ");
    throw new Error(
      `Unknown benchmark profile '${selectedProfile}'. Available profiles: ${names}`
    );
  }

  const mergedGates: BenchmarkGateConfig = {
    hard: {
      ...DEFAULT_GATES.hard,
      ...(fileConfig?.gates?.hard ?? {}),
    },
    soft: {
      ...DEFAULT_GATES.soft,
      ...(fileConfig?.gates?.soft ?? {}),
    },
  };

  const resolved: EffectiveBenchmarkConfig = {
    version: fileConfig?.version ?? DEFAULT_VERSION,
    profile: selectedProfile,
    defaults: validateDefaults(mergedDefaults),
    profileSettings: validateProfileSettings(profileSettings, selectedProfile),
    gates: validateGates(mergedGates),
    run: {
      suite: cli.suite ?? fileConfig?.run?.suite ?? "showcase",
      exampleId: cli.exampleId ?? fileConfig?.run?.exampleId,
      scenarioPath: cli.scenarioPath ?? fileConfig?.run?.scenarioPath,
      modelOverride: cli.modelOverride ?? fileConfig?.run?.model,
      outPath: cli.outPath ?? fileConfig?.run?.outPath,
      baselinePath: cli.baselinePath ?? fileConfig?.run?.baselinePath,
      executionMode: resolveExecutionMode(cli, fileConfig),
      listExamples: cli.listExamples ?? fileConfig?.run?.listExamples ?? false,
      updateCapCache: cli.updateCapCache ?? fileConfig?.run?.updateCapCache ?? false,
      capTtlDays: intField(
        cli.capTtlDays ?? fileConfig?.run?.capTtlDays ?? DEFAULT_CAP_TTL_DAYS,
        "run.capTtlDays",
        1
      ),
    },
    configSource,
  };

  return resolved;
}

async function loadConfigFile(
  paths: StoragePaths,
  explicitPath?: string
): Promise<{ fileConfig?: BenchmarkConfigFile; configSource?: string }> {
  const candidatePath = explicitPath
    ? path.resolve(explicitPath)
    : path.join(paths.baseDir, "benchmark.config.yaml");

  try {
    const raw = await fs.readFile(candidatePath, "utf8");
    const parsed = parseConfigDocument(candidatePath, raw);
    return { fileConfig: parsed, configSource: candidatePath };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      if (explicitPath) {
        throw new Error(`Benchmark config not found: ${candidatePath}`);
      }
      return {};
    }
    throw error;
  }
}

function parseConfigDocument(filePath: string, raw: string): BenchmarkConfigFile {
  const ext = path.extname(filePath).toLowerCase();
  try {
    if (ext === ".json") {
      return JSON.parse(raw) as BenchmarkConfigFile;
    }
    return YAML.parse(raw) as BenchmarkConfigFile;
  } catch (error) {
    throw new Error(
      `Failed to parse benchmark config ${filePath}: ${(error as Error).message}`
    );
  }
}

function validateDefaults(defaults: BenchmarkDefaults): BenchmarkDefaults {
  return {
    requestTimeoutMs: intField(defaults.requestTimeoutMs, "defaults.requestTimeoutMs", 1),
    toolTimeoutMs: intField(defaults.toolTimeoutMs, "defaults.toolTimeoutMs", 1),
    maxIterations: intField(defaults.maxIterations, "defaults.maxIterations", 1),
    temperature: numberField(defaults.temperature, "defaults.temperature"),
    max_tokens: intField(defaults.max_tokens, "defaults.max_tokens", 1),
  };
}

function resolveExecutionMode(
  cli: BenchmarkCliOptions,
  fileConfig?: BenchmarkConfigFile
): BenchmarkExecutionMode {
  const explicit = cli.executionMode ?? fileConfig?.run?.executionMode;
  if (explicit === "showcase" || explicit === "diagnostic") {
    return explicit;
  }
  const suite = cli.suite ?? fileConfig?.run?.suite ?? "showcase";
  return suite === "showcase" ? "showcase" : "diagnostic";
}

function validateProfileSettings(
  profile: BenchmarkProfileSettings,
  profileName: string
): BenchmarkProfileSettings {
  return {
    warmupRuns: intField(profile.warmupRuns, `profiles.${profileName}.warmupRuns`, 0),
    measuredRuns: intField(profile.measuredRuns, `profiles.${profileName}.measuredRuns`, 1),
    minScenarioPassRate: boundedField(
      profile.minScenarioPassRate,
      `profiles.${profileName}.minScenarioPassRate`,
      0,
      1
    ),
  };
}

function validateGates(gates: BenchmarkGateConfig): BenchmarkGateConfig {
  return {
    hard: {
      smokeMinSuccessRate: boundedField(
        gates.hard.smokeMinSuccessRate,
        "gates.hard.smokeMinSuccessRate",
        0,
        1
      ),
    },
    soft: {
      maxP95RegressionPct: numberField(
        gates.soft.maxP95RegressionPct,
        "gates.soft.maxP95RegressionPct",
        0
      ),
      maxThroughputDropPct: numberField(
        gates.soft.maxThroughputDropPct,
        "gates.soft.maxThroughputDropPct",
        0
      ),
    },
  };
}

function intField(value: number, field: string, min: number): number {
  if (!Number.isInteger(value) || value < min) {
    throw new Error(`${field} must be an integer >= ${min}`);
  }
  return value;
}

function numberField(value: number, field: string, min?: number): number {
  if (!Number.isFinite(value)) {
    throw new Error(`${field} must be a finite number`);
  }
  if (typeof min === "number" && value < min) {
    throw new Error(`${field} must be >= ${min}`);
  }
  return value;
}

function boundedField(value: number, field: string, min: number, max: number): number {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${field} must be between ${min} and ${max}`);
  }
  return value;
}
