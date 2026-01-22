import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { StoragePaths } from "../storage/files";
import {
  listMcpServers,
  getMcpServer,
  addMcpServer,
  updateMcpServer,
  removeMcpServer,
} from "../mcp/registry";
import {
  discoverAllTools,
  discoverServerTools,
  getCachedTools,
  getCachedToolsForServer,
  executeTool,
  disconnectServer,
  isServerConnected,
} from "../mcp/discovery";

/**
 * MCP Routes
 * 
 * Admin API for managing MCP servers and tools.
 * 
 * Endpoints:
 *   GET    /admin/mcp/servers           - List all MCP servers
 *   POST   /admin/mcp/servers           - Add a new MCP server
 *   GET    /admin/mcp/servers/:id       - Get server by ID
 *   PUT    /admin/mcp/servers/:id       - Update server
 *   DELETE /admin/mcp/servers/:id       - Remove server
 *   POST   /admin/mcp/servers/:id/connect    - Connect and discover tools
 *   POST   /admin/mcp/servers/:id/disconnect - Disconnect from server
 * 
 *   GET    /admin/mcp/tools             - List all discovered tools
 *   POST   /admin/mcp/tools/discover    - Discover tools from all servers
 *   POST   /admin/mcp/tools/execute     - Execute a tool
 */

export async function registerMcpRoutes(
  app: FastifyInstance,
  paths: StoragePaths
): Promise<void> {
  // ─────────────────────────────────────────────────────────────────────────────
  // Server management
  // ─────────────────────────────────────────────────────────────────────────────

  app.get("/admin/mcp/servers", async (_req: FastifyRequest, reply: FastifyReply) => {
    try {
      const servers = await listMcpServers(paths);
      return reply.send({
        object: "list",
        data: servers.map((s) => ({
          ...s,
          connected: isServerConnected(s.id),
        })),
      });
    } catch (error) {
      app.log.error(error, "Failed to list MCP servers");
      return reply.status(500).send({
        error: { message: "Failed to list servers", type: "internal_error" },
      });
    }
  });

  app.post(
    "/admin/mcp/servers",
    async (
      req: FastifyRequest<{ Body: { name: string; url: string; enabled?: boolean } }>,
      reply: FastifyReply
    ) => {
      try {
        if (!req.body?.name || !req.body?.url) {
          return reply.status(400).send({
            error: { message: "name and url are required", type: "invalid_request" },
          });
        }

        const server = await addMcpServer(paths, req.body);
        return reply.status(201).send(server);
      } catch (error) {
        if ((error as Error).message.includes("already exists")) {
          return reply.status(409).send({
            error: { message: (error as Error).message, type: "conflict" },
          });
        }
        app.log.error(error, "Failed to add MCP server");
        return reply.status(500).send({
          error: { message: "Failed to add server", type: "internal_error" },
        });
      }
    }
  );

  app.get(
    "/admin/mcp/servers/:id",
    async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      try {
        const server = await getMcpServer(paths, req.params.id);
        if (!server) {
          return reply.status(404).send({
            error: { message: "Server not found", type: "not_found" },
          });
        }
        return reply.send({
          ...server,
          connected: isServerConnected(server.id),
          tools: getCachedToolsForServer(server.id),
        });
      } catch (error) {
        app.log.error(error, "Failed to get MCP server");
        return reply.status(500).send({
          error: { message: "Failed to get server", type: "internal_error" },
        });
      }
    }
  );

  app.put(
    "/admin/mcp/servers/:id",
    async (
      req: FastifyRequest<{
        Params: { id: string };
        Body: { name?: string; url?: string; enabled?: boolean };
      }>,
      reply: FastifyReply
    ) => {
      try {
        const server = await updateMcpServer(paths, req.params.id, req.body || {});
        if (!server) {
          return reply.status(404).send({
            error: { message: "Server not found", type: "not_found" },
          });
        }
        return reply.send(server);
      } catch (error) {
        app.log.error(error, "Failed to update MCP server");
        return reply.status(500).send({
          error: { message: "Failed to update server", type: "internal_error" },
        });
      }
    }
  );

  app.delete(
    "/admin/mcp/servers/:id",
    async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      try {
        // Disconnect first
        await disconnectServer(req.params.id);

        const deleted = await removeMcpServer(paths, req.params.id);
        if (!deleted) {
          return reply.status(404).send({
            error: { message: "Server not found", type: "not_found" },
          });
        }
        return reply.status(204).send();
      } catch (error) {
        app.log.error(error, "Failed to remove MCP server");
        return reply.status(500).send({
          error: { message: "Failed to remove server", type: "internal_error" },
        });
      }
    }
  );

  app.post(
    "/admin/mcp/servers/:id/connect",
    async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      try {
        const server = await getMcpServer(paths, req.params.id);
        if (!server) {
          return reply.status(404).send({
            error: { message: "Server not found", type: "not_found" },
          });
        }

        const tools = await discoverServerTools(paths, server);
        return reply.send({
          connected: true,
          toolCount: tools.length,
          tools: tools.map((t) => ({ name: t.name, description: t.description })),
        });
      } catch (error) {
        app.log.error(error, "Failed to connect to MCP server");
        return reply.status(500).send({
          error: { message: "Failed to connect", type: "connection_error" },
        });
      }
    }
  );

  app.post(
    "/admin/mcp/servers/:id/disconnect",
    async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      try {
        await disconnectServer(req.params.id);
        return reply.send({ disconnected: true });
      } catch (error) {
        app.log.error(error, "Failed to disconnect from MCP server");
        return reply.status(500).send({
          error: { message: "Failed to disconnect", type: "internal_error" },
        });
      }
    }
  );

  // ─────────────────────────────────────────────────────────────────────────────
  // Tool management
  // ─────────────────────────────────────────────────────────────────────────────

  app.get("/admin/mcp/tools", async (_req: FastifyRequest, reply: FastifyReply) => {
    try {
      const tools = getCachedTools();
      return reply.send({
        object: "list",
        data: tools,
      });
    } catch (error) {
      app.log.error(error, "Failed to list tools");
      return reply.status(500).send({
        error: { message: "Failed to list tools", type: "internal_error" },
      });
    }
  });

  app.post("/admin/mcp/tools/discover", async (_req: FastifyRequest, reply: FastifyReply) => {
    try {
      const tools = await discoverAllTools(paths);
      return reply.send({
        discovered: tools.length,
        tools: tools.map((t) => ({
          name: t.name,
          description: t.description,
          serverName: t.serverName,
        })),
      });
    } catch (error) {
      app.log.error(error, "Failed to discover tools");
      return reply.status(500).send({
        error: { message: "Failed to discover tools", type: "internal_error" },
      });
    }
  });

  app.post(
    "/admin/mcp/tools/execute",
    async (
      req: FastifyRequest<{ Body: { name: string; arguments: Record<string, unknown> } }>,
      reply: FastifyReply
    ) => {
      try {
        if (!req.body?.name) {
          return reply.status(400).send({
            error: { message: "Tool name is required", type: "invalid_request" },
          });
        }

        const result = await executeTool(req.body.name, req.body.arguments ?? {});
        
        if (result.isError) {
          return reply.status(500).send({
            error: { message: result.content, type: "tool_error" },
          });
        }

        return reply.send({
          result: result.content,
        });
      } catch (error) {
        app.log.error(error, "Failed to execute tool");
        return reply.status(500).send({
          error: { message: "Failed to execute tool", type: "internal_error" },
        });
      }
    }
  );
}
