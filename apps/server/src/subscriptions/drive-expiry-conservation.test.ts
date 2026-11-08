import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { expect, it, vi } from "vitest";
import { createDatabase } from "@emby-task-center/database/client";
import { auditLogs, cardKeys, renewalEmailOutbox, submissionUsers } from "@emby-task-center/database/schema";
import { renewMember, renewalSchema } from "./admin-renewal";
import { activateMembershipWithCard } from "./card-activation";
import { createCardKeys, formatExpiryDate, normalizeExpiryDate } from "./cards";
import { getDriveExpiry, setDriveExpiry } from "./drive-expiry";
import { addSubmissionUser, memberStatus } from "./membership";

const DAY = 86_400_000;
const start = Date.parse("2028-02-28T19:13:11.123Z");
type Member = typeof submissionUsers.$inferSelect;

function availableTime(member: Member, clock: number): number {
  return Math.max(0, Date.parse(member.subscriptionExpiresAt ?? "") - clock);
}

function dateAt(clock: number): string {
  return formatExpiryDate(new Date(clock).toISOString());
}

function fixedAt(clock: number): number {
  return Date.parse(normalizeExpiryDate(dateAt(clock))!);
}

it("conserves millisecond entitlements across mixed grants, cap changes, elapsed time and file database reopen", () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const directory = mkdtempSync(join(tmpdir(), "drive-entitlement-ledger-"));
  const path = join(directory, "ledger.db");
  let handle = createDatabase(path);
  try {
    let clock = start;
    vi.setSystemTime(clock);
    const remaining = new Map<number, number>();
    const finite: number[] = [];
    for (let index = 0; index < 40; index++) {
      const expiry = clock + (index - 5) * DAY + index * 37;
      const user = addSubmissionUser(handle.db, {
        email: `finite-${index}@example.invalid`,
        subscriptionExpiresAt: new Date(expiry).toISOString(),
      });
      finite.push(user.id);
      remaining.set(user.id, Math.max(0, expiry - clock));
    }
    const permanent = addSubmissionUser(handle.db, { email: "permanent@example.invalid" });
    const read = (id: number) => handle.db.select().from(submissionUsers).where(eq(submissionUsers.id, id)).get()!;
    setDriveExpiry(handle.db, dateAt(clock + 12 * DAY));
    let sequence = 0x4d12abcd;
    function random(maximum: number) {
      sequence = (Math.imul(sequence, 1_664_525) + 1_013_904_223) >>> 0;
      return sequence % maximum;
    }
    let restorations = 0;
    let expirations = 0;
    for (let step = 0; step < 144; step++) {
      const elapsed = random(DAY * 3) + 1;
      for (const id of finite) {
        const consumed = Math.min(elapsed, availableTime(read(id), clock));
        remaining.set(id, remaining.get(id)! - consumed);
      }
      clock += elapsed;
      vi.setSystemTime(clock);
      const id = finite[random(finite.length)]!;
      const user = read(id);
      const targetClock = clock + (10 + random(250)) * DAY + random(1000);
      const targetDate = dateAt(targetClock);
      const days = 1 + random(25);
      if (step % 8 < 3) {
        const offsetDays = [-5, 8, 32][step % 8]!;
        const before = read(permanent.id);
        const result = setDriveExpiry(handle.db, dateAt(clock + offsetDays * DAY));
        if (availableTime(before, clock) === 0 && availableTime(read(permanent.id), clock) > 0) restorations++;
        if (availableTime(before, clock) > 0 && availableTime(read(permanent.id), clock) === 0) expirations++;
        expect(setDriveExpiry(handle.db, result.limit.date).changedMemberIds).toEqual([]);
      } else if (step % 8 === 3 || step % 8 === 4) {
        const fixed = step % 8 === 4;
        const grant = fixed ? { mode: "date", date: targetDate } : { mode: "days", days };
        const input = renewalSchema.parse({
          ...grant,
          expectedExpiresAt: user.subscriptionExpiresAt,
          expectedDeferredMembershipMs: user.deferredMembershipMs,
          requestId: randomUUID(),
        });
        const old = remaining.get(id)!;
        const requested = fixedAt(targetClock) - clock;
        if (fixed && requested <= old) {
          expect(() => renewMember(handle.db, id, input)).toThrow("renewal_date_not_later");
        } else {
          expect(renewMember(handle.db, id, input).repeated).toBe(false);
          expect(renewMember(handle.db, id, input).repeated).toBe(true);
          remaining.set(id, fixed ? requested : old + days * DAY);
        }
      } else if (step % 8 === 5 || step % 8 === 6) {
        const fixed = step % 8 === 6;
        const card = createCardKeys(handle.db, {
          count: 1,
          kind: "custom",
          ...(fixed ? { expiresAt: targetDate } : { days }),
        })[0]!;
        expect(activateMembershipWithCard(handle.db, card, user.email).card.idempotent).toBe(false);
        expect(activateMembershipWithCard(handle.db, card, user.email).card.idempotent).toBe(true);
        const old = remaining.get(id)!;
        remaining.set(id, fixed ? Math.max(old, fixedAt(targetClock) - clock) : old + days * DAY);
      } else {
        const old = handle.db.select().from(submissionUsers).all();
        const settings = getDriveExpiry(handle.db);
        handle.close();
        handle = createDatabase(path);
        expect(getDriveExpiry(handle.db)).toEqual(settings);
        expect(handle.db.select().from(submissionUsers).all()).toEqual(old);
      }

      const cap = getDriveExpiry(handle.db)!;
      expect(read(permanent.id)).toMatchObject({ subscriptionExpiresAt: cap.expiresAt, followsDriveExpiry: true });
      for (const member of handle.db.select().from(submissionUsers).all()) {
        expect(Date.parse(member.subscriptionExpiresAt!)).toBeLessThanOrEqual(Date.parse(cap.expiresAt));
        if (member.followsDriveExpiry) continue;
        expect(member.deferredMembershipMs).toBeGreaterThanOrEqual(0);
        expect(availableTime(member, clock) + member.deferredMembershipMs, `step ${step}, member ${member.id}`).toBe(
          remaining.get(member.id),
        );
      }
    }
    expect(restorations).toBeGreaterThanOrEqual(10);
    expect(expirations).toBeGreaterThanOrEqual(10);
  } finally {
    handle.close();
    rmSync(directory, { recursive: true, force: true });
    vi.useRealTimers();
  }
});

it("rolls back a multi-member cap adjustment and both grant methods when a later database write fails", () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(start);
  const handle = createDatabase(":memory:");
  try {
    const database = handle.db;
    const members = ["one", "two", "three"].map((name) =>
      addSubmissionUser(database, {
        email: `${name}@example.invalid`,
        subscriptionExpiresAt: new Date(start + 100 * DAY).toISOString(),
      }),
    );
    setDriveExpiry(database, dateAt(start + 25 * DAY));
    const card = createCardKeys(database, { kind: "year", count: 1 })[0]!;
    const before = () => ({
      limit: getDriveExpiry(database),
      members: database.select().from(submissionUsers).all(),
      audits: database.select().from(auditLogs).all(),
      mail: database.select().from(renewalEmailOutbox).all(),
      cards: database.select().from(cardKeys).all(),
    });
    const snapshot = before();
    database.run(sql`CREATE TRIGGER fixture_drive_batch_fault BEFORE UPDATE ON submission_users
      WHEN NEW.id = ${sql.raw(String(members[1]!.id))} BEGIN SELECT RAISE(ABORT, 'fixture second member'); END`);
    expect(() => setDriveExpiry(database, dateAt(start + 60 * DAY))).toThrow("fixture second member");
    expect(before()).toEqual(snapshot);
    database.run(sql`DROP TRIGGER fixture_drive_batch_fault`);
    database.run(sql`CREATE TRIGGER fixture_drive_mail_fault BEFORE INSERT ON renewal_email_outbox
      BEGIN SELECT RAISE(ABORT, 'fixture outbox'); END`);
    const first = database.select().from(submissionUsers).where(eq(submissionUsers.id, members[0]!.id)).get()!;
    const input = renewalSchema.parse({
      mode: "days",
      days: 9,
      requestId: randomUUID(),
      expectedExpiresAt: first.subscriptionExpiresAt,
      expectedDeferredMembershipMs: first.deferredMembershipMs,
    });
    expect(() => renewMember(database, first.id, input)).toThrow("fixture outbox");
    expect(() => activateMembershipWithCard(database, card, first.email)).toThrow("fixture outbox");
    expect(before()).toEqual(snapshot);
  } finally {
    handle.close();
    vi.useRealTimers();
  }
});

it("banks and restores a single millisecond without releasing it into a cap that ends at the current instant", () => {
  const handle = createDatabase(":memory:");
  try {
    const oldCap = normalizeExpiryDate("2028-08-31")!;
    const atCap = Date.parse(oldCap);
    const user = addSubmissionUser(handle.db, { email: "millisecond@example.invalid", subscriptionExpiresAt: oldCap });
    const read = () => handle.db.select().from(submissionUsers).where(eq(submissionUsers.id, user.id)).get()!;
    setDriveExpiry(handle.db, "2028-08-31", new Date(atCap - 1));
    setDriveExpiry(handle.db, "2028-08-30", new Date(atCap - 1));
    expect(read().deferredMembershipMs).toBe(1);
    expect(setDriveExpiry(handle.db, "2028-08-31", new Date(atCap)).releasedMembers).toBe(0);
    expect(read().deferredMembershipMs).toBe(1);
    expect(setDriveExpiry(handle.db, "2028-09-01", new Date(atCap)).releasedMembers).toBe(1);
    expect(read()).toMatchObject({ subscriptionExpiresAt: new Date(atCap + 1).toISOString(), deferredMembershipMs: 0 });
    expect(memberStatus(read(), new Date(atCap))).toBe("expiring");
    expect(memberStatus(read(), new Date(atCap + 1))).toBe("expired");
  } finally {
    handle.close();
  }
});
