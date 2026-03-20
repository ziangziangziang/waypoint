import { promises as fs } from "fs";
import path from "path";
import { EventEmitter } from "events";
import { randomUUID } from "crypto";
import { StoragePaths } from "../storage/files";
import { BenchmarkCliOptions, BenchmarkReport } from "./types";
import { BenchmarkProgressEvent, runBenchmark } from "./runner";

export type BenchmarkRunStatus = "running" | "completed" | "failed";

export interface BenchmarkRunProgress {
  totalScenarios: number;
  completedScenarios: number;
  currentScenarioId?: string;
  currentScenarioIndex?: number;
  currentRunIndex?: number;
  totalRuns?: number;
  phase?: "warmup" | "measured";
}

export interface BenchmarkRunRecord {
  id: string;
  status: BenchmarkRunStatus;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  request: BenchmarkCliOptions;
  progress: BenchmarkRunProgress;
  report?: BenchmarkReport;
  artifactPath?: string;
  textArtifactPath?: string;
  error?: string;
  events: BenchmarkProgressEvent[];
}

interface BenchmarkRunSummary {
  id: string;
  status: BenchmarkRunStatus;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  suite?: string;
  exampleId?: string;
  profile?: string;
  scenarioPath?: string;
  succeeded?: number;
  failed?: number;
  successRate?: number;
  artifactPath?: string;
}

const runs = new Map<string, BenchmarkRunRecord>();
const runEmitter = new EventEmitter();

export function hasRunningBenchmarkRun(): boolean {
  return Array.from(runs.values()).some((run) => run.status === "running");
}

export function getBenchmarkRun(runId: string): BenchmarkRunRecord | undefined {
  return runs.get(runId);
}

export function listBenchmarkRunEvents(runId: string): BenchmarkProgressEvent[] {
  return [...(runs.get(runId)?.events ?? [])];
}

export function subscribeBenchmarkRunEvents(
  runId: string,
  handler: (event: BenchmarkProgressEvent) => void
): () => void {
  const channel = eventChannel(runId);
  runEmitter.on(channel, handler);
  return () => {
    runEmitter.off(channel, handler);
  };
}

export async function startBenchmarkRun(
  paths: StoragePaths,
  request: BenchmarkCliOptions
): Promise<BenchmarkRunRecord> {
  const runId = randomUUID();
  const now = new Date().toISOString();
  const run: BenchmarkRunRecord = {
    id: runId,
    status: "running",
    createdAt: now,
    startedAt: now,
    request,
    progress: {
      totalScenarios: 0,
      completedScenarios: 0,
    },
    events: [],
  };
  runs.set(runId, run);

  void executeBenchmarkRun(paths, runId);
  return run;
}

export async function listBenchmarkRuns(paths: StoragePaths): Promise<BenchmarkRunSummary[]> {
  const inMemory = Array.from(runs.values()).map(toSummary);
  const artifactBacked = await listArtifactBackedRuns(paths);
  const merged = new Map<string, BenchmarkRunSummary>();

  for (const item of artifactBacked) {
    merged.set(item.id, item);
  }
  for (const item of inMemory) {
    merged.set(item.id, item);
  }

  return Array.from(merged.values()).sort((a, b) => {
    const aTs = Date.parse(a.createdAt || a.startedAt || a.finishedAt || "");
    const bTs = Date.parse(b.createdAt || b.startedAt || b.finishedAt || "");
    return bTs - aTs;
  });
}

export async function getArtifactBenchmarkRun(
  paths: StoragePaths,
  runId: string
): Promise<BenchmarkRunRecord | null> {
  const benchmarksDir = path.join(paths.baseDir, "benchmarks");
  let files: string[] = [];
  try {
    files = await fs.readdir(benchmarksDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }

  const jsonFiles = files
    .filter((file) => file.startsWith("bench-") && file.endsWith(".json"))
    .sort((a, b) => b.localeCompare(a));

  for (const file of jsonFiles) {
    const filePath = path.join(benchmarksDir, file);
    try {
      const raw = await fs.readFile(filePath, "utf8");
      const report = JSON.parse(raw) as BenchmarkReport;
      if (report.id !== runId) {
        continue;
      }
      return {
        id: report.id,
        status: "completed",
        createdAt: report.createdAt,
        startedAt: report.createdAt,
        finishedAt: report.createdAt,
        request: {
          suite: report.suite,
          exampleId: report.exampleId,
          scenarioPath: report.scenarioPath,
          modelOverride: report.modelOverride,
          profile: report.profile,
          executionMode: report.executionMode,
        },
        progress: {
          totalScenarios: report.total,
          completedScenarios: report.total,
        },
        report,
        artifactPath: filePath,
        textArtifactPath: filePath.replace(/\.json$/i, ".txt"),
        events: [],
      };
    } catch {
      // Ignore malformed artifact.
    }
  }
  return null;
}

async function executeBenchmarkRun(paths: StoragePaths, runId: string): Promise<void> {
  const run = runs.get(runId);
  if (!run) {
    return;
  }

  try {
    const output = await runBenchmark(paths, run.request, {
      runId,
      onEvent: (event) => {
        updateProgress(run, event);
        pushEvent(run, event);
      },
    });
    run.status = "completed";
    run.finishedAt = new Date().toISOString();
    run.report = output.report;
    run.artifactPath = output.artifactPath;
    run.textArtifactPath = output.textArtifactPath;
  } catch (error) {
    run.status = "failed";
    run.finishedAt = new Date().toISOString();
    run.error = (error as Error).message;
    const failureEvent: BenchmarkProgressEvent = {
      type: "warning",
      timestamp: new Date().toISOString(),
      runId,
      warning: run.error,
    };
    pushEvent(run, failureEvent);
  }
}

function updateProgress(run: BenchmarkRunRecord, event: BenchmarkProgressEvent): void {
  if (event.type === "run_started") {
    run.progress.totalScenarios = event.totalScenarios ?? run.progress.totalScenarios;
    return;
  }
  if (event.type === "scenario_started") {
    run.progress.currentScenarioId = event.scenarioId;
    run.progress.currentScenarioIndex = event.scenarioIndex;
    run.progress.totalScenarios = event.totalScenarios ?? run.progress.totalScenarios;
    return;
  }
  if (event.type === "sample_completed") {
    run.progress.currentRunIndex = event.runIndex;
    run.progress.totalRuns = event.totalRuns;
    run.progress.phase = event.phase;
    return;
  }
  if (event.type === "scenario_completed") {
    run.progress.completedScenarios += 1;
    run.progress.currentRunIndex = undefined;
    run.progress.totalRuns = undefined;
    run.progress.phase = undefined;
    return;
  }
  if (event.type === "run_completed") {
    run.progress.completedScenarios = run.progress.totalScenarios;
  }
}

function pushEvent(run: BenchmarkRunRecord, event: BenchmarkProgressEvent): void {
  run.events.push(event);
  if (run.events.length > 1000) {
    run.events.splice(0, run.events.length - 1000);
  }
  runEmitter.emit(eventChannel(run.id), event);
}

function eventChannel(runId: string): string {
  return `benchmark:${runId}`;
}

function toSummary(run: BenchmarkRunRecord): BenchmarkRunSummary {
  return {
    id: run.id,
    status: run.status,
    createdAt: run.createdAt,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    suite: run.request.suite,
    exampleId: run.request.exampleId,
    profile: run.request.profile,
    scenarioPath: run.request.scenarioPath,
    succeeded: run.report?.succeeded,
    failed: run.report?.failed,
    successRate: run.report?.successRate,
    artifactPath: run.artifactPath,
  };
}

async function listArtifactBackedRuns(paths: StoragePaths): Promise<BenchmarkRunSummary[]> {
  const benchmarksDir = path.join(paths.baseDir, "benchmarks");
  let files: string[] = [];

  try {
    files = await fs.readdir(benchmarksDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const jsonFiles = files
    .filter((file) => file.startsWith("bench-") && file.endsWith(".json"))
    .sort((a, b) => b.localeCompare(a))
    .slice(0, 100);

  const summaries: BenchmarkRunSummary[] = [];
  for (const file of jsonFiles) {
    const filePath = path.join(benchmarksDir, file);
    try {
      const raw = await fs.readFile(filePath, "utf8");
      const report = JSON.parse(raw) as BenchmarkReport;
      summaries.push({
        id: report.id,
        status: "completed",
        createdAt: report.createdAt,
        finishedAt: report.createdAt,
        suite: report.suite,
        profile: report.profile,
        scenarioPath: report.scenarioPath,
        succeeded: report.succeeded,
        failed: report.failed,
        successRate: report.successRate,
        artifactPath: filePath,
      });
    } catch {
      // Skip malformed artifacts.
    }
  }
  return summaries;
}
