import { randomUUID } from "node:crypto";
import { and, eq, isNull, lte, or, sql } from "drizzle-orm";
import type { AppDatabase } from "@emby-task-center/database/client";
import { renewalEmailOutbox } from "@emby-task-center/database/schema";
import type { EmailNotifier } from "../notifications/email-service";
import { buildRenewalReceipt, type RenewalReceipt } from "./renewal-receipt";

export type RenewalEmailStatus = "sent" | "pending" | "unchanged";
const LEASE_MS = 120_000;
export function enqueueRenewalReceipt(database: AppDatabase, key: string, receipt: RenewalReceipt) {
  const timestamp = new Date().toISOString();
  database
    .insert(renewalEmailOutbox)
    .values({
      key,
      email: receipt.email,
      ...buildRenewalReceipt(receipt),
      nextAttemptAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
    })
    .onConflictDoNothing()
    .run();
}

/** Await the actual SMTP result; cancelling a UI wait never releases a live delivery lease. */
export async function deliverRenewalReceipt(
  database: AppDatabase,
  email: EmailNotifier | undefined,
  key: string,
): Promise<"sent" | "pending"> {
  try {
    return await attemptRenewalReceipt(database, email, key);
  } catch {
    return "pending";
  }
}

async function attemptRenewalReceipt(
  database: AppDatabase,
  email: EmailNotifier | undefined,
  key: string,
): Promise<"sent" | "pending"> {
  const stored = database.select().from(renewalEmailOutbox).where(eq(renewalEmailOutbox.key, key)).get();
  if (stored?.sentAt) return "sent";
  if (!stored || !email?.configured) return "pending";
  const timestamp = new Date().toISOString();
  const token = randomUUID();
  const claimed = database
    .update(renewalEmailOutbox)
    .set({
      leaseToken: token,
      leaseUntil: new Date(Date.now() + LEASE_MS).toISOString(),
      attempts: sql`${renewalEmailOutbox.attempts} + 1`,
      updatedAt: timestamp,
    })
    .where(
      and(
        eq(renewalEmailOutbox.key, key),
        isNull(renewalEmailOutbox.sentAt),
        lte(renewalEmailOutbox.nextAttemptAt, timestamp),
        or(isNull(renewalEmailOutbox.leaseUntil), lte(renewalEmailOutbox.leaseUntil, timestamp)),
      ),
    )
    .returning()
    .get();
  if (!claimed) return "pending";
  const owns = and(eq(renewalEmailOutbox.key, key), eq(renewalEmailOutbox.leaseToken, token));
  // SMTP has finite connection/greeting/socket waits. Keep ownership while the actual
  // operation is still live (e.g. a slow stream), rather than racing and retrying it.
  const heartbeat = setInterval(() => {
    try {
      database
        .update(renewalEmailOutbox)
        .set({ leaseUntil: new Date(Date.now() + LEASE_MS).toISOString() })
        .where(owns)
        .run();
    } catch {
      /* A shutdown can close SQLite while the existing delivery drains. */
    }
  }, 30_000);
  heartbeat.unref?.();
  let delivered = false;
  try {
    await email.sendNotification(claimed.email, claimed.subject, claimed.text, claimed.html);
    delivered = true;
    const confirmed = database
      .update(renewalEmailOutbox)
      .set({
        sentAt: new Date().toISOString(),
        leaseToken: null,
        leaseUntil: null,
        lastError: null,
        updatedAt: new Date().toISOString(),
      })
      .where(owns)
      .run();
    return confirmed.changes === 1 ? "sent" : "pending";
  } catch {
    if (delivered) return "pending";
    const delay = Math.min(6 * 60 * 60_000, 5 * 60_000 * 2 ** Math.min(claimed.attempts - 1, 7));
    try {
      database
        .update(renewalEmailOutbox)
        .set({
          nextAttemptAt: new Date(Date.now() + delay).toISOString(),
          leaseToken: null,
          leaseUntil: null,
          lastError: "delivery_failed",
          updatedAt: new Date().toISOString(),
        })
        .where(owns)
        .run();
    } catch {
      /* Keep the durable lease if delivery bookkeeping is unavailable. */
    }
    return "pending";
  } finally {
    clearInterval(heartbeat);
  }
}

const rounds = new WeakMap<AppDatabase, Promise<void>>();
export function retryRenewalReceipts(database: AppDatabase, email: EmailNotifier): Promise<void> {
  const running = rounds.get(database);
  if (running) return running;
  const task = (async () => {
    if (!email.configured) return;
    const timestamp = new Date().toISOString();
    const due = database
      .select({ key: renewalEmailOutbox.key })
      .from(renewalEmailOutbox)
      .where(
        and(
          isNull(renewalEmailOutbox.sentAt),
          lte(renewalEmailOutbox.nextAttemptAt, timestamp),
          or(isNull(renewalEmailOutbox.leaseUntil), lte(renewalEmailOutbox.leaseUntil, timestamp)),
        ),
      )
      .orderBy(renewalEmailOutbox.nextAttemptAt)
      .limit(20)
      .all();
    for (const row of due) await deliverRenewalReceipt(database, email, row.key);
  })();
  rounds.set(database, task);
  void task
    .finally(() => {
      if (rounds.get(database) === task) rounds.delete(database);
    })
    .catch(() => undefined);
  return task;
}
