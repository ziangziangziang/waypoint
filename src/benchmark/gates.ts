import { promises as fs } from "fs";
import {
  BenchmarkGateResults,
  BenchmarkReport,
  EffectiveBenchmarkConfig,
  ScenarioResult,
} from "./types";

export async function evaluateGates(
  report: Omit<BenchmarkReport, "gateResults">,
  effective: EffectiveBenchmarkConfig
): Promise<BenchmarkGateResults> {
  const hardMessages: string[] = [];
  const softMessages: string[] = [];

  if (effective.run.suite === "smoke") {
    const min = effective.gates.hard.smokeMinSuccessRate;
    if (report.executed > 0 && report.successRate < min) {
      hardMessages.push(
        `Smoke suite success rate ${toPct(report.successRate)} is below required ${toPct(min)}.`
      );
    }
  }

  const minScenarioPassRate = effective.profileSettings.minScenarioPassRate;
  const failingScenarios = report.results.filter(
    (scenario) => scenario.status !== "skipped" && scenario.passRate < minScenarioPassRate
  );
  for (const scenario of failingScenarios) {
    hardMessages.push(
      `Scenario '${scenario.id}' pass rate ${toPct(scenario.passRate)} is below required ${toPct(minScenarioPassRate)}.`
    );
  }

  if (effective.run.baselinePath) {
    const baseline = await loadBaseline(effective.run.baselinePath);
    const baselineById = new Map(
      baseline.results
        .map((scenario) => normalizeBaselineScenario(scenario))
        .filter((scenario): scenario is BaselineScenario => scenario !== null)
        .map((scenario) => [scenario.id, scenario])
    );

    for (const current of report.results) {
      if (current.status === "skipped") {
        continue;
      }
      const ref = baselineById.get(current.id);
      if (!ref) {
        continue;
      }
      const maxP95 = effective.gates.soft.maxP95RegressionPct;
      if (ref.p95LatencyMs > 0) {
        const p95Threshold = ref.p95LatencyMs * (1 + maxP95 / 100);
        if (current.p95LatencyMs > p95Threshold) {
          softMessages.push(
            `Scenario '${current.id}' p95 latency regressed ${pctDelta(current.p95LatencyMs, ref.p95LatencyMs)} (${current.p95LatencyMs}ms vs baseline ${ref.p95LatencyMs}ms).`
          );
        }
      }

      const maxThroughputDrop = effective.gates.soft.maxThroughputDropPct;
      if (ref.avgThroughputTokensPerSec > 0) {
        const throughputThreshold = ref.avgThroughputTokensPerSec * (1 - maxThroughputDrop / 100);
        if (current.avgThroughputTokensPerSec < throughputThreshold) {
          softMessages.push(
            `Scenario '${current.id}' throughput dropped ${throughputDropPct(current.avgThroughputTokensPerSec, ref.avgThroughputTokensPerSec)} (${current.avgThroughputTokensPerSec.toFixed(2)} t/s vs baseline ${ref.avgThroughputTokensPerSec.toFixed(2)} t/s).`
          );
        }
      }
    }
  }

  return {
    hard: {
      passed: hardMessages.length === 0,
      messages: hardMessages,
    },
    soft: {
      passed: softMessages.length === 0,
      messages: softMessages,
    },
  };
}

interface BaselineScenario {
  id: string;
  p95LatencyMs: number;
  avgThroughputTokensPerSec: number;
}

async function loadBaseline(pathLike: string): Promise<{ results: unknown[] }> {
  let raw: string;
  try {
    raw = await fs.readFile(pathLike, "utf8");
  } catch (error) {
    throw new Error(
      `Failed to read baseline file '${pathLike}': ${(error as Error).message}`
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Failed to parse baseline file '${pathLike}' as JSON: ${(error as Error).message}`
    );
  }

  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { results?: unknown[] }).results)) {
    throw new Error(
      `Baseline file '${pathLike}' must contain a top-level 'results' array.`
    );
  }

  return parsed as { results: unknown[] };
}

function normalizeBaselineScenario(raw: unknown): BaselineScenario | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const scenario = raw as Partial<ScenarioResult>;
  if (typeof scenario.id !== "string") {
    return null;
  }
  const p95LatencyMs =
    typeof scenario.p95LatencyMs === "number" && Number.isFinite(scenario.p95LatencyMs)
      ? scenario.p95LatencyMs
      : 0;
  const avgThroughputTokensPerSec =
    typeof scenario.avgThroughputTokensPerSec === "number" &&
    Number.isFinite(scenario.avgThroughputTokensPerSec)
      ? scenario.avgThroughputTokensPerSec
      : 0;

  return {
    id: scenario.id,
    p95LatencyMs,
    avgThroughputTokensPerSec,
  };
}

function toPct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function pctDelta(current: number, baseline: number): string {
  if (baseline === 0) {
    return "n/a";
  }
  const delta = ((current - baseline) / baseline) * 100;
  const sign = delta >= 0 ? "+" : "";
  return `${sign}${delta.toFixed(1)}%`;
}

function throughputDropPct(current: number, baseline: number): string {
  if (baseline === 0) {
    return "n/a";
  }
  const delta = ((baseline - current) / baseline) * 100;
  return `${delta.toFixed(1)}%`;
}
