import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import BetterSqlite3 from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { createDatabase } from "./client";
import { migrate } from "./migrate";
import {
  libraryEpisodes,
  libraryItems,
  libraryScanRuns,
  logs,
  mediaItems,
  mediaRoots,
  mediaTasks,
  taskRuns,
  schema,
} from "./schema";

const duplicateRemediationMessage =
  "Duplicate library episode identities block migration. Rebuild derived library inventory " +
  "(library_items and library_episodes) and run a rescan; do not delete media_items or media_tasks.";
const migrationsFolder = resolve(dirname(fileURLToPath(import.meta.url)), "../drizzle");

function createInitialMigrationsFolder(directory: string): string {
  const initialMigrationsFolder = join(directory, "initial-migrations");
  mkdirSync(join(initialMigrationsFolder, "meta"), { recursive: true });
  copyFileSync(
    join(migrationsFolder, "0000_sturdy_mesmero.sql"),
    join(initialMigrationsFolder, "0000_sturdy_mesmero.sql"),
  );
  writeFileSync(
    join(initialMigrationsFolder, "meta", "_journal.json"),
    JSON.stringify({
      version: "7",
      dialect: "sqlite",
      entries: [
        {
          idx: 0,
          version: "6",
          when: 1786355806640,
          tag: "0000_sturdy_mesmero",
          breakpoints: true,
        },
      ],
    }),
  );
  return initialMigrationsFolder;
}

describe("database migrations", () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("creates every typed Drizzle table in a temporary SQLite database", () => {
    const directory = mkdtempSync(join(tmpdir(), "emby-task-center-migration-"));
    directories.push(directory);
    const database = createDatabase(join(directory, "migration.sqlite"));

    try {
      expect(database.db.select().from(mediaItems).all()).toEqual([]);
      expect(database.db.select().from(mediaTasks).all()).toEqual([]);
      expect(database.db.select().from(taskRuns).all()).toEqual([]);
      expect(database.db.select().from(mediaRoots).all()).toEqual([]);
      expect(database.db.select().from(libraryItems).all()).toEqual([]);
      expect(database.db.select().from(libraryEpisodes).all()).toEqual([]);
      expect(database.db.select().from(libraryScanRuns).all()).toEqual([]);
      expect(database.db.select().from(logs).all()).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("rejects duplicate episode scan records for the same parsed identity", () => {
    const directory = mkdtempSync(join(tmpdir(), "emby-task-center-episode-"));
    directories.push(directory);
    const database = createDatabase(join(directory, "episodes.sqlite"));

    try {
      const root = database.db
        .insert(mediaRoots)
        .values({
          name: "TV",
          mediaType: "tv",
          containerPath: "/media/tv",
          createdAt: "2026-08-10T00:00:00.000Z",
          updatedAt: "2026-08-10T00:00:00.000Z",
        })
        .returning({ id: mediaRoots.id })
        .get();
      const item = database.db
        .insert(libraryItems)
        .values({
          mediaRootId: root.id,
          relativePath: "The Expanse/Season 01",
          createdAt: "2026-08-10T00:00:00.000Z",
          updatedAt: "2026-08-10T00:00:00.000Z",
        })
        .returning({ id: libraryItems.id })
        .get();
      const episode = {
        libraryItemId: item.id,
        parsedSeason: 1,
        episodeNumber: 1,
        absoluteEpisodeNumber: 1,
        createdAt: "2026-08-10T00:00:00.000Z",
      };

      database.db.insert(libraryEpisodes).values(episode).run();

      expect(() => database.db.insert(libraryEpisodes).values(episode).run()).toThrow(/UNIQUE constraint failed/);
    } finally {
      database.close();
    }
  });

  it("migrates unresolved duplicates for every nullable episode identity field", () => {
    const directory = mkdtempSync(join(tmpdir(), "emby-task-center-unresolved-"));
    directories.push(directory);
    const sqlite = new BetterSqlite3(join(directory, "unresolved.sqlite"));
    const database = drizzle(sqlite, { schema });

    try {
      migrate(database, createInitialMigrationsFolder(directory));
      sqlite.exec(`
        INSERT INTO media_roots
          (id, name, media_type, container_path, created_at, updated_at)
        VALUES
          (3, 'TV', 'tv', '/media/tv', '2026-08-10T00:00:00.000Z', '2026-08-10T00:00:00.000Z');
        INSERT INTO library_items
          (id, media_root_id, relative_path, created_at, updated_at)
        VALUES
          (11, 3, 'Unresolved Show', '2026-08-10T00:00:00.000Z', '2026-08-10T00:00:00.000Z');
        INSERT INTO library_episodes
          (
            library_item_id,
            parsed_season,
            episode_number,
            absolute_episode_number,
            numbering_mode,
            created_at
          )
        VALUES
          (11, NULL, NULL, NULL, 'unresolved', '2026-08-10T00:00:00.000Z'),
          (11, NULL, NULL, NULL, 'unresolved', '2026-08-10T00:00:00.000Z'),
          (11, NULL, 1, 1, 'unresolved', '2026-08-10T00:00:00.000Z'),
          (11, NULL, 1, 1, 'unresolved', '2026-08-10T00:00:00.000Z'),
          (11, 1, NULL, 2, 'unresolved', '2026-08-10T00:00:00.000Z'),
          (11, 1, NULL, 2, 'unresolved', '2026-08-10T00:00:00.000Z'),
          (11, 2, 2, NULL, 'unresolved', '2026-08-10T00:00:00.000Z'),
          (11, 2, 2, NULL, 'unresolved', '2026-08-10T00:00:00.000Z');
      `);

      expect(() => migrate(database)).not.toThrow();
      expect(sqlite.prepare("SELECT COUNT(*) AS count FROM library_episodes").get()).toEqual({
        count: 8,
      });
      expect(
        sqlite
          .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'library_episodes_identity_idx'")
          .get(),
      ).toEqual({ name: "library_episodes_identity_idx" });
    } finally {
      sqlite.close();
    }
  });

  it("fails legacy duplicate migration with inventory-only remediation guidance", () => {
    const directory = mkdtempSync(join(tmpdir(), "emby-task-center-legacy-"));
    directories.push(directory);
    const sqlite = new BetterSqlite3(join(directory, "legacy.sqlite"));
    sqlite.exec(`
      CREATE TABLE media_items (id INTEGER PRIMARY KEY, title TEXT NOT NULL);
      INSERT INTO media_items (id, title) VALUES (7, 'Preserved Media');
      CREATE TABLE media_tasks (
        id INTEGER PRIMARY KEY,
        media_item_id INTEGER NOT NULL,
        status TEXT NOT NULL
      );
      INSERT INTO media_tasks (id, media_item_id, status) VALUES (9, 7, 'pending');
      CREATE TABLE library_episodes (
        id INTEGER PRIMARY KEY,
        library_item_id INTEGER NOT NULL,
        parsed_season INTEGER,
        episode_number INTEGER,
        absolute_episode_number INTEGER
      );
      INSERT INTO library_episodes
        (library_item_id, parsed_season, episode_number, absolute_episode_number)
      VALUES (11, 1, 1, 1), (11, 1, 1, 1);
    `);
    const database = drizzle(sqlite, { schema });

    try {
      expect(() => migrate(database)).toThrow(duplicateRemediationMessage);
      expect(sqlite.prepare("SELECT title FROM media_items WHERE id = 7").get()).toEqual({
        title: "Preserved Media",
      });
      expect(sqlite.prepare("SELECT status FROM media_tasks WHERE id = 9").get()).toEqual({
        status: "pending",
      });
      expect(sqlite.prepare("SELECT COUNT(*) AS count FROM library_episodes").get()).toEqual({
        count: 2,
      });
    } finally {
      sqlite.close();
    }
  });
});
