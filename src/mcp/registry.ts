import { promises as fs } from "fs";
import path from "path";
import crypto from "crypto";
import YAML from "yaml";
import { McpServer } from "../types";
import { StoragePaths, ensureStorageDir } from "../storage/files";

/**
 * MCP Server Registry
 * 
 * Stores registered MCP servers in ~/.cache/waypoint/mcp-servers.yaml
 */

interface McpServersFile {
  servers: McpServer[];
}

function mcpServersPath(paths: StoragePaths): string {
  return path.join(paths.baseDir, "mcp-servers.yaml");
}

async function ensureMcpDir(paths: StoragePaths): Promise<void> {
  await ensureStorageDir(paths);
}

async function loadServersFile(paths: StoragePaths): Promise<McpServersFile> {
  await ensureMcpDir(paths);
  const filePath = mcpServersPath(paths);

  try {
    const raw = await fs.readFile(filePath, "utf8");
    const doc = YAML.parse(raw) as McpServersFile | null;
    if (doc?.servers) {
      return doc;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  return { servers: [] };
}

async function saveServersFile(paths: StoragePaths, data: McpServersFile): Promise<void> {
  const filePath = mcpServersPath(paths);
  const yaml = YAML.stringify(data, { indent: 2 });
  await fs.writeFile(filePath, yaml, "utf8");
}

/**
 * List all registered MCP servers.
 */
export async function listMcpServers(paths: StoragePaths): Promise<McpServer[]> {
  const file = await loadServersFile(paths);
  return file.servers;
}

/**
 * Get a single MCP server by ID.
 */
export async function getMcpServer(paths: StoragePaths, id: string): Promise<McpServer | null> {
  const servers = await listMcpServers(paths);
  return servers.find((s) => s.id === id) ?? null;
}

/**
 * Add a new MCP server to the registry.
 */
export async function addMcpServer(
  paths: StoragePaths,
  input: { name: string; url: string; enabled?: boolean }
): Promise<McpServer> {
  const file = await loadServersFile(paths);

  // Check for duplicate URL
  if (file.servers.some((s) => s.url === input.url)) {
    throw new Error(`Server with URL ${input.url} already exists`);
  }

  const now = new Date();
  const server: McpServer = {
    id: crypto.randomUUID(),
    name: input.name,
    url: input.url,
    enabled: input.enabled ?? true,
    status: "unknown",
    createdAt: now,
    updatedAt: now,
  };

  file.servers.push(server);
  await saveServersFile(paths, file);

  return server;
}

/**
 * Update an existing MCP server.
 */
export async function updateMcpServer(
  paths: StoragePaths,
  id: string,
  patch: Partial<Pick<McpServer, "name" | "url" | "enabled">>
): Promise<McpServer | null> {
  const file = await loadServersFile(paths);
  const index = file.servers.findIndex((s) => s.id === id);

  if (index === -1) {
    return null;
  }

  const server = file.servers[index];
  const updated: McpServer = {
    ...server,
    ...patch,
    updatedAt: new Date(),
  };

  file.servers[index] = updated;
  await saveServersFile(paths, file);

  return updated;
}

/**
 * Remove an MCP server from the registry.
 */
export async function removeMcpServer(paths: StoragePaths, id: string): Promise<boolean> {
  const file = await loadServersFile(paths);
  const index = file.servers.findIndex((s) => s.id === id);

  if (index === -1) {
    return false;
  }

  file.servers.splice(index, 1);
  await saveServersFile(paths, file);

  return true;
}

/**
 * Update server status after connection attempt.
 */
export async function updateMcpServerStatus(
  paths: StoragePaths,
  id: string,
  status: "connected" | "disconnected" | "error" | "unknown",
  toolCount?: number
): Promise<void> {
  const file = await loadServersFile(paths);
  const server = file.servers.find((s) => s.id === id);

  if (server) {
    server.status = status;
    if (toolCount !== undefined) {
      server.toolCount = toolCount;
    }
    server.lastConnectedAt = status === "connected" ? new Date() : server.lastConnectedAt;
    server.updatedAt = new Date();
    await saveServersFile(paths, file);
  }
}
