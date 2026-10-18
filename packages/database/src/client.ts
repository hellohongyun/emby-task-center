import BetterSqlite3 from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "./migrate";
import { schema } from "./schema";

export type AppDatabase = BetterSQLite3Database<typeof schema>;

export interface DatabaseHandle {
  db: AppDatabase;
  close(): void;
}

export function createDatabase(filePath: string, migrationsFolder?: string): DatabaseHandle {
  const sqlite = new BetterSqlite3(filePath, { timeout: 5_000 });
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");
  if (filePath !== ":memory:") sqlite.pragma("journal_mode = WAL");

  const db = drizzle(sqlite, { schema });
  migrate(db, migrationsFolder);
  return { db, close: () => sqlite.close() };
}
