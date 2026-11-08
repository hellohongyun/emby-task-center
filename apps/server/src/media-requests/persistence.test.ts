import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { createDatabase, type DatabaseHandle } from "@emby-task-center/database/client";
import { migrate } from "@emby-task-center/database/migrate";
import { createMediaRequestStore } from "./store";

describe("media request SQLite upgrade and persistence", () => {
  let directory: string | undefined;
  let handle: DatabaseHandle | undefined;
  afterEach(() => {
    handle?.close();
    if (directory) rmSync(directory, { recursive: true, force: true });
  });
  it("retains the identity, member history, response and duplicate guard across reconciliation and database reopen", () => {
    directory = mkdtempSync(join(tmpdir(), "emby-request-"));
    const file = join(directory, "requests.sqlite");
    handle = createDatabase(file);
    const timestamp = new Date().toISOString();
    const value = {
      memberId: 42,
      memberEmail: "historical@example.invalid",
      mediaType: "tv" as const,
      kind: "supplement" as const,
      tmdbId: 10,
      seasonNumber: 2,
      title: "一部剧",
      originalTitle: "A Show",
      releaseYear: 2026,
      description: "E13–E15",
      posterUrl: null,
      status: "pending" as const,
      adminNote: "",
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const original = createMediaRequestStore(handle.db).create(value).row;
    migrate(handle.db);
    migrate(handle.db);
    handle.close();
    handle = createDatabase(file);
    const store = createMediaRequestStore(handle.db);
    expect(store.get(original.id)).toEqual(original);
    expect(store.create(value)).toEqual({ row: original, duplicate: true });
    const updated = store.update(original.id, timestamp, { status: "processing", adminNote: "正在寻找片源" }, "admin");
    handle.close();
    handle = createDatabase(file);
    expect(createMediaRequestStore(handle.db).get(original.id)).toEqual(updated);
  });
});
