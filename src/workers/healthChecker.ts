import { listEndpoints, updateHealthCheck } from "../storage/repositories";
import { Agent, request } from "undici";
import { StoragePaths } from "../storage/files";

export function startHealthChecker(paths: StoragePaths): void {
  const intervalMs = 30_000;
  const run = async () => {
    const endpoints = await listEndpoints(paths);
    await Promise.all(
      endpoints.map(async (endpoint) => {
        const start = Date.now();
        try {
          const dispatcher = endpoint.insecureTls
            ? new Agent({ connect: { rejectUnauthorized: false } })
            : undefined;
          const headers: Record<string, string> = {};
          if (endpoint.apiKey) {
            headers.authorization = `Bearer ${endpoint.apiKey}`;
          }
          const response = await request(new URL("/v1/models", endpoint.baseUrl).toString(), {
            method: "GET",
            headers,
            headersTimeout: 5000,
            bodyTimeout: 5000,
            dispatcher
          });
          const latency = Date.now() - start;
          response.body.resume();
          if (response.statusCode >= 200 && response.statusCode < 300) {
            await updateHealthCheck(paths, endpoint.id, "up", latency);
          } else {
            console.log(`[health] ${endpoint.name}: DOWN (status ${response.statusCode})`);
            await updateHealthCheck(paths, endpoint.id, "down", null);
          }
        } catch (error) {
          const errorCode = (error as NodeJS.ErrnoException).code ?? "UNKNOWN";
          console.log(`[health] ${endpoint.name}: DOWN (${errorCode})`);
          await updateHealthCheck(paths, endpoint.id, "down", null);
        }
      })
    );
  };

  setInterval(run, intervalMs).unref();
  void run();
}
