import { sql } from "drizzle-orm";
import type { AppDatabase } from "./client";

export function reconcileLogMetadata(database: AppDatabase): void {
  database.transaction(
    (tx) => {
      const columns = new Set(tx.all<{ name: string }>(sql`PRAGMA table_info(logs)`).map((row) => row.name));
      if (!columns.size) return;
      if (!columns.has("module")) tx.run(sql`ALTER TABLE logs ADD COLUMN module TEXT`);
      if (!columns.has("run_id")) tx.run(sql`ALTER TABLE logs ADD COLUMN run_id TEXT`);
      if (!columns.has("event")) tx.run(sql`ALTER TABLE logs ADD COLUMN event TEXT`);
      tx.run(sql`CREATE INDEX IF NOT EXISTS logs_module_id_idx ON logs(module, id)`);
      tx.run(sql`CREATE INDEX IF NOT EXISTS logs_run_id_idx ON logs(run_id, id)`);
    },
    { behavior: "immediate" },
  );
}
