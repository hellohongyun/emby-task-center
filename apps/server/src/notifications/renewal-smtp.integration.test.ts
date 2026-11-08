import { randomUUID } from "node:crypto";
import { createServer as createSmtpServer, type Socket } from "node:net";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDatabase, type DatabaseHandle } from "@emby-task-center/database/client";
import { renewalEmailOutbox, submissionUsers } from "@emby-task-center/database/schema";
import { createEmailNotifier, type EmailNotifier } from "./email-service";
import { registerMemberRenewal } from "../routes/member-renewal";
import { setDriveExpiry } from "../subscriptions/drive-expiry";

/** A real local SMTP transport. No external server, credentials or real recipient. */
async function smtpFixture() {
  const sockets = new Set<Socket>();
  const messages: Array<{ recipient: string; raw: string }> = [];
  const state = { reject: false, attempts: 0 };
  const server = createSmtpServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
    socket.setEncoding("utf8");
    socket.write("220 localhost SMTP integration fixture\r\n");
    let pending = "",
      recipient = "";
    let data: string[] | null = null;
    socket.on("data", (chunk) => {
      pending += chunk;
      let end: number;
      while ((end = pending.indexOf("\r\n")) >= 0) {
        const line = pending.slice(0, end);
        pending = pending.slice(end + 2);
        if (data) {
          if (line === ".") {
            messages.push({ recipient, raw: data.join("\r\n") });
            data = null;
            socket.write("250 Message accepted\r\n");
          } else data.push(line.startsWith("..") ? line.slice(1) : line);
        } else if (/^(EHLO|HELO)\b/i.test(line)) socket.write("250-localhost\r\n250 SIZE 1000000\r\n");
        else if (/^MAIL FROM:/i.test(line)) {
          state.attempts++;
          socket.write(state.reject ? "451 Temporary fixture failure\r\n" : "250 Sender accepted\r\n");
        } else if (/^RCPT TO:/i.test(line)) {
          recipient = /^RCPT TO:<([^>]+)>/i.exec(line)?.[1] ?? "";
          socket.write("250 Recipient accepted\r\n");
        } else if (/^DATA$/i.test(line)) {
          data = [];
          socket.write("354 End with a dot\r\n");
        } else if (/^QUIT$/i.test(line)) socket.end("221 Bye\r\n");
        else socket.write("250 OK\r\n");
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as AddressInfo).port,
    state,
    messages,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function plainText(raw: string): string {
  const match = /Content-Type: text\/plain[^\r\n]*\r\n([\s\S]*?)\r\n\r\n([\s\S]*?)(?:\r\n--|$)/i.exec(raw);
  if (!match) throw new Error("SMTP message has no plain text part");
  if (/Content-Transfer-Encoding: base64/i.test(match[1]!)) return Buffer.from(match[2]!, "base64").toString("utf8");
  if (!/Content-Transfer-Encoding: quoted-printable/i.test(match[1]!)) return match[2]!;
  const binary = match[2]!
    .replace(/=\r\n/g, "")
    .replace(/=([\da-f]{2})/gi, (_all, hex: string) => String.fromCharCode(parseInt(hex, 16)));
  return Buffer.from(binary, "latin1").toString("utf8");
}

describe("renewal delivery through actual Nodemailer and local SMTP", () => {
  let database: DatabaseHandle;
  let smtp: Awaited<ReturnType<typeof smtpFixture>>;
  let server: Server;
  let notifier: EmailNotifier;
  let base: string;
  let member: typeof submissionUsers.$inferSelect;
  beforeEach(async () => {
    database = createDatabase(":memory:");
    smtp = await smtpFixture();
    notifier = createEmailNotifier({
      host: "127.0.0.1",
      port: smtp.port,
      secure: false,
      fromName: "本地测试",
      fromAddress: "sender@example.invalid",
    });
    const timestamp = new Date().toISOString();
    member = database.db
      .insert(submissionUsers)
      .values({
        email: "recipient@example.invalid",
        subscriptionExpiresAt: "2030-01-01T00:00:00.000Z",
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .returning()
      .get();
    const app = express();
    app.use(express.json());
    registerMemberRenewal(app, { database: database.db, email: notifier });
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await smtp.close();
    database.close();
  });
  const input = () => ({
    mode: "days",
    days: 7,
    requestId: randomUUID(),
    expectedExpiresAt: member.subscriptionExpiresAt,
    expiryLabel: "劳动节假期结束到期",
  });
  async function renew(body: unknown) {
    const response = await fetch(`${base}/api/submission-users/${member.id}/renew`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(200);
    return response.json();
  }

  it("delivers the actual MIME receipt to the right member and confirms it only after SMTP acceptance", async () => {
    const result = await renew(input());
    expect(result.emailStatus).toBe("sent");
    expect(smtp.messages).toHaveLength(1);
    expect(smtp.messages[0]!.recipient).toBe(member.email);
    const text = plainText(smtp.messages[0]!.raw);
    expect(text).toContain("管理员");
    expect(text).toContain("劳动节假期结束到期");
    expect(text).toContain("2030");
    expect(database.db.select().from(renewalEmailOutbox).get()?.sentAt).toBeTruthy();
  });

  it("survives a real SMTP rejection, retries through the existing notifier, and does not resend or extend twice", async () => {
    smtp.state.reject = true;
    const request = input();
    const result = await renew(request);
    expect(result.emailStatus).toBe("pending");
    expect(result.user.subscriptionExpiresAt).toBe("2030-01-08T00:00:00.000Z");
    expect(smtp.messages).toHaveLength(0);
    expect(smtp.state.attempts).toBe(1);
    expect((await renew(request)).emailStatus).toBe("unchanged");
    expect(smtp.state.attempts).toBe(1);
    smtp.state.reject = false;
    database.db.update(renewalEmailOutbox).set({ nextAttemptAt: "2000-01-01T00:00:00.000Z" }).run();
    await notifier.retryPending(database.db);
    expect(smtp.messages).toHaveLength(1);
    expect(smtp.messages[0]!.recipient).toBe(member.email);
    expect(database.db.select().from(renewalEmailOutbox).get()?.sentAt).toBeTruthy();
    await notifier.retryPending(database.db);
    expect(smtp.messages).toHaveLength(1);
    expect(smtp.state.attempts).toBe(2);
    expect(database.db.select().from(submissionUsers).get()?.subscriptionExpiresAt).toBe(
      result.user.subscriptionExpiresAt,
    );
  });

  it("retries a capped receipt with the actual expiry and keeps the deferred entitlement private", async () => {
    const { limit } = setDriveExpiry(database.db, "2030-01-04");
    const request = input();
    smtp.state.reject = true;
    const result = await renew(request);
    expect(result.emailStatus).toBe("pending");
    expect(result.user.subscriptionExpiresAt).toBe(limit.expiresAt);
    expect(result.user.deferredMembershipMs).toBe(Date.parse("2030-01-08T00:00:00.000Z") - Date.parse(limit.expiresAt));
    expect((await renew(request)).user.deferredMembershipMs).toBe(result.user.deferredMembershipMs);
    expect(smtp.state.attempts).toBe(1);

    smtp.state.reject = false;
    database.db.update(renewalEmailOutbox).set({ nextAttemptAt: "2000-01-01T00:00:00.000Z" }).run();
    await notifier.retryPending(database.db);
    expect(smtp.messages).toHaveLength(1);
    const message = smtp.messages[0]!;
    expect(message.recipient).toBe(member.email);
    const text = plainText(message.raw);
    expect(text).toContain(`本次续期后有效期：${new Date(limit.expiresAt).toLocaleString()}`);
    expect(text).not.toMatch(/待激活|网盘|劳动节假期结束到期|增加 7 天/);
  });
});
