import { promises as fs } from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";
import YAML from "yaml";
import { EndpointDoc, EndpointHealth, RequestLog } from "../types";

export interface ConfigFile {
  endpoints: Array<Omit<EndpointDoc, "health">>;
}

export interface HealthFile {
  endpoints: Record<string, EndpointHealth>;
}

export interface StoragePaths {
  baseDir: string;
  configPath: string;
  healthPath: string;
  requestLogPath: string;
}

export function resolveStoragePaths(): StoragePaths {
  const baseDir = process.env.WAYPOINT_DIR ?? path.join(os.homedir(), ".config", "waypoint");
  const configPath = process.env.WAYPOINT_CONFIG ?? path.join(baseDir, "config.yaml");
  return {
    baseDir,
    configPath,
    healthPath: path.join(baseDir, "health.json"),
    requestLogPath: path.join(baseDir, "request_logs.jsonl")
  };
}

export async function ensureStorageDir(paths: StoragePaths): Promise<void> {
  await fs.mkdir(paths.baseDir, { recursive: true });
}

export async function loadConfig(paths: StoragePaths): Promise<ConfigFile> {
  await ensureStorageDir(paths);
  try {
    const raw = await fs.readFile(paths.configPath, "utf8");
    const doc = YAML.parse(raw) as ConfigFile | null;
    if (doc?.endpoints) {
      return doc;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  return { endpoints: [] };
}

export async function saveConfig(paths: StoragePaths, config: ConfigFile): Promise<void> {
  await ensureStorageDir(paths);
  const yaml = YAML.stringify(config);
  await writeAtomic(paths.configPath, yaml);
}

export async function loadHealth(paths: StoragePaths): Promise<HealthFile> {
  await ensureStorageDir(paths);
  try {
    const raw = await fs.readFile(paths.healthPath, "utf8");
    const data = JSON.parse(raw) as HealthFile | null;
    if (data?.endpoints) {
      return data;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  return { endpoints: {} };
}

export async function saveHealth(paths: StoragePaths, health: HealthFile): Promise<void> {
  await ensureStorageDir(paths);
  await writeAtomic(paths.healthPath, JSON.stringify(health, null, 2));
}

export function newEndpointId(): string {
  return crypto.randomUUID();
}

export function defaultHealth(): EndpointHealth {
  return {
    status: "up",
    consecutiveFailures: 0
  };
}

export async function appendRequestLog(paths: StoragePaths, log: RequestLog): Promise<void> {
  await ensureStorageDir(paths);
  const line = `${JSON.stringify(log)}\n`;
  await fs.appendFile(paths.requestLogPath, line, "utf8");
}

export async function readRequestLogs(paths: StoragePaths): Promise<RequestLog[]> {
  await ensureStorageDir(paths);
  try {
    const raw = await fs.readFile(paths.requestLogPath, "utf8");
    return raw
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as RequestLog);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function writeAtomic(filePath: string, content: string): Promise<void> {
  const dir = path.dirname(filePath);
  const tmp = path.join(dir, `.${path.basename(filePath)}.${crypto.randomUUID()}`);
  await fs.writeFile(tmp, content, "utf8");
  await fs.rename(tmp, filePath);
}
