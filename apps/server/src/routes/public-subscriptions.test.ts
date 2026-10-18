import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { eq } from "drizzle-orm";

import { createDatabase, type DatabaseHandle } from "@emby-task-center/database/client";
import { concurrencyEscalationState, submissionUsers, verificationCodes } from "@emby-task-center/database/schema";
import { createApp } from "../app";
import { staticCredentialVerifier } from "../auth/test-session";
import { createLibraryService } from "../library/service";
import { issueVerificationCode } from "../subscriptions/verification";
import type { TmdbClient } from "../tmdb/client";
import type { EmbyClient } from "../integrations/emby-client";
import type { EmailNotifier } from "../notifications/email-service";

const sharedPassword = "family-password";
const sessionSecret = "session-signing-secret";

describe("public subscription (card + verification code) API", () => {
  let directory: string;
  let database: DatabaseHandle;
  let server: Server;
  let baseUrl: string;
  let createdEmbyUsers: string[];
  let emailsSent: Array<{ to: string; subject: string; text: string }>;
  let emby: EmbyClient;
  let setPasswordCalls: string[];

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "emby-subcard-"));
    database = createDatabase(join(directory, "app.sqlite"));
    createdEmbyUsers = [];
    emailsSent = [];
    setPasswordCalls = [];
    emby = {
      configured: true,
      systemInfo: async () => ({ serverName: "Emby", version: "1" }),
      verify: async () => true,
      listUsers: async () => [],
      createUser: async (name: string) => {
        createdEmbyUsers.push(name);
        return { Id: "emby-1", Name: name };
      },
      setUserPassword: async (id: string) => {
        setPasswordCalls.push(id);
      },
      updateUserPolicy: async () => undefined,
      deleteUser: async () => undefined,
      listSessions: async () => [],
      endSession: async () => undefined,
    } as never;
    const email: EmailNotifier = {
      configured: true,
      sendTest: async () => undefined,
      retryPending: async () => undefined,
      sendNotification: async (to, subject, text) => {
        emailsSent.push({ to, subject, text });
      },
    };
    const tmdb: TmdbClient = {
      search: async () => [],
      details: async () => {
        throw new Error("unused");
      },
      seasonProgress: async () => ({
        seasonNumber: 1,
        airedEpisodes: 1,
        totalEpisodes: 1,
        lastAirDate: null,
        nextAirDate: null,
      }),
      airedEpisodeCount: async () => 1,
      seasonEpisodes: async () => [],
    };
    const app = createApp({
      database: database.db,
      auth: { sessionSecret, verifyCredentials: staticCredentialVerifier(sharedPassword) },
      tmdb,
      library: createLibraryService([]),
      integrationServices: { emby, email },
    });
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });

  async function adminLogin(): Promise<string> {
    const response = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: sharedPassword }),
    });
    expect(response.status).toBe(200);
    return (response.headers.get("set-cookie") ?? "").split(";")[0];
  }

  async function createCard(kind: "trial" | "month", count = 1): Promise<string> {
    const cookie = await adminLogin();
    const res = await fetch(`${baseUrl}/api/cards`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ kind, count }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { codes: string[] };
    return body.codes[0]!;
  }

  function latestCode(): string {
    const rows = database.db.select().from(verificationCodes).orderBy(verificationCodes.id).all();
    return rows[rows.length - 1]!.code;
  }

  it("creates cards, sends a code, and activates a new member with an auto-created Emby account", async () => {
    const cardCode = await createCard("month", 1);

    const codeRes = await fetch(`${baseUrl}/api/public/subscriptions/code`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "new@example.com", cardCode }),
    });
    expect(codeRes.status).toBe(200);
    const sent = (await codeRes.json()) as { registered: boolean; needsCard: boolean };
    expect(sent.registered).toBe(false);
    expect(sent.needsCard).toBe(true);
    const code = latestCode();

    const activate = await fetch(`${baseUrl}/api/public/subscriptions/activate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "new@example.com", code, cardCode }),
    });
    expect(activate.status).toBe(200);
    const body = (await activate.json()) as {
      status: string;
      member: { email: string; status: string; embyMaxStreams: number | null };
      emby: { serverAddress: string; onboardTitle: string; onboardNotice: string } | null;
    };
    expect(body.status).toBe("activated");
    expect(body.member.email).toBe("new@example.com");
    expect(createdEmbyUsers).toContain("new@example.com");
    // 新注册会员**默认登记并发上限 1**（系统设置 →「会员」可改）：门户与后台都看得见这个值
    expect(body.member.embyMaxStreams).toBe(1);
    const created = database.db
      .select()
      .from(submissionUsers)
      .where(eq(submissionUsers.email, "new@example.com"))
      .get();
    expect(created?.embyMaxStreams).toBe(1);
    // 注册成功后在「我的」页显示的那块提示：整块文案由后台模板渲染下发（前端不写死）
    expect(body.emby?.onboardTitle).toContain("Emby 账号已开通");
    expect(body.emby?.onboardNotice).toContain("new@example.com");
    expect(body.emby?.onboardNotice).not.toContain("{{");
    // 邮件：验证码 + Emby 初始账号（主题/正文同样来自后台模板）
    const embyMail = emailsSent.find((mail) => mail.subject.includes("Emby 账号"));
    expect(embyMail).toBeTruthy();
    expect(embyMail!.text).toContain("同时最多允许 1 路播放");
  });

  it("logs in an existing member with just the verification code", async () => {
    // 先通过卡密开户
    const cardCode = await createCard("trial", 1);
    await fetch(`${baseUrl}/api/public/subscriptions/code`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "member@example.com", cardCode }),
    });
    await fetch(`${baseUrl}/api/public/subscriptions/activate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "member@example.com", code: latestCode(), cardCode }),
    });

    // 老用户登录：只输验证码
    const codeRes = await fetch(`${baseUrl}/api/public/subscriptions/code`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "member@example.com" }),
    });
    const registered = ((await codeRes.json()) as { registered: boolean }).registered;
    expect(registered).toBe(true);
    const login = await fetch(`${baseUrl}/api/public/subscriptions/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "member@example.com", code: latestCode() }),
    });
    expect(login.status).toBe(200);
    const body = (await login.json()) as { status: string; member: { status: string } };
    expect(body.status).toBe("member");
    expect(body.member.status).toBe("active");
  });

  it("会员能看到自己的并发上限，以及被冻结时的解冻时间", async () => {
    // 开户拿会话
    const cardCode = await createCard("month", 1);
    await fetch(`${baseUrl}/api/public/subscriptions/code`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "frozen@example.com", cardCode }),
    });
    const activate = await fetch(`${baseUrl}/api/public/subscriptions/activate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "frozen@example.com", code: latestCode(), cardCode }),
    });
    const cookie = (activate.headers.get("set-cookie") ?? "").split(";")[0];

    // 登记并发上限 + 造一条「已冻结、两小时后解冻」的状态
    const user = database.db
      .select()
      .from(submissionUsers)
      .where(eq(submissionUsers.email, "frozen@example.com"))
      .get();
    expect(user).toBeTruthy();
    const until = new Date(Date.now() + 2 * 3_600_000).toISOString();
    database.db.update(submissionUsers).set({ embyMaxStreams: 1 }).where(eq(submissionUsers.id, user!.id)).run();
    database.db
      .insert(concurrencyEscalationState)
      .values({
        memberId: user!.id,
        overshootSince: null,
        overshootMs: 0,
        notifiedAt: null,
        disabledUntil: until,
        updatedAt: new Date().toISOString(),
      })
      .run();

    const res = await fetch(`${baseUrl}/api/public/subscriptions/member`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      member: {
        embyMaxStreams: number | null;
        concurrency: { disabled: boolean; disabledUntil: string | null; remainingMs: number | null };
      };
    };
    // 门户要能自己讲清「为什么播不了、什么时候解冻」，否则会员只能来问管理员
    expect(body.member.embyMaxStreams).toBe(1);
    expect(body.member.concurrency.disabled).toBe(true);
    expect(body.member.concurrency.disabledUntil).toBe(until);
    expect(body.member.concurrency.remainingMs).toBeGreaterThan(0);
  });

  it("被冻结的会员能在门户自助解冻：先申请、等满等待秒数才放行，确认后账号真的恢复", async () => {
    // 1) 会员 + 门户会话（直接落库 + 发一张验证码，不走 /code：那条路有每 IP 限流，
    //    会把这个用例和同文件其它用例互相干扰）
    const email = "self-unfreeze@example.com";
    const ts = new Date().toISOString();
    database.db
      .insert(submissionUsers)
      .values({
        email,
        enabled: true,
        embyUserId: "emby-su",
        embyUsername: email,
        processPerDay: 2,
        processFirstBatch: 10,
        createdAt: ts,
        updatedAt: ts,
      })
      .run();
    const code = issueVerificationCode(database.db, email);
    const login = await fetch(`${baseUrl}/api/public/subscriptions/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, code }),
    });
    expect(login.status).toBe(200);
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
    const user = database.db.select().from(submissionUsers).where(eq(submissionUsers.email, email)).get();
    expect(user?.embyUserId).toBe("emby-su");

    // Emby 侧：账号此刻是停用的；解冻必须**确认**它被重新启用
    let embyDisabled = true;
    emby.listUsers = (async () => [
      { Id: user!.embyUserId!, Name: "self-unfreeze@example.com", Policy: { IsDisabled: embyDisabled } },
    ]) as never;
    emby.updateUserPolicy = (async (_id: string, policy: { IsDisabled?: boolean }) => {
      if (policy.IsDisabled !== undefined) embyDisabled = policy.IsDisabled;
    }) as never;

    database.db
      .insert(concurrencyEscalationState)
      .values({
        memberId: user!.id,
        overshootSince: null,
        overshootMs: 0,
        notifiedAt: null,
        disabledUntil: new Date(Date.now() + 3_600_000).toISOString(),
        updatedAt: new Date().toISOString(),
      })
      .run();

    // 2) 门户摘要里要直接带上解冻入口与后台文案（按钮显不显示由它决定）
    const me = await fetch(`${baseUrl}/api/public/subscriptions/member`, { headers: { cookie } });
    const meBody = (await me.json()) as {
      member: {
        concurrency: { disabled: boolean };
        unfreeze: { enabled: boolean; waitSeconds: number; notice: string };
      };
    };
    expect(meBody.member.concurrency.disabled).toBe(true);
    expect(meBody.member.unfreeze.enabled).toBe(true);
    expect(meBody.member.unfreeze.waitSeconds).toBe(60);
    expect(meBody.member.unfreeze.notice).toContain("同时播放上限");

    // 3) 点开弹窗：服务端记下申请时刻（等待时长按它算，前端倒计时只是展示）
    const ack = await fetch(`${baseUrl}/api/public/subscriptions/member/unfreeze/ack`, {
      method: "POST",
      headers: { cookie },
    });
    expect(ack.status).toBe(200);
    const ackBody = (await ack.json()) as { unfreeze: { requestedAt: string | null; readyAt: string | null } };
    expect(ackBody.unfreeze.requestedAt).toBeTruthy();
    expect(ackBody.unfreeze.readyAt).toBeTruthy();

    // 4) 刚申请就确认：没等满 → 拒绝，且账号还在停用、不消耗次数
    const tooEarly = await fetch(`${baseUrl}/api/public/subscriptions/member/unfreeze`, {
      method: "POST",
      headers: { cookie },
    });
    expect(tooEarly.status).toBe(400);
    expect(((await tooEarly.json()) as { error: string }).error).toBe("wait_not_elapsed");
    expect(embyDisabled).toBe(true);
    expect(emailsSent.some((mail) => mail.subject === "账号已解冻")).toBe(false);

    // 5) 管理员把等待秒数配成 0（后台可配），会员再确认 → 真的解冻
    const adminCookie = await adminLogin();
    const current = (await (
      await fetch(`${baseUrl}/api/concurrency-policy`, { headers: { cookie: adminCookie } })
    ).json()) as { policy: Record<string, unknown> };
    const put = await fetch(`${baseUrl}/api/concurrency-policy`, {
      method: "PUT",
      headers: { cookie: adminCookie, "content-type": "application/json" },
      body: JSON.stringify({ ...current.policy, unfreezeWaitSeconds: 0 }),
    });
    expect(put.status).toBe(200);

    const done = await fetch(`${baseUrl}/api/public/subscriptions/member/unfreeze`, {
      method: "POST",
      headers: { cookie },
    });
    expect(done.status).toBe(200);
    const doneBody = (await done.json()) as {
      member: { concurrency: { disabled: boolean }; unfreeze: { usedThisMonth: number; enabled: boolean } };
    };
    // 账号恢复了、状态清零了：门户横幅消失，次数也记上了
    expect(embyDisabled).toBe(false);
    expect(doneBody.member.concurrency.disabled).toBe(false);
    expect(doneBody.member.unfreeze.usedThisMonth).toBe(1);
    expect(doneBody.member.unfreeze.enabled).toBe(false); // 不再冻结 → 没有解冻入口
    expect(emailsSent.some((mail) => mail.to === email && mail.subject === "账号已解冻")).toBe(true);

    // 6) 没被冻结的会员再点一次：直接拒绝，不能白刷次数
    const again = await fetch(`${baseUrl}/api/public/subscriptions/member/unfreeze`, {
      method: "POST",
      headers: { cookie },
    });
    expect(again.status).toBe(400);
    expect(((await again.json()) as { error: string }).error).toBe("not_frozen");
  });

  it("rejects an invalid verification code", async () => {
    const res = await fetch(`${baseUrl}/api/public/subscriptions/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "member@example.com", code: "000000" }),
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: "invalid_code" });
  });

  it("lets a logged-in member change their own Emby password", async () => {
    const cardCode = await createCard("month", 1);
    await fetch(`${baseUrl}/api/public/subscriptions/code`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "member@example.com", cardCode }),
    });
    const activate = await fetch(`${baseUrl}/api/public/subscriptions/activate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "member@example.com", code: latestCode(), cardCode }),
    });
    expect(activate.status).toBe(200);
    const cookie = (activate.headers.get("set-cookie") ?? "").split(";")[0];
    const res = await fetch(`${baseUrl}/api/public/subscriptions/member/emby/password`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ password: "new-password-123" }),
    });
    expect(res.status).toBe(200);
    expect(setPasswordCalls).toContain("emby-1");
  });
});
