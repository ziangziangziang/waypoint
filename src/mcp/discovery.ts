import { McpServer, McpTool } from "../types";
import { StoragePaths } from "../storage/files";
import { listMcpServers, updateMcpServerStatus } from "./registry";
import { McpClient, createMcpClient, McpToolSchema, McpError } from "./client";

/**
 * MCP Tool Discovery
 * 
 * Connects to registered MCP servers and discovers available tools.
 * Maintains an in-memory cache of tools and their source servers.
 */

interface DiscoveredTool extends McpTool {
  serverId: string;
  serverName: string;
  serverUrl: string;
}

// In-memory cache of discovered tools
const toolsCache: Map<string, DiscoveredTool[]> = new Map();

// Active client connections
const activeClients: Map<string, McpClient> = new Map();

/**
 * Connect to a single MCP server and discover its tools.
 */
export async function discoverServerTools(
  paths: StoragePaths,
  server: McpServer
): Promise<DiscoveredTool[]> {
  if (!server.enabled) {
    return [];
  }

  try {
    // Create client and connect
    const client = await createMcpClient(server.url);
    activeClients.set(server.id, client);

    // Discover tools
    const toolSchemas = await client.listTools();
    const tools: DiscoveredTool[] = toolSchemas.map((schema) => ({
      name: schema.name,
      description: schema.description,
      inputSchema: schema.inputSchema,
      serverId: server.id,
      serverName: server.name,
      serverUrl: server.url,
    }));

    // Update server status
    await updateMcpServerStatus(paths, server.id, "connected", tools.length);

    // Cache tools
    toolsCache.set(server.id, tools);

    return tools;
  } catch (error) {
    console.error(`Failed to discover tools from ${server.name}:`, error);
    await updateMcpServerStatus(paths, server.id, "error");
    toolsCache.delete(server.id);
    return [];
  }
}

/**
 * Discover tools from all enabled MCP servers.
 */
export async function discoverAllTools(paths: StoragePaths): Promise<DiscoveredTool[]> {
  const servers = await listMcpServers(paths);
  const enabledServers = servers.filter((s) => s.enabled);

  // Discover tools from all servers in parallel
  const results = await Promise.allSettled(
    enabledServers.map((server) => discoverServerTools(paths, server))
  );

  // Collect all successful discoveries
  const allTools: DiscoveredTool[] = [];
  for (const result of results) {
    if (result.status === "fulfilled") {
      allTools.push(...result.value);
    }
  }

  return allTools;
}

/**
 * Get all cached tools (does not re-discover).
 */
export function getCachedTools(): DiscoveredTool[] {
  const allTools: DiscoveredTool[] = [];
  for (const tools of toolsCache.values()) {
    allTools.push(...tools);
  }
  return allTools;
}

/**
 * Get tools for a specific server.
 */
export function getCachedToolsForServer(serverId: string): DiscoveredTool[] {
  return toolsCache.get(serverId) ?? [];
}

/**
 * Find a tool by name across all servers.
 */
export function findTool(name: string): DiscoveredTool | undefined {
  for (const tools of toolsCache.values()) {
    const tool = tools.find((t) => t.name === name);
    if (tool) return tool;
  }
  return undefined;
}

/**
 * Execute a tool on its source MCP server.
 */
export async function executeTool(
  toolName: string,
  args: Record<string, unknown>
): Promise<{ content: string; isError?: boolean }> {
  const tool = findTool(toolName);
  if (!tool) {
    return { content: `Tool not found: ${toolName}`, isError: true };
  }

  const client = activeClients.get(tool.serverId);
  if (!client) {
    return { content: `Server not connected: ${tool.serverName}`, isError: true };
  }

  try {
    const result = await client.callTool(toolName, args);

    // Extract text content from result
    const textParts = result.content
      .filter((c) => c.type === "text" && c.text)
      .map((c) => c.text as string);

    return {
      content: textParts.join("\n") || "Tool executed successfully (no output)",
      isError: result.isError,
    };
  } catch (error) {
    const errorMessage = error instanceof McpError 
      ? error.message 
      : (error as Error).message;
    return { content: `Tool execution failed: ${errorMessage}`, isError: true };
  }
}

/**
 * Disconnect from a specific server.
 */
export async function disconnectServer(serverId: string): Promise<void> {
  const client = activeClients.get(serverId);
  if (client) {
    await client.close();
    activeClients.delete(serverId);
  }
  toolsCache.delete(serverId);
}

/**
 * Disconnect from all servers.
 */
export async function disconnectAllServers(): Promise<void> {
  const closePromises: Promise<void>[] = [];
  for (const [serverId, client] of activeClients) {
    closePromises.push(client.close());
    activeClients.delete(serverId);
    toolsCache.delete(serverId);
  }
  await Promise.allSettled(closePromises);
}

/**
 * Check if a server is currently connected.
 */
export function isServerConnected(serverId: string): boolean {
  return activeClients.has(serverId);
}
