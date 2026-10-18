import type { CacheStore } from "./types";

/** 内存缓存：测试/兜底默认。 */
export function createMemoryCacheStore(): CacheStore {
  const store = new Map<string, { value: unknown; expiresAt: number }>();
  return {
    async get<T>(key: string): Promise<T | null> {
      const hit = store.get(key);
      if (!hit) return null;
      if (hit.expiresAt <= Date.now()) {
        store.delete(key);
        return null;
      }
      return hit.value as T;
    },
    async set<T>(key: string, value: T, ttlMs: number): Promise<void> {
      store.set(key, { value, expiresAt: Date.now() + ttlMs });
    },
  };
}

/**
 * 缓存存储：优先 Redis（生产提速），未配置/连接失败自动回退内存。
 * 这样测试无需 Redis，生产配置 REDIS_URL 后自动启用。
 */
export async function createCacheStore(redisUrl?: string): Promise<CacheStore> {
  if (!redisUrl) return createMemoryCacheStore();
  try {
    const { createClient } = await import("redis");
    const client = createClient({
      url: redisUrl,
      socket: { connectTimeout: 2_000, reconnectStrategy: false },
    });
    client.on("error", () => {
      /* 连接错误静默，走内存兜底 */
    });
    await client.connect();
    const memory = createMemoryCacheStore();
    return {
      async get<T>(key: string): Promise<T | null> {
        try {
          const raw = await client.get(key);
          if (raw == null) return null;
          return JSON.parse(raw) as T;
        } catch {
          return memory.get<T>(key);
        }
      },
      async set<T>(key: string, value: T, ttlMs: number): Promise<void> {
        try {
          await client.set(key, JSON.stringify(value), { EX: Math.max(1, Math.floor(ttlMs / 1000)) });
        } catch {
          await memory.set(key, value, ttlMs);
        }
      },
    };
  } catch {
    return createMemoryCacheStore();
  }
}
