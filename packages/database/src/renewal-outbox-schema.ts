import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const renewalEmailOutbox = sqliteTable(
  "renewal_email_outbox",
  {
    key: text("key").primaryKey(),
    email: text("email").notNull(),
    subject: text("subject").notNull(),
    text: text("text").notNull(),
    html: text("html").notNull(),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: text("next_attempt_at").notNull(),
    leaseToken: text("lease_token"),
    leaseUntil: text("lease_until"),
    sentAt: text("sent_at"),
    lastError: text("last_error"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [index("renewal_email_outbox_due_idx").on(table.sentAt, table.nextAttemptAt)],
);
