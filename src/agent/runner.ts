/**
 * Waypoint Agent Runner
 *
 * Executes agent prompts using the vendored Codex engine with
 * full isolation from global installations.
 *
 * @module agent/runner
 */

import { spawn, ChildProcess } from "child_process";
import path from "path";
import fs from "fs";
import { EventEmitter } from "events";
import {
  AgentConfig,
  buildAgentConfig,
  buildCodexEnv,
  ensureAgentDirs,
  verifyIsolation,
} from "./config.js";
import { pickBestLlmModel } from "../storage/repositories.js";
import { resolveStoragePaths } from "../storage/files.js";

export interface AgentRunOptions {
  /** User prompt to execute */
  prompt: string;
  /** Working directory */
  cwd?: string;
  /** Model to use */
  model?: string;
  /** Approval policy: untrusted, on-failure, on-request, never */
  approvalPolicy?: "untrusted" | "on-failure" | "on-request" | "never";
  /** Enable network access */
  networkAccess?: boolean;
  /** Abort signal for cancellation */
  signal?: AbortSignal;
  /** Callback for stdout data */
  onStdout?: (data: string) => void;
  /** Callback for stderr data */
  onStderr?: (data: string) => void;
}

export interface AgentResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  sessionId?: string;
}

export class AgentRunner extends EventEmitter {
  private config: AgentConfig;
  private activeProcess: ChildProcess | null = null;

  constructor(configOverrides?: Partial<AgentConfig>) {
    super();
    this.config = buildAgentConfig(configOverrides);
  }

  /**
   * Get the path to the vendored Codex binary.
   * 
   * The vendored Codex binary is located at:
   *   src/engine/codex/codex-cli/bin/codex.js
   * 
   * This wrapper script handles platform detection and spawns the
   * appropriate native binary from the vendor directory.
   */
  private getCodexBinaryPath(): { path: string; type: "js" | "rust" | "none" } {
    // Path relative to compiled location: dist/src/agent/runner.js
    // We need to get back to: src/engine/codex/
    const agentDir = __dirname;
    const srcDistDir = path.dirname(agentDir);  // dist/src
    const distDir = path.dirname(srcDistDir);    // dist
    const rootDir = path.dirname(distDir);       // project root
    const codexDir = path.join(rootDir, "src", "engine", "codex");
    
    // Option 1: Vendored JS entry point (requires vendor binaries)
    const codexJsEntry = path.join(codexDir, "codex-cli", "bin", "codex.js");
    const vendorDir = path.join(codexDir, "codex-cli", "vendor");
    
    if (fs.existsSync(codexJsEntry) && fs.existsSync(vendorDir)) {
      return { path: codexJsEntry, type: "js" };
    }

    // Option 2: Rust binary built locally (renamed to waypoint-agent)
    const rustRelease = path.join(codexDir, "codex-rs", "target", "release", "waypoint-agent");
    const rustDebug = path.join(codexDir, "codex-rs", "target", "debug", "waypoint-agent");
    
    if (fs.existsSync(rustRelease)) {
      return { path: rustRelease, type: "rust" };
    }
    
    if (fs.existsSync(rustDebug)) {
      return { path: rustDebug, type: "rust" };
    }

    // Option 3: Check if codex.js exists without vendor (for development)
    if (fs.existsSync(codexJsEntry)) {
      return { path: codexJsEntry, type: "js" };
    }

    return { path: "", type: "none" };
  }

  /**
   * Initialize the agent runner, ensuring directories exist
   */
  async initialize(): Promise<void> {
    // Verify isolation before proceeding
    const isolation = verifyIsolation(this.config);
    if (!isolation.valid) {
      throw new Error(
        `Isolation check failed:\n${isolation.errors.join("\n")}`
      );
    }

    await ensureAgentDirs(this.config);
    this.emit("initialized", this.config);
  }

  /**
   * Run an agent with the given prompt
   */
  async run(options: AgentRunOptions): Promise<AgentResult> {
    await this.initialize();

    const {
      prompt,
      cwd = this.config.workingDirectory,
      model,
      approvalPolicy = this.config.approvalPolicy,
      networkAccess = this.config.networkAccess,
      signal,
      onStdout,
      onStderr,
    } = options;

    // Build environment with isolation
    const env = buildCodexEnv(this.config);

    // Build command arguments for the `exec` subcommand (non-interactive mode)
    const args: string[] = ["exec"];

    // Determine model: explicit > config > auto-pick from available endpoints
    let selectedModel = model || this.config.defaultModel;
    if (!selectedModel) {
      const paths = resolveStoragePaths();
      selectedModel = await pickBestLlmModel(paths) ?? undefined;
      if (selectedModel) {
        this.emit("model-selected", selectedModel);
      }
    }

    // Add model if we have one
    if (selectedModel) {
      args.push("--model", selectedModel);
    }

    // Add approval policy and sandbox settings
    if (approvalPolicy === "never") {
      // Use --full-auto convenience flag for auto-approve + sandbox write
      args.push("--full-auto");
    } else {
      // Use --config for other approval policies
      args.push("--config", `approval_policy="${approvalPolicy}"`);
    }

    // Add network access config
    if (!networkAccess) {
      args.push("--config", "sandbox_workspace_write.network_access=false");
    }

    // Add working directory
    if (cwd !== process.cwd()) {
      args.push("--cd", cwd);
    }

    // Enable JSON output for structured parsing
    args.push("--json");

    // Add the prompt
    args.push(prompt);

    return new Promise((resolve, reject) => {
      const codexBinary = this.getCodexBinaryPath();

      if (codexBinary.type === "none") {
        reject(new Error(
          "Codex binary not found. Build the vendored Codex first:\n\n" +
          "  Option A: Build Rust binary\n" +
          "    cd src/engine/codex/codex-rs && cargo build --release\n\n" +
          "  Option B: Install npm package (gets vendor binaries)\n" +
          "    cd src/engine/codex/codex-cli && npm install\n\n" +
          "Run 'waypoint doctor' for more information."
        ));
        return;
      }

      this.emit("start", { prompt, model, cwd });

      // Spawn based on binary type
      let child: ChildProcess;
      if (codexBinary.type === "js") {
        // Use Node to run the JS wrapper
        child = spawn(process.execPath, [codexBinary.path, ...args], {
          cwd,
          env,
          stdio: ["inherit", "pipe", "pipe"],
        });
      } else {
        // Run the Rust binary directly
        child = spawn(codexBinary.path, args, {
          cwd,
          env,
          stdio: ["inherit", "pipe", "pipe"],
        });
      }

      this.activeProcess = child;

      let stdout = "";
      let stderr = "";

      child.stdout?.on("data", (data: Buffer) => {
        const text = data.toString();
        stdout += text;
        onStdout?.(text);
        this.emit("stdout", text);
      });

      child.stderr?.on("data", (data: Buffer) => {
        const text = data.toString();
        stderr += text;
        onStderr?.(text);
        this.emit("stderr", text);
      });

      // Handle abort signal
      if (signal) {
        signal.addEventListener("abort", () => {
          child.kill("SIGTERM");
          reject(new Error("Agent execution aborted"));
        });
      }

      child.on("error", (error) => {
        this.activeProcess = null;
        reject(error);
      });

      child.on("close", (code) => {
        this.activeProcess = null;
        const exitCode = code ?? 1;

        this.emit("complete", { exitCode, stdout, stderr });

        resolve({
          exitCode,
          stdout,
          stderr,
        });
      });
    });
  }

  /**
   * Stop the currently running agent
   */
  stop(): void {
    if (this.activeProcess) {
      this.activeProcess.kill("SIGTERM");
      this.activeProcess = null;
    }
  }

  /**
   * Get the current configuration
   */
  getConfig(): AgentConfig {
    return { ...this.config };
  }
}

/**
 * Convenience function to run an agent with default configuration
 */
export async function runAgent(
  prompt: string,
  options?: Partial<AgentRunOptions & AgentConfig>
): Promise<AgentResult> {
  const runner = new AgentRunner(options);

  // Write to console by default
  const result = await runner.run({
    prompt,
    ...options,
    onStdout: options?.onStdout ?? ((data) => process.stdout.write(data)),
    onStderr: options?.onStderr ?? ((data) => process.stderr.write(data)),
  });

  return result;
}

/**
 * Create an agent runner with the given configuration
 */
export function createAgentRunner(config?: Partial<AgentConfig>): AgentRunner {
  return new AgentRunner(config);
}
