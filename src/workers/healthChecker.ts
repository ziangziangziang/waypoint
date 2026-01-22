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
          const response = await request(new URL("/v1/models", endpoint.baseUrl).toString(), {
            method: "GET",
            headersTimeout: 2000,
            bodyTimeout: 2000,
            dispatcher
          });
          const latency = Date.now() - start;
          response.body.resume();
          if (response.statusCode >= 200 && response.statusCode < 500) {
            await updateHealthCheck(paths, endpoint.id, "up", latency);
          } else {
            await updateHealthCheck(paths, endpoint.id, "down", null);
          }
        } catch {
          await updateHealthCheck(paths, endpoint.id, "down", null);
        }
      })
    );
  };

  setInterval(run, intervalMs).unref();
  void run();
}
