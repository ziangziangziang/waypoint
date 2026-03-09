import { promises as fs } from "fs";
import path from "path";
import crypto from "crypto";
import { ChatSession, ChatMessage } from "../types";
import { StoragePaths, ensureStorageDir } from "./files";
import { storeMedia, syncSessionMediaReferences, unmarkSessionMediaReferences } from "./imageCache";

/**
 * Session Repository
 * 
 * Manages chat sessions for the playground UI.
 * Sessions are stored as JSON files in ~/.config/waypoint/sessions/
 */

export function resolveSessionsDir(paths: StoragePaths): string {
  return path.join(paths.baseDir, "sessions");
}

async function ensureSessionsDir(paths: StoragePaths): Promise<void> {
  await ensureStorageDir(paths);
  const sessionsDir = resolveSessionsDir(paths);
  await fs.mkdir(sessionsDir, { recursive: true });
}

function sessionFilePath(paths: StoragePaths, sessionId: string): string {
  return path.join(resolveSessionsDir(paths), `${sessionId}.json`);
}

export async function listSessions(paths: StoragePaths): Promise<ChatSession[]> {
  await ensureSessionsDir(paths);
  const sessionsDir = resolveSessionsDir(paths);
  
  try {
    const files = await fs.readdir(sessionsDir);
    const sessions: ChatSession[] = [];
    
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      
      try {
        const filePath = path.join(sessionsDir, file);
        const raw = await fs.readFile(filePath, "utf8");
        let session = parseSession(JSON.parse(raw) as ChatSession);
        const migrated = await migrateSessionMediaRefs(paths, session);
        if (migrated.changed) {
          session = migrated.session;
          await saveSession(paths, session);
        }
        sessions.push(session);
      } catch {
        // Skip malformed session files
      }
    }
    
    // Sort by updatedAt descending (most recent first)
    return sessions.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

export async function getSession(paths: StoragePaths, sessionId: string): Promise<ChatSession | null> {
  await ensureSessionsDir(paths);
  const filePath = sessionFilePath(paths, sessionId);
  
  try {
    const raw = await fs.readFile(filePath, "utf8");
    let session = parseSession(JSON.parse(raw) as ChatSession);
    const migrated = await migrateSessionMediaRefs(paths, session);
    if (migrated.changed) {
      session = migrated.session;
      await saveSession(paths, session);
    }
    return session;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export async function createSession(
  paths: StoragePaths,
  input: { name?: string; model?: string }
): Promise<ChatSession> {
  await ensureSessionsDir(paths);
  
  const now = new Date();
  const session: ChatSession = {
    id: crypto.randomUUID(),
    name: input.name ?? `Session ${now.toLocaleDateString()}`,
    model: input.model,
    titleStatus: input.name ? "manual" : "pending",
    titleUpdatedAt: now,
    storageVersion: 2,
    messages: [],
    createdAt: now,
    updatedAt: now,
  };
  
  await saveSession(paths, session);
  return session;
}

export async function updateSession(
  paths: StoragePaths,
  sessionId: string,
  patch: Partial<Pick<ChatSession, "name" | "model" | "titleStatus" | "titleUpdatedAt">>
): Promise<ChatSession | null> {
  const session = await getSession(paths, sessionId);
  if (!session) return null;
  
  const titleStatus =
    patch.titleStatus ??
    (patch.name !== undefined ? "manual" : session.titleStatus);
  const titleUpdatedAt =
    patch.titleUpdatedAt ??
    (patch.name !== undefined || patch.titleStatus !== undefined ? new Date() : session.titleUpdatedAt);

  const updated: ChatSession = {
    ...session,
    ...patch,
    titleStatus,
    titleUpdatedAt,
    updatedAt: new Date(),
  };
  
  await saveSession(paths, updated);
  return updated;
}

export async function deleteSession(paths: StoragePaths, sessionId: string): Promise<boolean> {
  const filePath = sessionFilePath(paths, sessionId);
  
  try {
    await unmarkSessionMediaReferences(paths, sessionId);
    await fs.unlink(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export async function addMessage(
  paths: StoragePaths,
  sessionId: string,
  message: Omit<ChatMessage, "id" | "createdAt">
): Promise<ChatMessage | null> {
  const session = await getSession(paths, sessionId);
  if (!session) return null;

  const normalizedMessage = await normalizeMessageMediaRefs(paths, message);
  
  const newMessage: ChatMessage = {
    ...normalizedMessage,
    id: crypto.randomUUID(),
    createdAt: new Date(),
  };
  
  session.messages.push(newMessage);
  session.updatedAt = new Date();
  
  await saveSession(paths, session);
  return newMessage;
}

export async function appendMessageContent(
  paths: StoragePaths,
  sessionId: string,
  messageId: string,
  content: string
): Promise<boolean> {
  const session = await getSession(paths, sessionId);
  if (!session) return false;
  
  const message = session.messages.find((m) => m.id === messageId);
  if (!message) return false;
  
  message.content = (message.content ?? "") + content;
  session.updatedAt = new Date();
  
  await saveSession(paths, session);
  return true;
}

async function saveSession(paths: StoragePaths, session: ChatSession): Promise<void> {
  const filePath = sessionFilePath(paths, session.id);
  const json = JSON.stringify(session, null, 2);
  await fs.writeFile(filePath, json, "utf8");
  await syncSessionMediaReferences(paths, session.id, extractMediaHashesFromSession(session));
}

function parseSession(raw: ChatSession): ChatSession {
  const session: ChatSession = {
    ...raw,
    storageVersion: typeof raw.storageVersion === "number" ? raw.storageVersion : 1,
    titleStatus:
      raw.titleStatus === "pending" ||
      raw.titleStatus === "generated" ||
      raw.titleStatus === "manual" ||
      raw.titleStatus === "failed"
        ? raw.titleStatus
        : undefined,
    titleUpdatedAt: raw.titleUpdatedAt ? new Date(raw.titleUpdatedAt) : undefined,
    createdAt: new Date(raw.createdAt),
    updatedAt: new Date(raw.updatedAt),
    messages: Array.isArray(raw.messages)
      ? raw.messages.map((message) => ({
          ...message,
          createdAt: parseMessageDate(message),
        }))
      : [],
  };

  return session;
}

function parseMessageDate(message: ChatMessage & { timestamp?: string }): Date {
  if (message.createdAt) {
    return new Date(message.createdAt);
  }
  if (typeof message.timestamp === "string") {
    return new Date(message.timestamp);
  }
  return new Date();
}

async function migrateSessionMediaRefs(
  paths: StoragePaths,
  session: ChatSession
): Promise<{ session: ChatSession; changed: boolean }> {
  let changed = false;
  const migratedMessages: ChatMessage[] = [];

  for (const message of session.messages) {
    const normalized = await normalizeMessageMediaRefs(paths, message);
    if (!changed && JSON.stringify(normalized) !== JSON.stringify(message)) {
      changed = true;
    }
    migratedMessages.push({
      ...normalized,
      id: message.id,
      createdAt: message.createdAt,
    });
  }

  const nextStorageVersion = session.storageVersion >= 2 ? session.storageVersion : 2;
  if (nextStorageVersion !== session.storageVersion) {
    changed = true;
  }

  if (!changed) {
    return { session, changed: false };
  }

  return {
    changed: true,
    session: {
      ...session,
      storageVersion: nextStorageVersion,
      messages: migratedMessages,
      updatedAt: new Date(),
    },
  };
}

async function normalizeMessageMediaRefs(
  paths: StoragePaths,
  message: Omit<ChatMessage, "id" | "createdAt"> | ChatMessage
): Promise<Omit<ChatMessage, "id" | "createdAt">> {
  const next: Omit<ChatMessage, "id" | "createdAt"> = {
    role: message.role,
    content: message.content ?? "",
    name: message.name,
    tool_calls: message.tool_calls,
    tool_call_id: message.tool_call_id,
    images: message.images,
  };

  // Normalize convenience image list
  if (Array.isArray(next.images)) {
    const normalizedImages: string[] = [];
    for (const value of next.images) {
      const cachedUrl = await normalizeImageRefToLocalUrl(paths, value);
      normalizedImages.push(cachedUrl ?? value);
    }
    next.images = normalizedImages;
  }

  // Normalize image_url parts in content
  if (Array.isArray(next.content)) {
    const normalizedContent = [];
    for (const part of next.content) {
      if (
        part &&
        typeof part === "object" &&
        part.type === "image_url" &&
        part.image_url &&
        typeof part.image_url.url === "string"
      ) {
        const normalizedUrl = await normalizeImageRefToLocalUrl(paths, part.image_url.url);
        normalizedContent.push({
          ...part,
          image_url: {
            ...part.image_url,
            url: normalizedUrl ?? part.image_url.url,
          },
        });
      } else {
        normalizedContent.push(part);
      }
    }
    next.content = normalizedContent;
  }

  return next;
}

async function normalizeImageRefToLocalUrl(paths: StoragePaths, value: string): Promise<string | null> {
  const trimmed = value.trim();
  if (!trimmed) return null;

  const localHash = extractLocalMediaHash(trimmed);
  if (localHash) {
    return `/admin/media/${localHash}`;
  }

  if (/^[a-f0-9]{16}$/i.test(trimmed)) {
    return `/admin/media/${trimmed.toLowerCase()}`;
  }

  if (trimmed.startsWith("data:image/")) {
    try {
      const cached = await storeMedia(paths, trimmed);
      return `/admin/media/${cached.hash}`;
    } catch {
      return null;
    }
  }

  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const response = await fetch(trimmed, { signal: AbortSignal.timeout(10_000) });
      if (!response.ok) return null;
      const contentType = response.headers.get("content-type") ?? undefined;
      const buffer = Buffer.from(await response.arrayBuffer());
      const cached = await storeMedia(paths, buffer, { mimeType: contentType });
      return `/admin/media/${cached.hash}`;
    } catch {
      return null;
    }
  }

  return null;
}

function extractLocalMediaHash(value: string): string | null {
  if (value.startsWith("/")) {
    const match = value.match(/^\/admin\/(?:media|images)\/([a-f0-9]{16})$/i);
    return match ? match[1].toLowerCase() : null;
  }
  try {
    const parsed = new URL(value);
    if (!["http:", "https:"].includes(parsed.protocol)) return null;
    if (!["localhost", "127.0.0.1", "::1"].includes(parsed.hostname)) return null;
    const match = parsed.pathname.match(/^\/admin\/(?:media|images)\/([a-f0-9]{16})$/i);
    return match ? match[1].toLowerCase() : null;
  } catch {
    return null;
  }
}

function extractMediaHashesFromSession(session: ChatSession): string[] {
  const hashes = new Set<string>();
  for (const message of session.messages) {
    if (Array.isArray(message.images)) {
      for (const imageRef of message.images) {
        const hash = extractLocalMediaHash(imageRef);
        if (hash) hashes.add(hash);
      }
    }
    if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (
          part &&
          typeof part === "object" &&
          part.type === "image_url" &&
          part.image_url &&
          typeof part.image_url.url === "string"
        ) {
          const hash = extractLocalMediaHash(part.image_url.url);
          if (hash) hashes.add(hash);
        }
      }
    }
  }
  return Array.from(hashes);
}
