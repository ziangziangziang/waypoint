import path from "path";

export type McpTypedError = Error & { type: string };

export const MCP_TOOL_DESCRIPTION_TEMPLATE = {
  binary:
    "Use file output by default to minimize MCP context payload. Agents MUST write outputs under the workspace directory, MUST prefer output_path/output_dir when available, MUST NOT request inline base64 unless explicitly required, and SHOULD keep responses minimal by default.",
  image_to_text:
    "Agents MUST provide exactly one image source (image_path or image_url), MUST NOT send both, and SHOULD use concise task-specific instructions unless detailed extraction is required.",
} as const;

export interface BinaryOutputPolicyInput {
  n?: number;
  output_path?: string;
  output_dir?: string;
  include_data?: boolean;
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

  if (input.output_path && input.output_dir) {
    throw typedError("invalid_request", "Provide either output_path or output_dir, not both.");
  }

  if (input.output_path) {
    ensureWorkspacePath(input.output_path, "output_path", rootConfig);
  }
  if (input.output_dir) {
    ensureWorkspacePath(input.output_dir, "output_dir", rootConfig);
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
    includeData: input.include_data ?? !(input.output_path || input.output_dir),
    outputBaseRoot: rootConfig.baseRoot,
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
  return { baseRoot, allowedRoot };
}

function resolveRequestedOutputPath(value: string, baseRoot: string): string {
  if (path.isAbsolute(value)) {
    return path.resolve(value);
  }
  return path.resolve(baseRoot, value);
}

function ensureWorkspacePath(
  value: string,
  fieldName: string,
  rootConfig: BinaryOutputRootConfig
): void {
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
