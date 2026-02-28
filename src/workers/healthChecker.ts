import { StoragePaths } from "../storage/files";
import { probeProviderModels } from "../providers/health";

export function startHealthChecker(paths: StoragePaths): void {
  const intervalMs = 30_000;
  const run = async () => {
    await probeProviderModels(paths);
  };

  setInterval(run, intervalMs).unref();
  void run();
}
