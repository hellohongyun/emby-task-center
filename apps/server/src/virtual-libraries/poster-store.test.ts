import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createDatabase } from "@emby-task-center/database/client";
import { migrate } from "@emby-task-center/database/migrate";
import { createVirtualLibraryStore } from "./store";
import { InvalidPosterError, parsePosterImage } from "./poster-image";
import { jpegPoster, webpPoster, pngPoster } from "./poster-fixtures";

export const posterPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jGZkAAAAASUVORK5CYII=",
  "base64",
);

describe("virtual library custom poster persistence", () => {
  it("preserves the original library/mappings across upgrades, replacement, removal and reopening", () => {
    const file = join(mkdtempSync(join(tmpdir(), "virtual-poster-")), "test.db");
    let handle = createDatabase(file);
    let store = createVirtualLibraryStore(handle.db);
    const library = store.create({ name: "独立封面" });
    const mapped = { itemId: "real-id", name: "原片", type: "Movie", year: null, imageTag: "original" };
    store.addItems(library.id, [mapped]);
    store.setPoster(library.id, posterPng, "image/png");
    const tag = store.get(library.id)!.posterImageTag;
    expect(tag).toMatch(/^[a-f0-9]{64}$/);
    expect(store.get(library.id)).toMatchObject({ posterAspectRatio: 1, itemCount: 1 });
    migrate(handle.db);
    migrate(handle.db);
    handle.close();
    handle = createDatabase(file);
    try {
      store = createVirtualLibraryStore(handle.db);
      expect(store.getPoster(library.id)?.content).toEqual(posterPng);
      expect(store.get(library.id)?.posterImageTag).toBe(tag);
      store.setPoster(library.id, pngPoster(2, 3));
      expect(store.get(library.id)?.posterImageTag).not.toBe(tag);
      expect(store.get(library.id)?.posterAspectRatio).toBeCloseTo(2 / 3);
      store.setPoster(library.id, posterPng, "image/png");
      const changedTag = store.get(library.id)?.posterImageTag;
      expect(changedTag).toBe(tag);
      expect(() => store.setPoster(library.id, Buffer.from("bad"), "image/png")).toThrow(InvalidPosterError);
      expect(store.get(library.id)?.posterImageTag).toBe(tag);
      store.removePoster(library.id);
      expect(store.getPoster(library.id)).toBeUndefined();
      expect(store.get(library.id)?.posterImageTag).toBeNull();
      expect(store.listItems(library.id)).toEqual([mapped]);
      store.setPoster(library.id, posterPng);
      store.remove(library.id);
      expect(handle.db.all(sql`SELECT * FROM virtual_library_posters`)).toEqual([]);
    } finally {
      handle.close();
    }
  });

  it("rejects empty, disguised, truncated and oversized uploads without trusting MIME", () => {
    expect(parsePosterImage(posterPng)).toMatchObject({ width: 1, height: 1, contentType: "image/png" });
    for (const input of [
      Buffer.alloc(0),
      Buffer.from("<svg></svg>"),
      posterPng.subarray(0, 24),
      Buffer.alloc(5 * 1024 * 1024 + 1),
      Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(12, 0xff), Buffer.from([0xff, 0xd9])]),
    ]) {
      expect(() => parsePosterImage(input)).toThrow(InvalidPosterError);
    }
    expect(() => parsePosterImage(posterPng, "image/jpeg")).toThrow(InvalidPosterError);
  });

  it("recognizes original JPEG and WebP headers and dimensions", () => {
    expect(parsePosterImage(jpegPoster, "image/jpeg")).toMatchObject({
      width: 2,
      height: 3,
      contentType: "image/jpeg",
    });
    expect(parsePosterImage(webpPoster, "image/webp")).toMatchObject({
      width: 2,
      height: 3,
      contentType: "image/webp",
    });
    expect(() => parsePosterImage(jpegPoster.subarray(0, -3))).toThrow(InvalidPosterError);
    expect(() => parsePosterImage(webpPoster.subarray(0, -3))).toThrow(InvalidPosterError);
  });
});
