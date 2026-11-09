import { createDatabase, type DatabaseHandle } from "@emby-task-center/database/client";
import { migrate } from "@emby-task-center/database/migrate";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  claimShare115Job,
  completeShare115Job,
  enqueueShare115,
  enqueueShare115Batch,
  listShare115,
  recoverExpiredShare115Jobs,
  resolveShare115Job,
  Share115AdmissionError,
} from "./store";

const submitted = "2026-11-09T00:00:00.000Z";
const started = "2026-11-09T00:00:01.000Z";
const expired = "2026-11-09T00:01:01.000Z";
const page = { page: 1, pageSize: 10 };

function submission(memberId: number, shareCode = "share1", accessCode = "0123") {
  return {
    memberId,
    memberEmail: `member${memberId}@example.test`,
    shareUrl: `https://115.com/s/${shareCode}`,
    shareCode,
    accessCode,
    note: "补 E03–E05",
    now: submitted,
  };
}

describe("115 share storage", () => {
  let handle: DatabaseHandle;

  beforeEach(() => {
    handle = createDatabase(":memory:");
  });
  afterEach(() => handle.close());

  it("shares one active job and preserves each member's submission, timestamp and access code", () => {
    const first = enqueueShare115(handle.db, submission(1));
    const second = enqueueShare115(handle.db, { ...submission(2), now: started });
    const duplicate = enqueueShare115(handle.db, { ...submission(1), now: started, note: "其他说明" });
    const differentAccessCode = enqueueShare115(handle.db, submission(3, "share1", "9999"));

    expect(duplicate).toEqual(first);
    expect(second).toMatchObject({ jobId: first.jobId, memberId: 2, submittedAt: started, accessCode: "0123" });
    expect(second.id).not.toBe(first.id);
    expect(differentAccessCode.jobId).not.toBe(first.jobId);
    expect(listShare115(handle.db, { ...page, memberId: 1 })).toEqual({ items: [first], total: 1 });
    expect(listShare115(handle.db, { ...page, status: "queued", q: "MEMBER2", pageSize: 1 })).toEqual({
      items: [second],
      total: 1,
    });
    expect(listShare115(handle.db, { ...page, q: "0123" }).total).toBe(0);
  });

  it("upgrades existing submissions and keeps administrator and member histories distinct for one job", () => {
    const member = enqueueShare115(handle.db, submission(1));
    // Recreate the previous column layout on the temporary database.
    handle.db.run(sql`ALTER TABLE share_115_submissions DROP COLUMN admin_username`);
    migrate(handle.db);

    const input = { ...submission(0), memberEmail: "", adminUsername: "operator", now: started };
    const administrator = enqueueShare115(handle.db, input);
    expect(administrator).toMatchObject({ jobId: member.jobId, memberId: 0, adminUsername: "operator" });
    expect(administrator.id).not.toBe(member.id);
    expect(enqueueShare115(handle.db, input)).toEqual(administrator);

    migrate(handle.db);
    expect(listShare115(handle.db, { ...page, memberId: 1 })).toEqual({ items: [member], total: 1 });
    expect(listShare115(handle.db, { ...page, memberId: 1, q: "operator" }).total).toBe(0);
    expect(listShare115(handle.db, { ...page, q: "OPERATOR" })).toEqual({ items: [administrator], total: 1 });
  });

  it("rejects invalid uses of the reserved administrator identity before enqueuing a job", () => {
    expect(() => enqueueShare115(handle.db, { ...submission(0), memberEmail: "" })).toThrow();
    expect(() => enqueueShare115(handle.db, { ...submission(1), adminUsername: "operator" })).toThrow();
    expect(listShare115(handle.db, page).total).toBe(0);
    expect(claimShare115Job(handle.db, { now: started, leaseExpiresAt: expired })).toBeUndefined();
  });

  it("applies submission and queue limits atomically, allowing existing submissions to be reused", () => {
    const limits = { since: submitted, maxPerMember: 1, maxPending: 1 };
    const first = enqueueShare115(handle.db, submission(1), limits);
    expect(enqueueShare115(handle.db, submission(1), limits)).toEqual(first);
    expect(enqueueShare115(handle.db, submission(2), limits).jobId).toBe(first.jobId);
    expect(() => enqueueShare115(handle.db, submission(1, "share2"), limits)).toThrow(
      new Share115AdmissionError("rate_limited"),
    );
    expect(() => enqueueShare115(handle.db, submission(3, "share2"), limits)).toThrow(
      new Share115AdmissionError("queue_full"),
    );
    expect(listShare115(handle.db, page).total).toBe(2);
  });

  it("reports admission limits per link and rolls back a batch on unexpected errors", () => {
    const limits = { since: submitted, maxPerMember: 1, maxPending: 3 };
    expect(enqueueShare115Batch(handle.db, [submission(1), submission(1, "share2")], limits)).toEqual([
      { row: expect.objectContaining({ shareCode: "share1" }) },
      { error: "rate_limited" },
    ]);

    expect(() => enqueueShare115Batch(handle.db, [submission(2, "share3"), submission(0)], limits)).toThrow();
    expect(listShare115(handle.db, page).items.map((row) => row.shareCode)).toEqual(["share1"]);
  });

  it("marks expired claims unconfirmed, refuses late writes and runs the next queued job", () => {
    const first = enqueueShare115(handle.db, submission(1));
    const second = enqueueShare115(handle.db, submission(2, "share2"));
    expect(claimShare115Job(handle.db, { now: started, leaseExpiresAt: expired })).toMatchObject({
      id: first.jobId,
      status: "running",
      startedAt: started,
      attemptCount: 1,
    });
    expect(claimShare115Job(handle.db, { now: started, leaseExpiresAt: expired })).toBeUndefined();
    expect(recoverExpiredShare115Jobs(handle.db, started)).toBe(0);
    expect(
      completeShare115Job(handle.db, { id: first.jobId, leaseExpiresAt: expired, now: expired, status: "saved" }),
    ).toBe(false);
    expect(recoverExpiredShare115Jobs(handle.db, expired)).toBe(1);
    expect(
      completeShare115Job(handle.db, { id: first.jobId, leaseExpiresAt: expired, now: started, status: "saved" }),
    ).toBe(false);
    expect(enqueueShare115(handle.db, submission(3))).toMatchObject({ jobId: first.jobId, status: "unconfirmed" });
    expect(claimShare115Job(handle.db, { now: expired, leaseExpiresAt: "2026-11-09T00:02:01.000Z" })).toMatchObject({
      id: second.jobId,
      status: "running",
    });
    expect(resolveShare115Job(handle.db, { id: first.jobId, now: expired, status: "failed" })).toBe(true);
    expect(resolveShare115Job(handle.db, { id: first.jobId, now: expired, status: "saved" })).toBe(false);
    expect(enqueueShare115(handle.db, { ...submission(1), now: expired }).jobId).not.toBe(first.jobId);
  });
});
