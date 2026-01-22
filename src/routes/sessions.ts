import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import {
  listSessions,
  getSession,
  createSession,
  updateSession,
  deleteSession,
  addMessage,
  appendMessageContent,
} from "../storage/sessionRepository";
import { storeImage, getImagePath, getCacheStats, clearCache } from "../storage/imageCache";
import { resolveStoragePaths } from "../storage/files";
import { ChatMessage } from "../types";
import { promises as fs } from "fs";
import path from "path";

/**
 * Sessions Routes
 * 
 * REST API for managing chat sessions in the playground.
 * 
 * Endpoints:
 *   GET    /admin/sessions           - List all sessions
 *   POST   /admin/sessions           - Create a new session
 *   GET    /admin/sessions/:id       - Get session by ID
 *   PUT    /admin/sessions/:id       - Update session metadata
 *   DELETE /admin/sessions/:id       - Delete a session
 *   POST   /admin/sessions/:id/messages - Add a message to session
 *   PATCH  /admin/sessions/:id/messages/:msgIndex - Append to message (streaming)
 * 
 *   GET    /admin/images/:hash       - Get cached image by hash
 *   POST   /admin/images             - Store image in cache
 *   GET    /admin/images/stats       - Get image cache stats
 *   DELETE /admin/images             - Clear image cache
 */

export async function registerSessionRoutes(app: FastifyInstance): Promise<void> {
  const paths = resolveStoragePaths();

  // ─────────────────────────────────────────────────────────────────────────────
  // Session CRUD
  // ─────────────────────────────────────────────────────────────────────────────

  app.get("/admin/sessions", async (_req: FastifyRequest, reply: FastifyReply) => {
    try {
      const sessions = await listSessions(paths);
      return reply.send({
        object: "list",
        data: sessions.map((s) => ({
          id: s.id,
          name: s.name,
          model: s.model,
          messageCount: s.messages.length,
          createdAt: s.createdAt,
          updatedAt: s.updatedAt,
        })),
      });
    } catch (error) {
      app.log.error(error, "Failed to list sessions");
      return reply.status(500).send({
        error: { message: "Failed to list sessions", type: "internal_error" },
      });
    }
  });

  app.post(
    "/admin/sessions",
    async (
      req: FastifyRequest<{ Body: { name?: string; model?: string } }>,
      reply: FastifyReply
    ) => {
      try {
        const { name, model } = req.body || {};
        const session = await createSession(paths, { name, model });
        return reply.status(201).send(session);
      } catch (error) {
        app.log.error(error, "Failed to create session");
        return reply.status(500).send({
          error: { message: "Failed to create session", type: "internal_error" },
        });
      }
    }
  );

  app.get(
    "/admin/sessions/:id",
    async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      try {
        const session = await getSession(paths, req.params.id);
        if (!session) {
          return reply.status(404).send({
            error: { message: "Session not found", type: "not_found" },
          });
        }
        return reply.send(session);
      } catch (error) {
        app.log.error(error, "Failed to get session");
        return reply.status(500).send({
          error: { message: "Failed to get session", type: "internal_error" },
        });
      }
    }
  );

  app.put(
    "/admin/sessions/:id",
    async (
      req: FastifyRequest<{ Params: { id: string }; Body: { name?: string; model?: string } }>,
      reply: FastifyReply
    ) => {
      try {
        const updates: Partial<{ name: string; model: string }> = {};
        if (req.body?.name !== undefined) updates.name = req.body.name;
        if (req.body?.model !== undefined) updates.model = req.body.model;

        const session = await updateSession(paths, req.params.id, updates);
        if (!session) {
          return reply.status(404).send({
            error: { message: "Session not found", type: "not_found" },
          });
        }
        return reply.send(session);
      } catch (error) {
        app.log.error(error, "Failed to update session");
        return reply.status(500).send({
          error: { message: "Failed to update session", type: "internal_error" },
        });
      }
    }
  );

  app.delete(
    "/admin/sessions/:id",
    async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      try {
        const deleted = await deleteSession(paths, req.params.id);
        if (!deleted) {
          return reply.status(404).send({
            error: { message: "Session not found", type: "not_found" },
          });
        }
        return reply.status(204).send();
      } catch (error) {
        app.log.error(error, "Failed to delete session");
        return reply.status(500).send({
          error: { message: "Failed to delete session", type: "internal_error" },
        });
      }
    }
  );

  // ─────────────────────────────────────────────────────────────────────────────
  // Message management
  // ─────────────────────────────────────────────────────────────────────────────

  app.post(
    "/admin/sessions/:id/messages",
    async (
      req: FastifyRequest<{ Params: { id: string }; Body: ChatMessage }>,
      reply: FastifyReply
    ) => {
      try {
        const message = await addMessage(paths, req.params.id, req.body);
        if (!message) {
          return reply.status(404).send({
            error: { message: "Session not found", type: "not_found" },
          });
        }
        return reply.status(201).send({
          messageId: message.id,
          createdAt: message.createdAt,
        });
      } catch (error) {
        app.log.error(error, "Failed to add message");
        return reply.status(500).send({
          error: { message: "Failed to add message", type: "internal_error" },
        });
      }
    }
  );

  app.patch(
    "/admin/sessions/:id/messages/:messageId",
    async (
      req: FastifyRequest<{
        Params: { id: string; messageId: string };
        Body: { content: string };
      }>,
      reply: FastifyReply
    ) => {
      try {
        const success = await appendMessageContent(
          paths,
          req.params.id,
          req.params.messageId,
          req.body?.content || ""
        );
        if (!success) {
          return reply.status(404).send({
            error: { message: "Session or message not found", type: "not_found" },
          });
        }
        return reply.send({ success: true });
      } catch (error) {
        app.log.error(error, "Failed to append to message");
        return reply.status(500).send({
          error: { message: "Failed to append to message", type: "internal_error" },
        });
      }
    }
  );

  // ─────────────────────────────────────────────────────────────────────────────
  // Image cache
  // ─────────────────────────────────────────────────────────────────────────────

  app.get("/admin/images/stats", async (_req: FastifyRequest, reply: FastifyReply) => {
    try {
      const stats = await getCacheStats(paths);
      return reply.send(stats);
    } catch (error) {
      app.log.error(error, "Failed to get image cache stats");
      return reply.status(500).send({
        error: { message: "Failed to get cache stats", type: "internal_error" },
      });
    }
  });

  app.get(
    "/admin/images/:hash",
    async (req: FastifyRequest<{ Params: { hash: string } }>, reply: FastifyReply) => {
      try {
        const imagePath = await getImagePath(paths, req.params.hash);
        if (!imagePath) {
          return reply.status(404).send({
            error: { message: "Image not found", type: "not_found" },
          });
        }

        const ext = path.extname(imagePath).slice(1);
        const mimeTypes: Record<string, string> = {
          png: "image/png",
          jpg: "image/jpeg",
          jpeg: "image/jpeg",
          gif: "image/gif",
          webp: "image/webp",
        };

        const buffer = await fs.readFile(imagePath);
        return reply
          .header("Content-Type", mimeTypes[ext] || "application/octet-stream")
          .header("Cache-Control", "public, max-age=31536000, immutable")
          .send(buffer);
      } catch (error) {
        app.log.error(error, "Failed to get image");
        return reply.status(500).send({
          error: { message: "Failed to get image", type: "internal_error" },
        });
      }
    }
  );

  app.post(
    "/admin/images",
    async (
      req: FastifyRequest<{ Body: { data: string; model?: string } }>,
      reply: FastifyReply
    ) => {
      try {
        if (!req.body?.data) {
          return reply.status(400).send({
            error: { message: "Missing image data", type: "invalid_request" },
          });
        }

        const result = await storeImage(paths, req.body.data, {
          model: req.body.model,
        });

        return reply.status(201).send({
          hash: result.hash,
          url: `/admin/images/${result.hash}`,
          evicted: result.evicted,
        });
      } catch (error) {
        app.log.error(error, "Failed to store image");
        return reply.status(500).send({
          error: { message: "Failed to store image", type: "internal_error" },
        });
      }
    }
  );

  app.delete("/admin/images", async (_req: FastifyRequest, reply: FastifyReply) => {
    try {
      const deleted = await clearCache(paths);
      return reply.send({ deleted });
    } catch (error) {
      app.log.error(error, "Failed to clear image cache");
      return reply.status(500).send({
        error: { message: "Failed to clear cache", type: "internal_error" },
      });
    }
  });
}
