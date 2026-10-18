import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDatabase, type DatabaseHandle } from "@emby-task-center/database/client";
import {
  DEFAULT_ADMIN_PASSWORD,
  DEFAULT_ADMIN_USERNAME,
  changeAdminPassword,
  ensureDefaultAdminAccount,
  hashPassword,
  readAdminAccount,
  verifyAdminCredentials,
  verifyPassword,
} from "./admin-account";

describe("admin account", () => {
  let directory: string;
  let database: DatabaseHandle;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "emby-admin-"));
    database = createDatabase(join(directory, "app.sqlite"));
  });

  afterEach(() => {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("seeds the documented default credentials and asks for a change", () => {
    const result = ensureDefaultAdminAccount(database.db);
    expect(result).toEqual({ created: true, username: DEFAULT_ADMIN_USERNAME });

    const state = readAdminAccount(database.db);
    expect(state.username).toBe(DEFAULT_ADMIN_USERNAME);
    expect(state.hasPassword).toBe(true);
    expect(state.mustChangePassword).toBe(true);

    expect(verifyAdminCredentials(database.db, "admin", DEFAULT_ADMIN_PASSWORD).status).toBe("ok");
  });

  it("accepts a missing username for backwards compatibility", () => {
    ensureDefaultAdminAccount(database.db);
    expect(verifyAdminCredentials(database.db, undefined, DEFAULT_ADMIN_PASSWORD).status).toBe("ok");
    expect(verifyAdminCredentials(database.db, "", DEFAULT_ADMIN_PASSWORD).status).toBe("ok");
    expect(verifyAdminCredentials(database.db, "root", DEFAULT_ADMIN_PASSWORD).status).toBe("invalid");
    expect(verifyAdminCredentials(database.db, "admin", "wrong-password").status).toBe("invalid");
  });

  it("does not overwrite an existing password on later startups", () => {
    ensureDefaultAdminAccount(database.db);
    expect(changeAdminPassword(database.db, DEFAULT_ADMIN_PASSWORD, "a-better-password").status).toBe("ok");

    const second = ensureDefaultAdminAccount(database.db);
    expect(second.created).toBe(false);
    expect(verifyAdminCredentials(database.db, "admin", "a-better-password").status).toBe("ok");
    expect(verifyAdminCredentials(database.db, "admin", DEFAULT_ADMIN_PASSWORD).status).toBe("invalid");
    expect(readAdminAccount(database.db).mustChangePassword).toBe(false);
  });

  it("guards password changes behind the current password and a minimum length", () => {
    ensureDefaultAdminAccount(database.db);
    expect(changeAdminPassword(database.db, "not-the-password", "a-better-password").status).toBe("invalid_current");
    expect(changeAdminPassword(database.db, DEFAULT_ADMIN_PASSWORD, "short").status).toBe("too_short");
    expect(verifyAdminCredentials(database.db, "admin", DEFAULT_ADMIN_PASSWORD).status).toBe("ok");
  });

  it("hashes with a per-call salt and rejects malformed hashes", () => {
    const first = hashPassword("same-password");
    const second = hashPassword("same-password");
    expect(first).not.toBe(second);
    expect(verifyPassword("same-password", first)).toBe(true);
    expect(verifyPassword("same-password", second)).toBe(true);
    expect(verifyPassword("other-password", first)).toBe(false);
    expect(verifyPassword("same-password", "plaintext")).toBe(false);
    expect(verifyPassword("same-password", "scrypt$only-two")).toBe(false);
  });

  it("reports invalid credentials when no password hash exists yet", () => {
    expect(readAdminAccount(database.db).hasPassword).toBe(false);
    expect(verifyAdminCredentials(database.db, "admin", DEFAULT_ADMIN_PASSWORD).status).toBe("invalid");
  });
});
