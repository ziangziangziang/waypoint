import { watch, FSWatcher } from "fs";
import { EventEmitter } from "events";
import { StoragePaths } from "../storage/files";

/**
 * Config Watcher
 * 
 * Watches config.yaml for changes and emits events when the file is modified.
 * Uses debouncing to handle rapid successive changes (common with text editors).
 */

export interface ConfigWatcher extends EventEmitter {
  on(event: "config:updated", listener: () => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  emit(event: "config:updated"): boolean;
  emit(event: "error", error: Error): boolean;
  stop(): void;
}

const DEBOUNCE_MS = 500;

class ConfigWatcherImpl extends EventEmitter implements ConfigWatcher {
  private watcher: FSWatcher | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  private isWatching = false;
  private configPath: string;

  constructor(configPath: string) {
    super();
    this.configPath = configPath;
  }

  start(): void {
    if (this.isWatching) return;

    try {
      this.watcher = watch(this.configPath, (eventType) => {
        // Handle both 'change' and 'rename' events
        // Some editors do atomic saves (write temp → rename)
        if (eventType === "change" || eventType === "rename") {
          this.debouncedEmit();
        }
      });

      this.watcher.on("error", (error) => {
        this.emit("error", error);
      });

      this.isWatching = true;
      console.log("[config-watcher] Watching for config changes");
    } catch (error) {
      // File might not exist yet, that's okay
      console.log("[config-watcher] Config file not found, will retry on next access");
    }
  }

  private debouncedEmit(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(() => {
      console.log("[config-watcher] Config file changed, triggering reload");
      this.emit("config:updated");
      this.debounceTimer = null;
    }, DEBOUNCE_MS);
  }

  stop(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    this.isWatching = false;
    console.log("[config-watcher] Stopped watching");
  }
}

let globalWatcher: ConfigWatcher | null = null;

/**
 * Start watching the config file for changes.
 * Returns an EventEmitter that emits "config:updated" when the file changes.
 */
export function startConfigWatcher(paths: StoragePaths): ConfigWatcher {
  if (globalWatcher) {
    return globalWatcher;
  }

  const watcher = new ConfigWatcherImpl(paths.configPath);
  watcher.start();
  globalWatcher = watcher;
  return watcher;
}

/**
 * Stop the config watcher.
 */
export function stopConfigWatcher(): void {
  if (globalWatcher) {
    globalWatcher.stop();
    globalWatcher = null;
  }
}

/**
 * Get the current config watcher instance (if running).
 */
export function getConfigWatcher(): ConfigWatcher | null {
  return globalWatcher;
}
