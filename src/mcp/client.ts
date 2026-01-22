import { McpServer, McpTool } from "../types";

/**
 * MCP Client
 * 
 * HTTP client for MCP servers using Streamable HTTP transport.
 * Handles connection lifecycle, tool discovery, and tool execution.
 */

export interface McpClientOptions {
  url: string;
  timeout?: number;
}

export interface McpJsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: unknown;
}

export interface McpJsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export interface McpToolSchema {
  name: string;
  description?: string;
  inputSchema: {
    type: "object";
    properties?: Record<string, unknown>;
    required?: string[];
  };
}

export interface McpToolsListResult {
  tools: McpToolSchema[];
}

export interface McpToolCallResult {
  content: Array<{
    type: "text" | "image" | "resource";
    text?: string;
    data?: string;
    mimeType?: string;
  }>;
  isError?: boolean;
}

export class McpError extends Error {
  constructor(
    public code: number,
    message: string,
    public data?: unknown
  ) {
    super(message);
    this.name = "McpError";
  }
}

export class McpClient {
  private url: string;
  private timeout: number;
  private requestId = 0;
  private sessionId: string | null = null;

  constructor(options: McpClientOptions) {
    this.url = options.url;
    this.timeout = options.timeout ?? 30000;
  }

  /**
   * Initialize the MCP connection.
   */
  async initialize(): Promise<void> {
    const response = await this.sendRequest("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {
        tools: {},
      },
      clientInfo: {
        name: "waypoint",
        version: "0.2.0",
      },
    });

    // Store session ID if provided
    const initResponse = response as { _meta?: { sessionId?: string } };
    if (initResponse._meta?.sessionId) {
      this.sessionId = initResponse._meta.sessionId;
    }

    // Send initialized notification
    await this.sendNotification("notifications/initialized");
  }

  /**
   * List available tools from the MCP server.
   */
  async listTools(): Promise<McpToolSchema[]> {
    const result = await this.sendRequest("tools/list", {});
    const toolsResult = result as McpToolsListResult;
    return toolsResult.tools ?? [];
  }

  /**
   * Call a tool on the MCP server.
   */
  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolCallResult> {
    const result = await this.sendRequest("tools/call", {
      name,
      arguments: args,
    });
    return result as McpToolCallResult;
  }

  /**
   * Close the MCP connection.
   */
  async close(): Promise<void> {
    try {
      await this.sendNotification("notifications/cancelled", {
        requestId: "session",
        reason: "Client closing",
      });
    } catch {
      // Ignore errors during close
    }
    this.sessionId = null;
  }

  /**
   * Send a JSON-RPC request and wait for response.
   */
  private async sendRequest(method: string, params?: unknown): Promise<unknown> {
    const id = ++this.requestId;
    const request: McpJsonRpcRequest = {
      jsonrpc: "2.0",
      id,
      method,
      params,
    };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      // MCP Streamable HTTP spec requires accepting both JSON and SSE
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
      };

      if (this.sessionId) {
        headers["Mcp-Session-Id"] = this.sessionId;
      }

      const response = await fetch(this.url, {
        method: "POST",
        headers,
        body: JSON.stringify(request),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new McpError(
          -32000,
          `HTTP error: ${response.status} ${response.statusText}`
        );
      }

      // Check for session ID in response headers
      const newSessionId = response.headers.get("Mcp-Session-Id");
      if (newSessionId) {
        this.sessionId = newSessionId;
      }

      // Handle both JSON and SSE responses per MCP Streamable HTTP spec
      const contentType = response.headers.get("Content-Type") ?? "";
      
      if (contentType.includes("text/event-stream")) {
        // Parse SSE response - collect events and find our response
        return await this.parseSSEResponse(response, id);
      }

      const jsonResponse = await response.json() as McpJsonRpcResponse;

      if (jsonResponse.error) {
        throw new McpError(
          jsonResponse.error.code,
          jsonResponse.error.message,
          jsonResponse.error.data
        );
      }

      return jsonResponse.result;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Parse Server-Sent Events response to extract JSON-RPC response.
   * MCP Streamable HTTP can return SSE for streaming responses.
   */
  private async parseSSEResponse(response: Response, expectedId: number | string): Promise<unknown> {
    const text = await response.text();
    const lines = text.split("\n");
    
    let currentData = "";
    
    for (const line of lines) {
      if (line.startsWith("data:")) {
        currentData += line.slice(5).trim();
      } else if (line === "" && currentData) {
        // End of event, try to parse
        try {
          const jsonResponse = JSON.parse(currentData) as McpJsonRpcResponse;
          
          // Check if this is the response to our request
          if (jsonResponse.id === expectedId) {
            if (jsonResponse.error) {
              throw new McpError(
                jsonResponse.error.code,
                jsonResponse.error.message,
                jsonResponse.error.data
              );
            }
            return jsonResponse.result;
          }
        } catch (e) {
          if (e instanceof McpError) throw e;
          // Ignore parsing errors, continue to next event
        }
        currentData = "";
      }
    }
    
    // Try parsing any remaining data
    if (currentData) {
      try {
        const jsonResponse = JSON.parse(currentData) as McpJsonRpcResponse;
        if (jsonResponse.id === expectedId) {
          if (jsonResponse.error) {
            throw new McpError(
              jsonResponse.error.code,
              jsonResponse.error.message,
              jsonResponse.error.data
            );
          }
          return jsonResponse.result;
        }
      } catch (e) {
        if (e instanceof McpError) throw e;
      }
    }
    
    throw new McpError(-32000, "No response found in SSE stream");
  }

  /**
   * Send a JSON-RPC notification (no response expected).
   */
  private async sendNotification(method: string, params?: unknown): Promise<void> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (this.sessionId) {
      headers["Mcp-Session-Id"] = this.sessionId;
    }

    const notification = {
      jsonrpc: "2.0",
      method,
      params,
    };

    await fetch(this.url, {
      method: "POST",
      headers,
      body: JSON.stringify(notification),
    });
  }

  get serverUrl(): string {
    return this.url;
  }
}

/**
 * Create and initialize an MCP client.
 */
export async function createMcpClient(url: string): Promise<McpClient> {
  const client = new McpClient({ url });
  await client.initialize();
  return client;
}
