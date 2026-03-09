import { promises as fs } from "fs";
import path from "path";
import { StoragePaths } from "../storage/files";
import { BenchmarkReport } from "./types";

export async function writeBenchmarkArtifacts(
  paths: StoragePaths,
  report: BenchmarkReport,
  outPath?: string
): Promise<{ jsonPath: string; textPath: string }> {
  const timestamp = timestampForFileName();
  const defaultDir = path.join(paths.baseDir, "benchmarks");
  const destination = outPath && outPath.trim().length > 0 ? path.resolve(outPath) : defaultDir;

  let jsonPath: string;
  let textPath: string;

  if (destination.endsWith(".json")) {
    jsonPath = destination;
    textPath = destination.replace(/\.json$/i, ".txt");
  } else if (destination.endsWith(".txt")) {
    textPath = destination;
    jsonPath = destination.replace(/\.txt$/i, ".json");
  } else {
    jsonPath = path.join(destination, `bench-${timestamp}.json`);
    textPath = path.join(destination, `bench-${timestamp}.txt`);
  }

  await fs.mkdir(path.dirname(jsonPath), { recursive: true });
  await fs.mkdir(path.dirname(textPath), { recursive: true });

  await fs.writeFile(jsonPath, JSON.stringify(report, null, 2), "utf8");
  await fs.writeFile(textPath, renderTextSummary(report), "utf8");

  return { jsonPath, textPath };
}

function renderTextSummary(report: BenchmarkReport): string {
  const lines: string[] = [];

  lines.push("Waypoint Benchmark Report");
  lines.push(`Run ID: ${report.id}`);
  lines.push(`Created: ${report.createdAt}`);
  lines.push(`Profile: ${report.profile}`);
  if (report.suite) lines.push(`Suite: ${report.suite}`);
  if (report.scenarioPath) lines.push(`Scenario File: ${report.scenarioPath}`);
  if (report.modelOverride) lines.push(`Model Override: ${report.modelOverride}`);
  lines.push("");

  lines.push("Overall");
  lines.push(`- Scenarios: ${report.total}`);
  lines.push(`- Executed: ${report.executed}`);
  lines.push(`- Skipped: ${report.skipped}`);
  lines.push(`- Success: ${report.succeeded}`);
  lines.push(`- Failed: ${report.failed}`);
  lines.push(`- Success Rate: ${(report.successRate * 100).toFixed(1)}%`);
  lines.push(`- Avg Latency: ${report.avgLatencyMs}ms`);
  lines.push(`- P95 Latency: ${report.p95LatencyMs}ms`);
  lines.push(`- Tokens: ${report.totalTokens}`);
  lines.push(`- Tool Calls: ${report.totalToolCalls}`);
  lines.push(`- Throughput: ${report.avgThroughputTokensPerSec.toFixed(2)} tokens/s`);
  lines.push("");

  lines.push("Gates");
  lines.push(`- Hard: ${report.gateResults.hard.passed ? "PASS" : "FAIL"}`);
  for (const message of report.gateResults.hard.messages) {
    lines.push(`  - ${message}`);
  }
  lines.push(`- Soft: ${report.gateResults.soft.passed ? "PASS" : "WARN"}`);
  for (const message of report.gateResults.soft.messages) {
    lines.push(`  - ${message}`);
  }
  lines.push("");

  lines.push("By Mode");
  for (const [mode, summary] of Object.entries(report.modeSummary)) {
    lines.push(
      `- ${mode}: total=${summary.total} executed=${summary.executed} skipped=${summary.skipped} passed=${summary.passed} failed=${summary.failed}`
    );
  }
  lines.push("");

  lines.push("Scenario Results");
  for (const scenario of report.results) {
    if (scenario.status === "skipped") {
      lines.push(`- ${scenario.id} [${scenario.mode}] SKIPPED: ${scenario.skippedReason ?? "not applicable"}`);
      continue;
    }
    lines.push(
      `- ${scenario.id} [${scenario.mode}] ${scenario.status.toUpperCase()} passRate=${(scenario.passRate * 100).toFixed(1)}% p95=${scenario.p95LatencyMs}ms tokens=${scenario.totalTokens} tools=${scenario.totalToolCalls} attempts=${scenario.candidateAttempts} failovers=${scenario.failovers} rateLimitSwitches=${scenario.rateLimitSwitches}`
    );
    for (const reason of scenario.errorReasons) {
      lines.push(`  - ${reason}`);
    }
  }

  if (report.topFailureReasons.length > 0) {
    lines.push("");
    lines.push("Top Failure Reasons");
    for (const item of report.topFailureReasons) {
      lines.push(`- ${item.reason} (${item.count})`);
    }
  }

  if (report.warnings.length > 0) {
    lines.push("");
    lines.push("Warnings");
    for (const warning of report.warnings) {
      lines.push(`- ${warning}`);
    }
  }

  if (report.capabilityMatrix && report.capabilityMatrix.models.length > 0) {
    lines.push("");
    lines.push("Capability Matrix");
    lines.push(`- TTL Days: ${report.capabilityMatrix.ttlDays}`);
    for (const model of report.capabilityMatrix.models) {
      lines.push(`- ${model.model} (${model.freshness}) verified=${model.lastVerifiedAt}`);
      lines.push(
        `  chat=${model.findings.chat_basic.status} tools=${model.findings.chat_tool_calls.status} embed=${model.findings.embeddings.status} image=${model.findings.images_generation.status} audio_in=${model.findings.audio_transcription.status} audio_out=${model.findings.audio_speech.status}`
      );
    }
  }

  lines.push("");
  return `${lines.join("\n")}\n`;
}

function timestampForFileName(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}
