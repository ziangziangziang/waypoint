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
import { storeMedia, getMediaPath, getMediaEntry, getCacheStats, clearCache, ensureMediaCacheReady } from "../storage/imageCache";
import { resolveStoragePaths } from "../storage/files";
import { ChatMessage } from "../types";
import { promises as fs } from "fs";
import path from "path";
import { routeRequest } from "../routing/router";
import { pickBestModelByCapabilities } from "../storage/repositories";

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
  await ensureMediaCacheReady(paths);
  app.log.info({ mediaRoot: path.join(paths.baseDir, "media") }, "Media cache initialized");

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
          storageVersion: s.storageVersion,
          titleStatus: s.titleStatus,
          titleUpdatedAt: s.titleUpdatedAt,
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
        return reply.status(201).send(toApiSession(session));
      } catch (error) {
        app.log.error(error, "Failed to create session");
        return reply.status(500).send({
          error: { message: "Failed to create session", type: "internal_error" },
        });
      }
    }
  );

  app.post(
    "/admin/sessions/:id/auto-title",
    async (
      req: FastifyRequest<{ Params: { id: string }; Body: { model?: string; seedText?: string } }>,
      reply: FastifyReply
    ) => {
      try {
        const session = await getSession(paths, req.params.id);
        if (!session) {
          return reply.status(404).send({
            error: { message: "Session not found", type: "not_found" },
          });
        }

        const seedText =
          req.body?.seedText?.trim() || extractSeedTextFromSession(session.messages);
        if (!seedText) {
          return reply.status(400).send({
            error: { message: "seedText is required for auto-title", type: "invalid_request" },
          });
        }

        const model =
          req.body?.model ||
          session.model ||
          (await pickBestModelByCapabilities(
            paths,
            { requiredInput: ["text"], requiredOutput: ["text"] },
            "llm"
          ));

        let generated = false;
        let title = fallbackTitleFromSeed(seedText);

        if (model) {
          try {
            title = await generateTitleFromModel(paths, model, seedText);
            generated = true;
          } catch (error) {
            app.log.warn(error, "Auto-title generation failed, using fallback title");
          }
        }

        const updated = await updateSession(paths, req.params.id, {
          name: title,
          titleStatus: generated ? "generated" : "failed",
          titleUpdatedAt: new Date(),
        });
        if (!updated) {
          return reply.status(404).send({
            error: { message: "Session not found", type: "not_found" },
          });
        }
        return reply.send({
          id: updated.id,
          name: updated.name,
          titleStatus: updated.titleStatus,
          titleUpdatedAt: updated.titleUpdatedAt,
          generated,
          model,
        });
      } catch (error) {
        app.log.error(error, "Failed to auto-title session");
        return reply.status(500).send({
          error: { message: "Failed to auto-title session", type: "internal_error" },
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
        return reply.send(toApiSession(session));
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
        return reply.send(toApiSession(session));
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
      req: FastifyRequest<{ Params: { id: string }; Body: IncomingChatMessage }>,
      reply: FastifyReply
    ) => {
      try {
        const message = await addMessage(paths, req.params.id, normalizeIncomingMessage(req.body));
        
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
  // Media cache (/admin/media) with image alias compatibility (/admin/images)
  // ─────────────────────────────────────────────────────────────────────────────
  registerMediaCacheRoutes("/admin/media");
  registerMediaCacheRoutes("/admin/images");

  function registerMediaCacheRoutes(prefix: "/admin/media" | "/admin/images"): void {
    app.get(`${prefix}/stats`, async (_req: FastifyRequest, reply: FastifyReply) => {
      try {
        const stats = await getCacheStats(paths);
        return reply.send(stats);
      } catch (error) {
        app.log.error(error, "Failed to get media cache stats");
        return reply.status(500).send({
          error: { message: "Failed to get cache stats", type: "internal_error" },
        });
      }
    });

    app.get(
      `${prefix}/:hash`,
      async (req: FastifyRequest<{ Params: { hash: string } }>, reply: FastifyReply) => {
        try {
          const filePath = await getMediaPath(paths, req.params.hash);
          const entry = await getMediaEntry(paths, req.params.hash);
          if (!filePath || !entry) {
            return reply.status(404).send({
              error: { message: "Media not found", type: "not_found" },
            });
          }

          const buffer = await fs.readFile(filePath);
          return reply
            .header("Content-Type", entry.mimeType || guessMimeType(filePath))
            .header("Cache-Control", "public, max-age=31536000, immutable")
            .send(buffer);
        } catch (error) {
          app.log.error(error, "Failed to get media");
          return reply.status(500).send({
            error: { message: "Failed to get media", type: "internal_error" },
          });
        }
      }
    );

    app.post(
      `${prefix}`,
      async (
        req: FastifyRequest<{ Body: { data: string; model?: string; mimeType?: string } }>,
        reply: FastifyReply
      ) => {
        try {
          if (!req.body?.data) {
            return reply.status(400).send({
              error: { message: "Missing media data", type: "invalid_request" },
            });
          }

          const result = await storeMedia(paths, req.body.data, {
            model: req.body.model,
            mimeType: req.body.mimeType,
          });

          return reply.status(201).send({
            hash: result.hash,
            mimeType: result.mimeType,
            url: `${prefix}/${result.hash}`,
            evicted: result.evicted,
          });
        } catch (error) {
          app.log.error(error, "Failed to store media");
          return reply.status(500).send({
            error: { message: "Failed to store media", type: "internal_error" },
          });
        }
      }
    );

    app.delete(`${prefix}`, async (_req: FastifyRequest, reply: FastifyReply) => {
      try {
        const deleted = await clearCache(paths);
        return reply.send({ deleted });
      } catch (error) {
        app.log.error(error, "Failed to clear media cache");
        return reply.status(500).send({
          error: { message: "Failed to clear cache", type: "internal_error" },
        });
      }
    });
  }
}

type IncomingChatMessage = Partial<ChatMessage> & { timestamp?: string };

function normalizeIncomingMessage(body: IncomingChatMessage): Omit<ChatMessage, "id" | "createdAt"> {
  return {
    role: (body.role as ChatMessage["role"]) ?? "user",
    content: body.content ?? "",
    name: body.name,
    tool_calls: body.tool_calls,
    tool_call_id: body.tool_call_id,
    images: body.images,
  };
}

function toApiSession(session: {
  id: string;
  name: string;
  model?: string;
  titleStatus?: "pending" | "generated" | "manual" | "failed";
  titleUpdatedAt?: Date;
  storageVersion: number;
  messages: ChatMessage[];
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    ...session,
    messages: session.messages.map((message) => ({
      ...message,
      timestamp: message.createdAt,
    })),
  };
}

function guessMimeType(filePath: string): string {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  const mimeTypes: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    wav: "audio/wav",
    mp3: "audio/mpeg",
    ogg: "audio/ogg",
    webm: "audio/webm",
    m4a: "audio/mp4",
  };
  return mimeTypes[ext] ?? "application/octet-stream";
}

function extractSeedTextFromSession(messages: ChatMessage[]): string {
  const firstUserMessage = messages.find((message) => message.role === "user");
  if (!firstUserMessage) {
    return "";
  }
  return textFromContent(firstUserMessage.content);
}

function textFromContent(content: ChatMessage["content"]): string {
  if (typeof content === "string") {
    return content.trim();
  }
  if (!Array.isArray(content)) {
    return "";
  }
  const parts: string[] = [];
  for (const part of content) {
    if (part.type === "text") {
      parts.push(part.text);
    }
  }
  return parts.join(" ").trim();
}

function fallbackTitleFromSeed(seed: string): string {
  const cleaned = sanitizeTitle(seed);
  if (!cleaned) {
    return "New Session";
  }
  const words = cleaned.split(/\s+/).slice(0, 7).join(" ");
  return words.length > 60 ? words.slice(0, 60).trim() : words;
}

async function generateTitleFromModel(paths: ReturnType<typeof resolveStoragePaths>, model: string, seedText: string): Promise<string> {
  const prompt = [
    "Generate a short title for this chat.",
    "Rules: 3-7 words, sentence case, no quotes, no punctuation at end.",
    "Return only the title text.",
    `Chat seed: ${seedText}`,
  ].join("\n");

  const payload: Record<string, unknown> = {
    model,
    stream: false,
    temperature: 0,
    max_tokens: 32,
    messages: [
      {
        role: "system",
        content: "You write concise conversation titles.",
      },
      {
        role: "user",
        content: prompt,
      },
    ],
  };

  const outcome = await routeRequest(
    paths,
    model,
    "/v1/chat/completions",
    payload,
    {},
    AbortSignal.timeout(15_000),
    {
      requiredInput: ["text"],
      requiredOutput: ["text"],
    }
  );

  const payloadJson = await readJsonBody(outcome.attempt.response.body);
  const text = extractAssistantText(payloadJson);
  const sanitized = sanitizeTitle(text);
  if (!sanitized) {
    throw new Error("Model did not return a valid title");
  }
  return sanitized;
}

async function readJsonBody(stream: NodeJS.ReadableStream): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return JSON.parse(text);
}

function extractAssistantText(payload: unknown): string {
  if (!payload || typeof payload !== "object") {
    return "";
  }
  const choices = (payload as { choices?: Array<{ message?: { content?: unknown } }> }).choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    return "";
  }
  const content = choices[0]?.message?.content;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  const parts: string[] = [];
  for (const part of content) {
    if (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") {
      parts.push((part as { text: string }).text);
    }
  }
  return parts.join(" ");
}

function sanitizeTitle(input: string): string {
  const normalized = input
    .replace(/[\r\n]+/g, " ")
    .replace(/["'`]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const trimmed = normalized.replace(/[.,;:!?]+$/g, "").trim();
  if (!trimmed) {
    return "";
  }
  return trimmed.length > 60 ? trimmed.slice(0, 60).trim() : trimmed;
}
