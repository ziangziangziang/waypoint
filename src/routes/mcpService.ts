import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { StoragePaths } from "../storage/files";
import {
  createMcpService,
  McpService,
  McpServiceDependencyOverrides,
} from "../mcp/service";

let activeMcpService: McpService | null = null;

export async function registerMcpServiceRoutes(
  app: FastifyInstance,
  paths: StoragePaths,
  deps?: McpServiceDependencyOverrides
): Promise<void> {
  const mcpService = createMcpService(paths, deps);
  activeMcpService = mcpService;

  app.route({
    method: ["GET", "POST", "DELETE"],
    url: "/mcp",
    handler: async (req: FastifyRequest, reply: FastifyReply) => {
      if (!isLocalRequest(req)) {
        reply.code(403).send({
          error: {
            message: "Forbidden: /mcp is restricted to localhost",
            type: "forbidden",
          },
        });
        return;
      }

      if (req.method === "GET") {
        reply.code(405).header("Allow", "POST, DELETE").send("Method Not Allowed");
        return;
      }

      await mcpService.handleRequest(req.raw, reply.raw, req.body);
      reply.hijack();
    },
  });
}

export async function closeMcpServiceRoutes(): Promise<void> {
  if (!activeMcpService) {
    return;
  }
  await activeMcpService.close();
  activeMcpService = null;
}

function isLocalRequest(req: FastifyRequest): boolean {
  const address = normalizeAddress(req.ip ?? req.socket.remoteAddress);
  if (address && !isLocalHost(address)) {
    return false;
  }

  const hostCandidates = [
    firstHeaderValue(req.headers.host),
    firstHeaderValue(req.headers["x-forwarded-host"]),
    extractHostFromOrigin(firstHeaderValue(req.headers.origin)),
  ]
    .map((value) => normalizeHost(value))
    .filter((value): value is string => Boolean(value));

  return hostCandidates.every((host) => isLocalHost(host));
}

function firstHeaderValue(header: string | string[] | undefined): string | undefined {
  if (typeof header === "string") {
    return header;
  }
  if (Array.isArray(header) && header.length > 0) {
    return header[0];
  }
  return undefined;
}

function extractHostFromOrigin(origin: string | undefined): string | undefined {
  if (!origin) return undefined;
  try {
    const parsed = new URL(origin);
    return parsed.host;
  } catch {
    return undefined;
  }
}

function normalizeHost(value: string | undefined): string | null {
  if (!value) return null;
  const host = value.split(",")[0].trim().toLowerCase();
  if (!host) return null;
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    if (end > -1) {
      return host.slice(1, end);
    }
  }
  return host.split(":")[0];
}

function normalizeAddress(value: string | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return null;
  if (trimmed.startsWith("::ffff:")) {
    return trimmed.replace("::ffff:", "");
  }
  return trimmed;
}

function isLocalHost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}
