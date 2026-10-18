import { createHmac } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPublicSessionManager } from "../subscriptions/public-session";
import { createSessionManager } from "./session";
import { staticCredentialVerifier } from "./test-session";

const secret = "shared-configuration-secret";
const admin = createSessionManager({ sessionSecret: secret, verifyCredentials: staticCredentialVerifier("password") });
const member = createPublicSessionManager(secret);
const cookieValue = (cookie: string) => cookie.split(";")[0]!.split("=")[1]!;

describe("admin and member HTTP session isolation", () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    const app = express();
    app.get("/admin", admin.requireSession, (_request, response) => response.json({ admin: true }));
    app.get("/member", (request, response) => {
      const { email } = member.read(request.headers.cookie);
      response.status(email ? 200 : 401).json({ email });
    });
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function status(route: string, cookie: string) {
    const response = await fetch(`${baseUrl}/${route}`, { headers: { cookie } });
    await response.text();
    return response.status;
  }

  it("accepts current valid cookies only at their own gate", async () => {
    expect(await status("admin", admin.issueCookie())).toBe(200);
    expect(await status("member", member.issueCookie("audit@example.invalid"))).toBe(200);
  });

  it("rejects a member token renamed to the admin cookie, including a rewritten purpose", async () => {
    const token = cookieValue(member.issueCookie("audit@example.invalid"));
    expect(await status("admin", `emby_task_session=${token}`)).toBe(401);
    expect(await status("admin", `emby_task_session=${token.replace(".member.", ".admin.")}`)).toBe(401);
  });

  it("rejects an admin token renamed to the member cookie, including a rewritten purpose", async () => {
    const token = cookieValue(admin.issueCookie());
    expect(await status("member", `emby_public_session=${token}`)).toBe(401);
    expect(await status("member", `emby_public_session=${token.replace(".admin.", ".member.")}`)).toBe(401);
  });

  it("rejects both correctly signed legacy token types at both gates", async () => {
    const expiresAt = Math.floor(Date.now() / 1000) + 3600;
    for (const payload of ["old-admin-nonce", Buffer.from("audit@example.invalid").toString("base64url")]) {
      const body = `${expiresAt}.${payload}`;
      const token = `${body}.${createHmac("sha256", secret).update(body).digest("base64url")}`;
      expect(await status("admin", `emby_task_session=${token}`)).toBe(401);
      expect(await status("member", `emby_public_session=${token}`)).toBe(401);
    }
  });

  it("rejects missing, expired and tampered admin cookies", async () => {
    expect(await status("admin", "unrelated=1")).toBe(401);
    expect(await status("admin", admin.issueCookie(new Date("2020-01-01T00:00:00Z")))).toBe(401);
    const token = cookieValue(admin.issueCookie());
    expect(await status("admin", `emby_task_session=${token.slice(0, -1)}!`)).toBe(401);
  });
});
