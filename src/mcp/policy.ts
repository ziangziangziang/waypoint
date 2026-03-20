import path from "path";

export type McpTypedError = Error & { type: string };

export interface BinaryOutputPolicyInput {
  n?: number;
  output_path?: string;
  output_dir?: string;
  include_data?: boolean;
  workspace_root?: string;
}

export interface BinaryOutputPolicyResolved {
  outputPathPattern?: string;
  outputDir?: string;
  includeData: boolean;
  outputBaseRoot: string;
}

interface BinaryOutputRootConfig {
  baseRoot: string;
  allowedRoot: string;
  pinnedRoot?: string;
}

interface ResolveBinaryOutputPolicyOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

export function typedError(type: string, message: string): McpTypedError {
  const error = new Error(message) as McpTypedError;
  error.type = type;
  return error;
}

export function resolveBinaryOutputPolicy(
  input: BinaryOutputPolicyInput,
  options: ResolveBinaryOutputPolicyOptions = {}
): BinaryOutputPolicyResolved {
  const rootConfig = resolveBinaryOutputRootConfig(options);
  if (!input.workspace_root) {
    throw typedError("invalid_request", "workspace_root is required for generate_image.");
  }
  const workspaceRoot = resolveWorkspaceRoot(input.workspace_root, rootConfig);
  const effectiveRootConfig = {
    baseRoot: workspaceRoot,
    allowedRoot: workspaceRoot,
  };

  if (input.output_path && input.output_dir) {
    throw typedError("invalid_request", "Provide either output_path or output_dir, not both.");
  }

  if (input.output_path) {
    ensureWorkspacePath(input.output_path, "output_path", effectiveRootConfig);
  }
  if (input.output_dir) {
    ensureWorkspacePath(input.output_dir, "output_dir", effectiveRootConfig);
  }

  if (input.n && input.n > 1 && input.output_path && !input.output_path.includes("{index}")) {
    throw typedError(
      "invalid_request",
      "For n > 1 with output_path, include '{index}' in output_path."
    );
  }

  return {
    outputPathPattern: input.output_path,
    outputDir: input.output_dir,
    includeData: input.include_data ?? false,
    outputBaseRoot: workspaceRoot,
  };
}

function resolveBinaryOutputRootConfig(options: ResolveBinaryOutputPolicyOptions): BinaryOutputRootConfig {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const strict = parseBooleanEnv(env.WAYPOINT_MCP_STRICT_OUTPUT_ROOT);
  const configuredRoot = env.WAYPOINT_MCP_OUTPUT_ROOT?.trim();

  if (strict && !configuredRoot) {
    throw typedError(
      "invalid_request",
      "WAYPOINT_MCP_STRICT_OUTPUT_ROOT=true requires WAYPOINT_MCP_OUTPUT_ROOT to be set."
    );
  }

  let baseRoot = path.resolve(cwd);
  if (configuredRoot) {
    if (!path.isAbsolute(configuredRoot)) {
      if (strict) {
        throw typedError(
          "invalid_request",
          `WAYPOINT_MCP_OUTPUT_ROOT must be an absolute path, got '${configuredRoot}'.`
        );
      }
    } else {
      baseRoot = path.resolve(configuredRoot);
    }
  }

  const configuredSubdir = env.WAYPOINT_MCP_OUTPUT_SUBDIR?.trim();
  if (configuredSubdir && path.isAbsolute(configuredSubdir)) {
    throw typedError(
      "invalid_request",
      `WAYPOINT_MCP_OUTPUT_SUBDIR must be relative, got '${configuredSubdir}'.`
    );
  }
  const allowedRoot = configuredSubdir ? path.resolve(baseRoot, configuredSubdir) : baseRoot;
  return { baseRoot, allowedRoot, pinnedRoot: configuredRoot ? baseRoot : undefined };
}

function resolveRequestedOutputPath(value: string, baseRoot: string): string {
  if (path.isAbsolute(value)) {
    return path.resolve(value);
  }
  return path.resolve(baseRoot, value);
}

function resolveWorkspaceRoot(
  workspaceRoot: string | undefined,
  rootConfig: BinaryOutputRootConfig
): string {
  if (!workspaceRoot) {
    return rootConfig.baseRoot;
  }
  if (!path.isAbsolute(workspaceRoot)) {
    throw typedError(
      "invalid_request",
      `workspace_root must be an absolute path, got '${workspaceRoot}'.`
    );
  }
  const resolvedWorkspaceRoot = path.resolve(workspaceRoot);
  const configuredRoot = rootConfig.pinnedRoot;
  if (configuredRoot && resolvedWorkspaceRoot !== configuredRoot) {
    if (!resolvedWorkspaceRoot.startsWith(`${configuredRoot}${path.sep}`)) {
      throw typedError(
        "invalid_request",
        `workspace_root resolved to '${resolvedWorkspaceRoot}' and must be within '${configuredRoot}'.`
      );
    }
  }
  return resolvedWorkspaceRoot;
}

function ensureWorkspacePath(
  value: string,
  fieldName: string,
  rootConfig: BinaryOutputRootConfig
): void {
  if (path.isAbsolute(value)) {
    throw typedError(
      "invalid_request",
      `${fieldName} must be relative to workspace_root, got '${value}'.`
    );
  }
  const resolved = resolveRequestedOutputPath(value, rootConfig.baseRoot);
  if (resolved === rootConfig.allowedRoot) {
    return;
  }
  if (!resolved.startsWith(`${rootConfig.allowedRoot}${path.sep}`)) {
    throw typedError(
      "invalid_request",
      `${fieldName} resolved to '${resolved}' and must be within '${rootConfig.allowedRoot}'.`
    );
  }
}

function parseBooleanEnv(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  return value === "1" || value.toLowerCase() === "true";
}

export function validateSingleImageInput(input: {
  image_path?: string;
  image_url?: string;
}): void {
  const hasPath = Boolean(input.image_path);
  const hasUrl = Boolean(input.image_url);
  if ((hasPath && hasUrl) || (!hasPath && !hasUrl)) {
    throw typedError(
      "invalid_request",
      "Exactly one image source is required: provide either image_path or image_url."
    );
  }
}

export function validateAtMostOneImageInput(input: {
  image_path?: string;
  image_url?: string;
}): void {
  if (input.image_path && input.image_url) {
    throw typedError(
      "invalid_request",
      "Provide either image_path or image_url, not both."
    );
  }
}
