import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createDatabase } from "./client";

describe("createDatabase", () => {
  it("uses an explicitly supplied migrations folder", () => {
    const missingFolder = join(process.cwd(), ".local", "missing-migrations-for-test");

    expect(() => createDatabase(":memory:", missingFolder)).toThrow("Can't find meta/_journal.json file");
  });
});
