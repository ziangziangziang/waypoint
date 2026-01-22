import { rotateStats } from "../storage/statsRepository";
import { StoragePaths } from "../storage/files";

/**
 * Stats Rotation Worker
 * 
 * Periodically cleans up stats files older than retention period.
 * Runs daily by default.
 */

const ROTATION_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const DEFAULT_RETENTION_DAYS = 30;

let rotationTimer: NodeJS.Timeout | null = null;

export function startStatsRotation(
  paths: StoragePaths,
  retentionDays: number = DEFAULT_RETENTION_DAYS
): void {
  if (rotationTimer) {
    return; // Already running
  }

  async function runRotation(): Promise<void> {
    try {
      const deleted = await rotateStats(paths, retentionDays);
      if (deleted > 0) {
        console.log(`[stats-rotation] Deleted ${deleted} stats file(s) older than ${retentionDays} days`);
      }
    } catch (error) {
      console.error("[stats-rotation] Error rotating stats:", error);
    }
  }

  // Run immediately on startup, then periodically
  runRotation();
  
  rotationTimer = setInterval(runRotation, ROTATION_INTERVAL_MS);
  
  // Prevent timer from keeping process alive
  rotationTimer.unref();
}

export function stopStatsRotation(): void {
  if (rotationTimer) {
    clearInterval(rotationTimer);
    rotationTimer = null;
  }
}
