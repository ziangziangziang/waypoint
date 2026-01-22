import { promises as fs } from "fs";
import path from "path";
import crypto from "crypto";
import { ChatSession, ChatMessage } from "../types";
import { StoragePaths, ensureStorageDir } from "./files";

/**
 * Session Repository
 * 
 * Manages chat sessions for the playground UI.
 * Sessions are stored as JSON files in ~/.cache/waypoint/sessions/
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
        const session = JSON.parse(raw) as ChatSession;
        session.createdAt = new Date(session.createdAt);
        session.updatedAt = new Date(session.updatedAt);
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
    const session = JSON.parse(raw) as ChatSession;
    session.createdAt = new Date(session.createdAt);
    session.updatedAt = new Date(session.updatedAt);
    
    // Parse message dates
    for (const message of session.messages) {
      message.createdAt = new Date(message.createdAt);
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
  patch: Partial<Pick<ChatSession, "name" | "model">>
): Promise<ChatSession | null> {
  const session = await getSession(paths, sessionId);
  if (!session) return null;
  
  const updated: ChatSession = {
    ...session,
    ...patch,
    updatedAt: new Date(),
  };
  
  await saveSession(paths, updated);
  return updated;
}

export async function deleteSession(paths: StoragePaths, sessionId: string): Promise<boolean> {
  const filePath = sessionFilePath(paths, sessionId);
  
  try {
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
  
  const newMessage: ChatMessage = {
    ...message,
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
}
