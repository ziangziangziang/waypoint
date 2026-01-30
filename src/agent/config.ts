/**
 * Waypoint Agent Configuration
 *
 * Manages configuration for the agent runtime, ensuring isolation
 * from global Codex installations.
 *
 * @module agent/config
 */

import os from "os";
import path from "path";
import { promises as fs } from "fs";

/**
 * Codex approval policy values:
 * - "untrusted": Only auto-approve safe read-only commands, ask for everything else
 * - "on-failure": Auto-approve but ask on failures
 * - "on-request": Ask when agent explicitly requests approval
 * - "never": Auto-approve everything (full-auto mode)
 */
export type ApprovalPolicy = "untrusted" | "on-failure" | "on-request" | "never";

export interface AgentConfig {
  /** Base URL for the Waypoint OpenAI-compatible proxy */
  baseUrl: string;
  /** API key for authentication */
  apiKey: string;
  /** Home directory for Codex data */
  codexHome: string;
  /** Default model to use */
  defaultModel?: string;
  /** Working directory for agent */
  workingDirectory: string;
  /** Enable network access in sandbox */
  networkAccess: boolean;
  /** Approval policy */
  approvalPolicy: ApprovalPolicy;
}

const DEFAULT_PORT = 8000;

/**
 * Get the Codex home directory for Waypoint.
 * NEVER returns ~/.codex
 */
export function getCodexHome(): string {
  const envOverride = process.env.WAYPOINT_CODEX_HOME;
  if (envOverride) {
    return path.resolve(envOverride);
  }

  const homedir = os.homedir();
  const configDir = process.env.XDG_CONFIG_HOME || path.join(homedir, ".config");
  return path.join(configDir, "waypoint", "codex");
}

/**
 * Get the base URL for the Waypoint proxy
 */
export function getBaseUrl(): string {
  const envUrl = process.env.WAYPOINT_BASE_URL;
  if (envUrl) {
    return envUrl;
  }

  const port = process.env.WAYPOINT_PORT || DEFAULT_PORT;
  return `http://localhost:${port}/v1`;
}

/**
 * Get the API key for Waypoint
 */
export function getApiKey(): string {
  return (
    process.env.WAYPOINT_API_KEY ||
    process.env.CODEX_API_KEY ||
    process.env.OPENAI_API_KEY ||
    "local-dev"
  );
}

/**
 * Build the complete agent configuration
 */
export function buildAgentConfig(overrides?: Partial<AgentConfig>): AgentConfig {
  return {
    baseUrl: overrides?.baseUrl || getBaseUrl(),
    apiKey: overrides?.apiKey || getApiKey(),
    codexHome: overrides?.codexHome || getCodexHome(),
    defaultModel: overrides?.defaultModel || process.env.WAYPOINT_DEFAULT_MODEL,
    workingDirectory: overrides?.workingDirectory || process.cwd(),
    networkAccess: overrides?.networkAccess ?? true,
    approvalPolicy: overrides?.approvalPolicy || "on-request",
  };
}

/**
 * Create environment variables for Codex subprocess
 */
export function buildCodexEnv(config: AgentConfig): Record<string, string> {
  const env: Record<string, string> = {};

  // Copy current env
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }

  // Set Waypoint-specific variables
  env.WAYPOINT_BASE_URL = config.baseUrl;
  env.WAYPOINT_API_KEY = config.apiKey;
  env.WAYPOINT_CODEX_HOME = config.codexHome;

  // Override standard variables to force isolation
  env.OPENAI_BASE_URL = config.baseUrl;
  // NOTE: Don't set CODEX_API_KEY - Waypoint handles authentication to upstream endpoints
  // The proxy uses the endpoint's configured apiKey, not the client's auth header
  env.CODEX_HOME = config.codexHome;

  // XDG fallbacks
  const homedir = os.homedir();
  env.XDG_CONFIG_HOME = env.XDG_CONFIG_HOME || path.join(homedir, ".config");
  env.XDG_CACHE_HOME = env.XDG_CACHE_HOME || path.join(homedir, ".cache");

  return env;
}

/**
 * Ensure all required directories exist
 */
export async function ensureAgentDirs(config: AgentConfig): Promise<void> {
  const dirs = [
    config.codexHome,
    path.join(config.codexHome, "sessions"),
    path.join(config.codexHome, "log"),
  ];

  for (const dir of dirs) {
    await fs.mkdir(dir, { recursive: true });
  }
}

/**
 * Verify isolation invariants
 */
export function verifyIsolation(config: AgentConfig): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const homedir = os.homedir();
  const forbidden = path.join(homedir, ".codex");

  // Check codexHome
  if (
    config.codexHome === forbidden ||
    config.codexHome.startsWith(forbidden + path.sep)
  ) {
    errors.push(`CodexHome points to forbidden path: ${config.codexHome}`);
  }

  // Check baseUrl
  const forbiddenDomains = ["api.openai.com", "openai.com"];
  for (const domain of forbiddenDomains) {
    if (config.baseUrl.includes(domain)) {
      errors.push(`BaseUrl contains forbidden domain: ${config.baseUrl}`);
    }
  }

  return { valid: errors.length === 0, errors };
}
