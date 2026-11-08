import { expect, test, type APIRequestContext, type APIResponse } from "@playwright/test";
import { startMemberRegistrationFixture } from "./member-registration-fixture";

const subscriptions = "/api/public/subscriptions";
const profilePath = `${subscriptions}/member/profile`;
const groupNumber = "889900112";
const inviteCode = "Register_Fixture_1";
const replacementCode = "Register_Fixture_2";
const email = "100009031@qq.com";
const otherEmail = "100009032@qq.com";
const legacyEmail = "legacy-member@example.com";

interface CardRecord {
  code: string;
  status: "unused" | "used";
  usedByEmail: string | null;
}

interface MemberRecord {
  email: string;
  subscriptionExpiresAt: string;
  profile: { qqNumber: string | null; joinSource: string | null; avatarSyncStatus: string | null };
}

async function requireError(response: APIResponse, status: number, error: string) {
  expect(response.status()).toBe(status);
  expect(await response.json()).toEqual({ error });
  expect(response.headers()["set-cookie"]).toBeUndefined();
}

test.describe("isolated member registration HTTP boundaries", () => {
  let fixture: Awaited<ReturnType<typeof startMemberRegistrationFixture>>;
  let admin: APIRequestContext;
  let visitor: APIRequestContext;
  let secondVisitor: APIRequestContext;

  test.beforeEach(async ({ playwright }) => {
    fixture = await startMemberRegistrationFixture();
    admin = await playwright.request.newContext({ baseURL: fixture.baseURL });
    visitor = await playwright.request.newContext({ baseURL: fixture.baseURL });
    secondVisitor = await playwright.request.newContext({ baseURL: fixture.baseURL });
    expect((await admin.post("/api/auth/login", { data: { username: "admin", password: "admin123" } })).status()).toBe(
      200,
    );
    const patch = await admin.patch("/api/settings", {
      data: {
        values: {
          "member.groupInviteEnabled": true,
          "member.groupNumber": groupNumber,
          "member.groupInviteCode": inviteCode,
        },
      },
    });
    expect(patch.status()).toBe(200);
    expect(JSON.stringify(await patch.json())).not.toContain(inviteCode);
  });

  test.afterEach(async () => {
    try {
      await Promise.all([admin?.dispose(), visitor?.dispose(), secondVisitor?.dispose()]);
      expect(fixture?.blockedRequests() ?? []).toEqual([]);
      expect(fixture?.unexpected ?? []).toEqual([]);
      expect(fixture?.unexpectedEmbyRequests ?? []).toEqual([]);
    } finally {
      await fixture?.close();
    }
  });

  async function cards(count = 1): Promise<string[]> {
    const response = await admin.post("/api/cards", { data: { kind: "trial", count } });
    expect(response.status()).toBe(201);
    const body = (await response.json()) as { codes: string[] };
    expect(body.codes).toHaveLength(count);
    return body.codes;
  }

  async function cardRecord(cardCode: string) {
    const response = await admin.get("/api/cards");
    expect(response.status()).toBe(200);
    const body = (await response.json()) as { cards: CardRecord[] };
    return body.cards.find((card) => card.code === cardCode);
  }

  async function memberRecords(): Promise<MemberRecord[]> {
    const response = await admin.get("/api/submission-users");
    expect(response.status()).toBe(200);
    return (await response.json()).users;
  }

  async function issueAndVerify(client: APIRequestContext, email: string, cardCode: string, inviteCode: string) {
    const sent = await client.post(`${subscriptions}/code`, { data: { email, cardCode, inviteCode } });
    expect(sent.status()).toBe(200);
    const code = fixture.codeFor(email);
    expect(code).toMatch(/^\d{6}$/);
    const verified = await client.post(`${subscriptions}/register/verify`, {
      data: { email, cardCode, inviteCode, code },
    });
    expect(verified.status()).toBe(200);
    expect(verified.headers()["set-cookie"]).toBeUndefined();
    const proof = (await verified.json()) as { registrationToken: string; qqNumber: string };
    expect(proof.qqNumber).toBe(email.split("@")[0]);
    return proof.registrationToken;
  }

  test("binds the proof to the email, card and current invite, and preserves unused cards across a restart", async () => {
    const [cardCode, alternateCard] = await cards(2);
    const entry = await visitor.post(`${subscriptions}/entry`, { data: { email } });
    expect(await entry.json()).toMatchObject({ needsCard: true, groupInvite: { groupNumber } });
    const token = await issueAndVerify(visitor, email, cardCode!, inviteCode);

    const activate = (data: Record<string, unknown>) =>
      visitor.post(`${subscriptions}/activate`, { data: { email, cardCode, registrationToken: token, ...data } });
    await requireError(await activate({ email: otherEmail }), 400, "registration_verification_required");
    await requireError(await activate({ cardCode: alternateCard }), 400, "card_mismatch");
    const rotated = await admin.patch("/api/settings", {
      data: { values: { "member.groupInviteCode": replacementCode } },
    });
    expect(rotated.status()).toBe(200);
    await requireError(await activate({}), 400, "registration_verification_required");
    await requireError(
      await visitor.post(`${subscriptions}/code`, { data: { email, cardCode, inviteCode } }),
      400,
      "invalid_group_invite",
    );
    expect(fixture.messages.filter((message) => message.recipient === email)).toHaveLength(1);

    const rotatedToken = await issueAndVerify(visitor, email, cardCode!, replacementCode);
    await fixture.restart();
    await requireError(await activate({ registrationToken: rotatedToken }), 400, "registration_verification_required");
    expect(await cardRecord(cardCode!)).toMatchObject({ status: "unused", usedByEmail: null });
    expect(await cardRecord(alternateCard!)).toMatchObject({ status: "unused", usedByEmail: null });
    expect((await memberRecords()).filter((member) => [email, otherEmail].includes(member.email))).toEqual([]);
    expect(fixture.embyUser(email)).toBeUndefined();

    const freshToken = await issueAndVerify(visitor, email, cardCode!, replacementCode);
    const finished = await activate({ registrationToken: freshToken, joinSource: "重启后重新验证" });
    expect(finished.status()).toBe(200);
    expect(await cardRecord(cardCode!)).toMatchObject({ status: "used", usedByEmail: email });
    await expect
      .poll(async () => {
        const profile = await visitor.get(profilePath);
        return (await profile.json()).profile?.avatarSyncStatus;
      })
      .toBe("synced");
    expect(fixture.avatarUploads.filter((upload) => upload.accepted)).toHaveLength(1);
    await fixture.restart();
    const profile = await visitor.get(profilePath);
    expect(profile.status()).toBe(200);
    expect(await profile.json()).toMatchObject({
      profile: { qqNumber: "100009031", joinSource: "重启后重新验证", avatarSyncStatus: "synced" },
    });
    expect(await cardRecord(cardCode!)).toMatchObject({ status: "used", usedByEmail: email });
    expect(fixture.avatarUploads.filter((upload) => upload.accepted)).toHaveLength(1);
  });

  test("two verified emails competing for one card create exactly one member and one avatar", async () => {
    const [cardCode] = await cards();
    const firstToken = await issueAndVerify(visitor, email, cardCode!, inviteCode);
    const secondToken = await issueAndVerify(secondVisitor, otherEmail, cardCode!, inviteCode);
    const attempt = (client: APIRequestContext, address: string, registrationToken: string) =>
      client.post(`${subscriptions}/activate`, { data: { email: address, cardCode, registrationToken } });
    const results = await Promise.all([
      attempt(visitor, email, firstToken),
      attempt(secondVisitor, otherEmail, secondToken),
    ]);
    expect(results.map((response) => response.status()).sort()).toEqual([200, 400]);
    const firstWon = results[0].ok();
    const winner = firstWon ? email : otherEmail;
    const loser = firstWon ? otherEmail : email;
    const winnerClient = firstWon ? visitor : secondVisitor;
    const loserClient = firstWon ? secondVisitor : visitor;
    await requireError(results[firstWon ? 1 : 0], 400, "card_used");
    expect(await cardRecord(cardCode!)).toMatchObject({ status: "used", usedByEmail: winner });
    expect((await memberRecords()).filter((member) => [email, otherEmail].includes(member.email))).toEqual([
      expect.objectContaining({ email: winner }),
    ]);
    expect(fixture.embyUser(loser)).toBeUndefined();
    await expect.poll(() => fixture.avatarUploads.filter((upload) => upload.accepted).length).toBe(1);
    expect((await loserClient.get(profilePath)).status()).toBe(401);
    expect((await winnerClient.get("/api/submission-users")).status()).toBe(401);
    await requireError(
      await attempt(winnerClient, winner, firstWon ? firstToken : secondToken),
      409,
      "already_registered",
    );
    expect(fixture.avatarUploads.filter((upload) => upload.accepted)).toHaveLength(1);
  });

  test("SMTP rejection preserves new cards while legacy non-QQ members still log in and renew", async () => {
    const [cardCode] = await cards();
    fixture.setSmtpFailure(true);
    await requireError(
      await visitor.post(`${subscriptions}/code`, { data: { email, cardCode, inviteCode } }),
      502,
      "email_send_failed",
    );
    fixture.setSmtpFailure(false);
    expect(await cardRecord(cardCode!)).toMatchObject({ status: "unused" });
    expect(fixture.embyUser(email)).toBeUndefined();
    expect((await memberRecords()).some((member) => member.email === email)).toBe(false);

    const expiration = new Date(Date.now() + 2 * 86_400_000).toISOString();
    const created = await admin.post("/api/submission-users", {
      data: { email: legacyEmail, subscriptionExpiresAt: expiration },
    });
    expect(created.status()).toBe(201);
    const entry = await visitor.post(`${subscriptions}/entry`, { data: { email: legacyEmail } });
    expect(await entry.json()).toEqual({ registered: true, needsCard: false, expired: false });
    const signInMail = await visitor.post(`${subscriptions}/code`, { data: { email: legacyEmail } });
    expect(signInMail.status()).toBe(200);
    const signedIn = await visitor.post(`${subscriptions}/login`, {
      data: { email: legacyEmail, code: fixture.codeFor(legacyEmail) },
    });
    expect(signedIn.status()).toBe(200);
    expect(await (await visitor.get(profilePath)).json()).toMatchObject({
      profile: { qqNumber: null, joinSource: null },
    });

    const renewMail = await visitor.post(`${subscriptions}/code`, { data: { email: legacyEmail, cardCode } });
    expect(renewMail.status()).toBe(200);
    const renewed = await visitor.post(`${subscriptions}/activate`, {
      data: { email: legacyEmail, cardCode, code: fixture.codeFor(legacyEmail) },
    });
    expect(renewed.status()).toBe(200);
    expect(await cardRecord(cardCode!)).toMatchObject({ status: "used", usedByEmail: legacyEmail });
    const legacy = (await memberRecords()).find((member) => member.email === legacyEmail);
    expect(Date.parse(legacy?.subscriptionExpiresAt ?? "")).toBe(Date.parse(expiration) + 10 * 86_400_000);
    expect(fixture.avatarUploads).toHaveLength(0);
  });
});
