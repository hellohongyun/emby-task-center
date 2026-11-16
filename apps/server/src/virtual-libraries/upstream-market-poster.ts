import type { AppDatabase } from "@emby-task-center/database/client";
import { DEFAULT_LIBRARY_POSTER_PNG_BASE64 } from "@emby-task-center/contracts/library-poster-png";
import { upstreamLibraryConfiguration } from "./upstream-library-catalog";

/** Caller authorizes a published external-library preview before resolving its image. */
export async function upstreamMarketPoster(database: AppDatabase, sourceId: string) {
  const config = upstreamLibraryConfiguration(database);
  const fallback = { contentType: "image/png", content: Buffer.from(DEFAULT_LIBRARY_POSTER_PNG_BASE64, "base64") };
  try {
    const response = await fetch(`${config.upstream}/Items/${encodeURIComponent(sourceId)}/Images/Primary`, {
      headers: { "X-Emby-Token": config.apiKey },
      signal: AbortSignal.timeout(10_000),
      redirect: "error",
    });
    const contentType = response.headers.get("content-type")?.split(";")[0];
    if (!response.ok || !contentType || !["image/jpeg", "image/png", "image/webp"].includes(contentType)) {
      await response.body?.cancel();
      return fallback;
    }
    const reader = response.body?.getReader();
    if (!reader) return fallback;
    const chunks: Buffer[] = [];
    let size = 0;
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.length;
      if (size > 5 * 1024 * 1024) {
        await reader.cancel();
        return fallback;
      }
      chunks.push(Buffer.from(chunk.value));
    }
    return size ? { contentType, content: Buffer.concat(chunks) } : fallback;
  } catch {
    return fallback;
  }
}
