import { FastifyInstance, FastifyRequest, FastifyReply, HookHandlerDoneFunction } from "fastify";
import { loadConfig, StoragePaths } from "../storage/files";

/**
 * Auth Middleware (No-op Implementation)
 * 
 * This middleware is a placeholder for future authentication.
 * When authEnabled is false (default), it passes through all requests.
 * 
 * Extension points for implementing auth:
 * 1. JWT validation
 * 2. API key verification  
 * 3. OAuth2/OIDC integration
 * 4. Basic auth for simple deployments
 * 
 * The middleware adds req.user typing for downstream handlers.
 */

declare module "fastify" {
  interface FastifyRequest {
    user?: {
      id: string;
      email?: string;
      roles?: string[];
    };
  }
}

export interface AuthConfig {
  enabled: boolean;
  // Future config options:
  // jwtSecret?: string;
  // apiKeys?: string[];
  // oauthProvider?: string;
}

let authConfig: AuthConfig = {
  enabled: false,
};

/**
 * Load auth configuration from the main config file.
 */
export async function loadAuthConfig(paths: StoragePaths): Promise<AuthConfig> {
  try {
    const config = await loadConfig(paths);
    return {
      enabled: config.authEnabled ?? false,
    };
  } catch {
    return { enabled: false };
  }
}

/**
 * Update auth config (e.g., after config hot-reload).
 */
export function updateAuthConfig(config: AuthConfig): void {
  authConfig = config;
}

/**
 * Get current auth config.
 */
export function getAuthConfig(): AuthConfig {
  return authConfig;
}

/**
 * Auth guard for protected routes.
 * 
 * When auth is disabled: passes through all requests.
 * When auth is enabled: checks for valid authentication.
 */
export function authGuard(
  req: FastifyRequest,
  reply: FastifyReply,
  done: HookHandlerDoneFunction
): void {
  // Auth disabled - pass through
  if (!authConfig.enabled) {
    done();
    return;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Auth enabled - implement your auth logic here
  // ─────────────────────────────────────────────────────────────────────────
  
  // Example: Check for Authorization header
  const authHeader = req.headers.authorization;
  
  if (!authHeader) {
    reply.status(401).send({
      error: {
        message: "Authentication required",
        type: "auth_error",
        code: "missing_auth",
      },
    });
    return;
  }

  // Placeholder validation - replace with real auth logic
  // For now, any Bearer token is accepted
  if (authHeader.startsWith("Bearer ")) {
    const token = authHeader.slice(7);
    
    // TODO: Validate token (JWT decode, database lookup, etc.)
    // For now, we just set a placeholder user
    req.user = {
      id: "placeholder",
      email: undefined,
      roles: ["user"],
    };
    
    done();
    return;
  }

  reply.status(401).send({
    error: {
      message: "Invalid authentication",
      type: "auth_error", 
      code: "invalid_auth",
    },
  });
}

/**
 * Optional: API key auth guard for simpler use cases.
 */
export function apiKeyGuard(validKeys: Set<string>) {
  return (
    req: FastifyRequest,
    reply: FastifyReply,
    done: HookHandlerDoneFunction
  ): void => {
    if (!authConfig.enabled) {
      done();
      return;
    }

    const authHeader = req.headers.authorization;
    const apiKey = req.headers["x-api-key"] as string | undefined;
    
    // Check X-API-Key header
    if (apiKey && validKeys.has(apiKey)) {
      req.user = { id: "api-key-user", roles: ["api"] };
      done();
      return;
    }
    
    // Check Bearer token as API key
    if (authHeader?.startsWith("Bearer ")) {
      const key = authHeader.slice(7);
      if (validKeys.has(key)) {
        req.user = { id: "api-key-user", roles: ["api"] };
        done();
        return;
      }
    }

    reply.status(401).send({
      error: {
        message: "Invalid API key",
        type: "auth_error",
        code: "invalid_api_key",
      },
    });
  };
}

/**
 * Register auth hooks on protected route prefixes.
 * 
 * Usage:
 *   await registerAuthHooks(app, paths, ["/admin", "/ui"]);
 */
export async function registerAuthHooks(
  app: FastifyInstance,
  paths: StoragePaths,
  protectedPrefixes: string[] = ["/admin", "/ui"]
): Promise<void> {
  // Load initial config
  authConfig = await loadAuthConfig(paths);
  
  app.log.info(
    { authEnabled: authConfig.enabled, protectedPrefixes },
    "Auth middleware initialized"
  );

  // Add hook for protected routes
  app.addHook("onRequest", (req, reply, done) => {
    const isProtected = protectedPrefixes.some((prefix) =>
      req.url.startsWith(prefix)
    );

    if (isProtected) {
      authGuard(req, reply, done);
    } else {
      done();
    }
  });
}

/**
 * Middleware factory for route-level auth.
 * 
 * Usage in route handlers:
 *   app.get("/admin/something", { preHandler: [requireAuth()] }, handler);
 */
export function requireAuth() {
  return (
    req: FastifyRequest,
    reply: FastifyReply,
    done: HookHandlerDoneFunction
  ): void => {
    authGuard(req, reply, done);
  };
}

/**
 * Check if a user has a specific role.
 */
export function requireRole(role: string) {
  return (
    req: FastifyRequest,
    reply: FastifyReply,
    done: HookHandlerDoneFunction
  ): void => {
    // First check auth
    if (authConfig.enabled) {
      if (!req.user) {
        reply.status(401).send({
          error: { message: "Authentication required", type: "auth_error" },
        });
        return;
      }
      
      if (!req.user.roles?.includes(role)) {
        reply.status(403).send({
          error: { message: "Insufficient permissions", type: "auth_error" },
        });
        return;
      }
    }
    
    done();
  };
}
