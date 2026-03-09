import { randomUUID } from "crypto";
import { IncomingMessage, ServerResponse } from "http";
import { promises as fs } from "fs";
import path from "path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { StoragePaths } from "../storage/files";
import {
  normalizeImageGenerationPayload,
  runImageGeneration,
} from "../services/imageGeneration";
import { imageDataUrlFromPath, runImageUnderstanding } from "../services/imageUnderstanding";
import { ImageGenerationRequest } from "../types";
import {
  validateAtMostOneImageInput,
  MCP_TOOL_DESCRIPTION_TEMPLATE,
  resolveBinaryOutputPolicy,
  typedError,
  validateSingleImageInput,
} from "./policy";

interface McpSessionEntry {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
}

export interface McpServiceDependencies {
  runImageGeneration: typeof runImageGeneration;
  normalizeImageGenerationPayload: typeof normalizeImageGenerationPayload;
  runImageUnderstanding: typeof runImageUnderstanding;
}

export type McpServiceDependencyOverrides = Partial<McpServiceDependencies>;

export interface McpService {
  handleRequest(req: IncomingMessage, res: ServerResponse, parsedBody?: unknown): Promise<void>;
  close(): Promise<void>;
}

const defaultDeps: McpServiceDependencies = {
  runImageGeneration,
  normalizeImageGenerationPayload,
  runImageUnderstanding,
};

export function createMcpService(
  paths: StoragePaths,
  deps: McpServiceDependencyOverrides = {}
): McpService {
  const resolvedDeps: McpServiceDependencies = {
    ...defaultDeps,
    ...deps,
  };
  const sessions = new Map<string, McpSessionEntry>();

  const createServer = (): McpServer => {
    const server = new McpServer(
      {
        name: "waypoint-mcp",
        version: "0.5.3",
      },
      {
        capabilities: {},
      }
    );

    server.registerTool(
      "generate_image",
      {
        description:
          `Generate image(s) from text using Waypoint diffusion model routing. Provide image_path or image_url for image-to-image editing. ${MCP_TOOL_DESCRIPTION_TEMPLATE.binary} Use include_data=true only when inline transport is explicitly required.`,
        inputSchema: {
          prompt: z.string().min(1),
          model: z.string().optional(),
          image_path: z.string().optional(),
          image_url: z.string().optional(),
          n: z.number().int().min(1).max(4).optional(),
          size: z.string().optional(),
          quality: z.string().optional(),
          style: z.string().optional(),
          response_format: z.enum(["url", "b64_json"]).optional(),
          output_path: z.string().optional(),
          output_dir: z.string().optional(),
          include_data: z.boolean().optional(),
        },
      },
      async (args) => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 60_000);
        try {
          validateAtMostOneImageInput({
            image_path: args.image_path,
            image_url: args.image_url,
          });
          const resolvedImageUrl = await resolveOptionalImageInputToUrl({
            image_path: args.image_path,
            image_url: args.image_url,
          });
          const filePolicy = resolveBinaryOutputPolicy({
            n: args.n,
            output_path: args.output_path,
            output_dir: args.output_dir,
            include_data: args.include_data,
          });
          const hasFileOutput = Boolean(filePolicy.outputPathPattern || filePolicy.outputDir);
          // File output requires decodable bytes; force b64_json upstream even if caller asks for "url".
          const responseFormat = hasFileOutput ? "b64_json" : (args.response_format ?? "b64_json");
          const request: ImageGenerationRequest = {
            prompt: args.prompt,
            model: args.model,
            n: args.n,
            size: args.size,
            quality: args.quality,
            style: args.style,
            response_format: responseFormat,
            image_url: resolvedImageUrl,
          };

          const generated = await resolvedDeps.runImageGeneration(paths, request, {}, controller.signal);
          const normalized = await resolvedDeps.normalizeImageGenerationPayload(
            paths,
            generated.payload,
            generated.model
          );
          const images = filePolicy.outputPathPattern || filePolicy.outputDir
              ? await materializeImagesToFiles(normalized.images, normalized.created, {
                  outputPathPattern: filePolicy.outputPathPattern,
                  outputDir: filePolicy.outputDir,
                  includeData: filePolicy.includeData,
                  outputBaseRoot: filePolicy.outputBaseRoot,
                })
              : normalized.images;

          const output = {
            ok: true,
            model: normalized.model,
            created: normalized.created,
            images,
          };
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(output),
              },
            ],
            structuredContent: output,
          };
        } catch (error) {
          const typed = error as Error & { type?: string };
          const type = typed.type ?? "upstream_error";
          const message =
            type === "no_diffusion_model"
              ? "No diffusion model available. Add or enable a provider model."
              : typed.message || "Image generation failed";
          const output = {
            ok: false,
            error: {
              type,
              message,
            },
          };
          return {
            isError: true,
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(output),
              },
            ],
            structuredContent: output,
          };
        } finally {
          clearTimeout(timeout);
        }
      }
    );

    server.registerTool(
      "understand_image",
      {
        description:
          `Analyze an image and return structured text understanding using a vision-capable chat model. ${MCP_TOOL_DESCRIPTION_TEMPLATE.image_to_text}`,
        inputSchema: {
          image_path: z.string().optional(),
          image_url: z.string().optional(),
          instruction: z.string().optional(),
          model: z.string().optional(),
          max_tokens: z.number().int().min(1).max(4096).optional(),
          temperature: z.number().min(0).max(2).optional(),
        },
      },
      async (args) => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 60_000);
        try {
          validateSingleImageInput({
            image_path: args.image_path,
            image_url: args.image_url,
          });
          const result = await resolvedDeps.runImageUnderstanding(
            paths,
            {
              image_path: args.image_path,
              image_url: args.image_url,
              instruction: args.instruction,
              model: args.model,
              max_tokens: args.max_tokens,
              temperature: args.temperature,
            },
            controller.signal
          );
          const output = {
            ok: true,
            model: result.model,
            analysis: result.analysis,
            raw_text: result.raw_text,
            usage: result.usage,
          };
          return {
            content: [{ type: "text" as const, text: JSON.stringify(output) }],
            structuredContent: output,
          };
        } catch (error) {
          const typed = error as Error & { type?: string };
          const type = typed.type ?? "upstream_error";
          const output = {
            ok: false,
            error: {
              type,
              message: typed.message || "Image understanding failed",
            },
          };
          return {
            isError: true,
            content: [{ type: "text" as const, text: JSON.stringify(output) }],
            structuredContent: output,
          };
        } finally {
          clearTimeout(timeout);
        }
      }
    );

    return server;
  };

  const close = async (): Promise<void> => {
    const entries = Array.from(sessions.values());
    sessions.clear();
    await Promise.allSettled(
      entries.map(async (entry) => {
        await entry.transport.close();
        await entry.server.close();
      })
    );
  };

  const handleRequest = async (
    req: IncomingMessage,
    res: ServerResponse,
    parsedBody?: unknown
  ): Promise<void> => {
    const sessionIdHeader = req.headers["mcp-session-id"];
    const sessionId =
      typeof sessionIdHeader === "string"
        ? sessionIdHeader
        : Array.isArray(sessionIdHeader)
          ? sessionIdHeader[0]
          : undefined;

    let entry: McpSessionEntry | undefined;
    if (sessionId) {
      entry = sessions.get(sessionId);
    }

    if (!entry) {
      if (sessionId || !isInitializeRequest(parsedBody)) {
        if (!res.headersSent) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              error: {
                code: -32000,
                message: "Bad Request: No valid MCP session ID provided",
              },
              id: null,
            })
          );
        }
        return;
      }

      const server = createServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        enableJsonResponse: true,
        onsessioninitialized: (newSessionId) => {
          sessions.set(newSessionId, { server, transport });
        },
        onsessionclosed: (closedSessionId) => {
          sessions.delete(closedSessionId);
        },
      });
      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid) {
          sessions.delete(sid);
        }
      };
      await server.connect(transport);
      entry = { server, transport };
    }

    await entry.transport.handleRequest(req, res, parsedBody);
  };

  return {
    handleRequest,
    close,
  };
}

type FileMaterializeOptions = {
  outputPathPattern?: string;
  outputDir?: string;
  includeData: boolean;
  outputBaseRoot: string;
};

async function materializeImagesToFiles(
  images: Array<{ index: number; url?: string; b64_json?: string; revised_prompt?: string }>,
  created: number,
  options: FileMaterializeOptions
): Promise<
  Array<{
    index: number;
    file_path: string;
    mime_type: string;
    bytes: number;
    revised_prompt?: string;
    url?: string;
    b64_json?: string;
  }>
> {
  const output: Array<{
    index: number;
    file_path: string;
    mime_type: string;
    bytes: number;
    revised_prompt?: string;
    url?: string;
    b64_json?: string;
  }> = [];

  for (const image of images) {
    const payload = decodeImagePayload(image);
    if (!payload) {
      throw typedError(
        "invalid_request",
        `Image ${image.index} has no decodable bytes for file output.`
      );
    }
    const extension = extensionForMime(payload.mimeType);
    const resolvedPath = resolveOutputPath(image.index, created, extension, options);
    await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
    await fs.writeFile(resolvedPath, payload.buffer);

    const entry: {
      index: number;
      file_path: string;
      mime_type: string;
      bytes: number;
      revised_prompt?: string;
      url?: string;
      b64_json?: string;
    } = {
      index: image.index,
      file_path: resolvedPath,
      mime_type: payload.mimeType,
      bytes: payload.buffer.length,
    };
    if (image.revised_prompt) {
      entry.revised_prompt = image.revised_prompt;
    }
    if (options.includeData) {
      if (image.url) entry.url = image.url;
      if (image.b64_json) entry.b64_json = image.b64_json;
    }
    output.push(entry);
  }
  return output;
}

function decodeImagePayload(image: { url?: string; b64_json?: string }): { buffer: Buffer; mimeType: string } | null {
  if (image.b64_json) {
    const mimeType = extractMimeFromDataUrl(image.url) ?? "image/png";
    return { buffer: Buffer.from(image.b64_json, "base64"), mimeType };
  }
  if (image.url?.startsWith("data:")) {
    const match = image.url.match(/^data:([^;]+);base64,(.+)$/i);
    if (!match) {
      return null;
    }
    return { buffer: Buffer.from(match[2], "base64"), mimeType: match[1] };
  }
  return null;
}

function extractMimeFromDataUrl(url?: string): string | null {
  if (!url?.startsWith("data:")) {
    return null;
  }
  const match = url.match(/^data:([^;]+);base64,/i);
  return match ? match[1] : null;
}

function extensionForMime(mimeType: string): string {
  switch (mimeType.toLowerCase()) {
    case "image/jpeg":
      return "jpg";
    case "image/webp":
      return "webp";
    case "image/gif":
      return "gif";
    default:
      return "png";
  }
}

function resolveOutputPath(
  index: number,
  created: number,
  extension: string,
  options: FileMaterializeOptions
): string {
  if (options.outputPathPattern) {
    const pattern = options.outputPathPattern.includes("{index}")
      ? options.outputPathPattern.split("{index}").join(String(index))
      : options.outputPathPattern;
    return path.isAbsolute(pattern)
      ? path.resolve(pattern)
      : path.resolve(options.outputBaseRoot, pattern);
  }
  const dirValue = options.outputDir ?? process.cwd();
  const dir = path.isAbsolute(dirValue)
    ? path.resolve(dirValue)
    : path.resolve(options.outputBaseRoot, dirValue);
  return path.join(dir, `image-${created}-${index}.${extension}`);
}

async function resolveOptionalImageInputToUrl(input: {
  image_path?: string;
  image_url?: string;
}): Promise<string | undefined> {
  if (input.image_path) {
    return imageDataUrlFromPath(input.image_path);
  }
  if (!input.image_url) {
    return undefined;
  }
  if (
    input.image_url.startsWith("data:image/") ||
    input.image_url.startsWith("http://") ||
    input.image_url.startsWith("https://")
  ) {
    return input.image_url;
  }
  throw typedError(
    "invalid_request",
    "image_url must be an http(s) URL or data:image/* URL."
  );
}
