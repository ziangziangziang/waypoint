import { FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import path from "path";
import { promises as fs } from "fs";

/**
 * Register UI routes to serve the React frontend.
 * 
 * - Serves static files from ui/dist at /ui/*
 * - Provides SPA fallback for client-side routing
 */
export async function registerUiRoutes(app: FastifyInstance): Promise<void> {
  // When running from dist/src/routes/ui.js, we need to go up to project root
  // __dirname = dist/src/routes -> go up 3 levels to project root, then into ui/dist
  const uiDistPath = path.join(__dirname, "..", "..", "..", "ui", "dist");
  
  // Check if UI is built
  const uiExists = await checkUiExists(uiDistPath);
  
  if (!uiExists) {
    // UI not built - serve a placeholder
    app.get("/ui", async (_req, reply) => {
      reply.type("text/html").send(`
        <!DOCTYPE html>
        <html>
          <head>
            <title>Waypoint UI</title>
            <style>
              body { 
                font-family: monospace; 
                background: #0a0a0c; 
                color: #e5e2d9;
                display: flex;
                align-items: center;
                justify-content: center;
                height: 100vh;
                margin: 0;
              }
              .container { text-align: center; }
              h1 { color: #eab308; }
              code { background: #1a1a1e; padding: 4px 8px; border-radius: 4px; }
            </style>
          </head>
          <body>
            <div class="container">
              <h1>Waypoint UI</h1>
              <p>UI not built. Run:</p>
              <p><code>cd ui && npm install && npm run build</code></p>
              <p>Then restart the server.</p>
            </div>
          </body>
        </html>
      `);
    });
    
    app.get("/ui/*", async (_req, reply) => {
      reply.redirect("/ui");
    });
    
    return;
  }

  // Register static file serving
  await app.register(fastifyStatic, {
    root: uiDistPath,
    prefix: "/ui/",
    decorateReply: false,
  });

  // SPA fallback - serve index.html for all /ui/* routes that don't match a file
  app.setNotFoundHandler(async (req, reply) => {
    if (req.url.startsWith("/ui")) {
      const indexPath = path.join(uiDistPath, "index.html");
      try {
        const html = await fs.readFile(indexPath, "utf8");
        reply.type("text/html").send(html);
      } catch {
        reply.code(404).send({ error: { message: "UI not found" } });
      }
    } else {
      reply.code(404).send({ error: { message: "Not found" } });
    }
  });
}

async function checkUiExists(distPath: string): Promise<boolean> {
  try {
    const indexPath = path.join(distPath, "index.html");
    await fs.access(indexPath);
    return true;
  } catch {
    return false;
  }
}
