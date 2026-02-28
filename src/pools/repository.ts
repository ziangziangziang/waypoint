import { StoragePaths, readJsonFile, writeJsonFile } from "../storage/files";
import { PoolDefinition, PoolStateFile, PoolStoreFile } from "./types";

const POOLS_VERSION = 1;
const STATE_VERSION = 1;

function defaultPoolStore(): PoolStoreFile {
  return {
    version: POOLS_VERSION,
    updatedAt: new Date().toISOString(),
    pools: [],
  };
}

function defaultPoolState(): PoolStateFile {
  return {
    version: STATE_VERSION,
    updatedAt: new Date().toISOString(),
    candidates: {},
  };
}

export async function loadPools(paths: StoragePaths): Promise<PoolStoreFile> {
  const store = await readJsonFile<PoolStoreFile>(paths.poolsPath, defaultPoolStore());
  if (!Array.isArray(store.pools)) {
    return defaultPoolStore();
  }
  return {
    version: Number.isFinite(store.version) ? store.version : POOLS_VERSION,
    updatedAt: typeof store.updatedAt === "string" ? store.updatedAt : new Date().toISOString(),
    pools: store.pools,
  };
}

export async function savePools(paths: StoragePaths, pools: PoolDefinition[]): Promise<void> {
  await writeJsonFile(paths.poolsPath, {
    version: POOLS_VERSION,
    updatedAt: new Date().toISOString(),
    pools,
  } satisfies PoolStoreFile);
}

export async function listPools(paths: StoragePaths): Promise<PoolDefinition[]> {
  const store = await loadPools(paths);
  return [...store.pools].sort((a, b) => a.id.localeCompare(b.id));
}

export async function getPoolByAlias(paths: StoragePaths, alias: string): Promise<PoolDefinition | null> {
  const pools = await listPools(paths);
  return pools.find((pool) => pool.aliases.includes(alias)) ?? null;
}

export async function loadPoolState(paths: StoragePaths): Promise<PoolStateFile> {
  const state = await readJsonFile<PoolStateFile>(paths.poolStatePath, defaultPoolState());
  if (!state.candidates || typeof state.candidates !== "object") {
    return defaultPoolState();
  }
  return {
    version: Number.isFinite(state.version) ? state.version : STATE_VERSION,
    updatedAt: typeof state.updatedAt === "string" ? state.updatedAt : new Date().toISOString(),
    candidates: state.candidates,
  };
}

export async function savePoolState(paths: StoragePaths, state: PoolStateFile): Promise<void> {
  await writeJsonFile(paths.poolStatePath, {
    ...state,
    version: STATE_VERSION,
    updatedAt: new Date().toISOString(),
  } satisfies PoolStateFile);
}
