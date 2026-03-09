import { StoragePaths } from "../storage/files";
import { runCaptureRetention } from "../storage/captureRepository";

export function startCaptureRetentionWorker(paths: StoragePaths): void {
  const run = async () => {
    try {
      await runCaptureRetention(paths);
    } catch {
      // ignore background errors
    }
  };

  setInterval(run, 10 * 60 * 1000).unref();
  void run();
}
