import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { issueSessionToken, readSessionToken } from "./session-token";

const secret = "session-test-secret";
const now = new Date("2026-09-30T00:00:00Z");
const expiresAt = Math.floor(now.getTime() / 1_000) + 60;
const options = { secret, purpose: "admin" as const };

// 用正确签名构造不规范输入，确保拒绝来自格式校验，而不只是签名碰巧不匹配。
function signedToken(expiresText: string, payload = "fixture", version = "v2") {
  const body = `${version}.admin.${expiresText}.${payload}`;
  const key = createHmac("sha256", secret).update("emby-task-center:session:v2:admin").digest();
  return `${body}.${createHmac("sha256", key).update(body).digest("base64url")}`;
}

describe("versioned session tokens", () => {
  it.each(["admin", "member"] as const)("binds valid %s tokens to their purpose and secret", (purpose) => {
    const token = issueSessionToken({ secret, purpose, expiresAt, payload: "fixture" });
    expect(readSessionToken(token, { secret, purpose }, now)).toBe("fixture");
    const other = purpose === "admin" ? "member" : "admin";
    expect(readSessionToken(token, { secret, purpose: other }, now)).toBeNull();
    expect(readSessionToken(token.replace(`.${purpose}.`, `.${other}.`), { secret, purpose: other }, now)).toBeNull();
    expect(readSessionToken(token, { secret: "different-secret", purpose }, now)).toBeNull();
  });

  it("rejects expiration at the current second and later", () => {
    const token = issueSessionToken({ ...options, expiresAt, payload: "fixture" });
    expect(readSessionToken(token, options, new Date(expiresAt * 1000 - 1))).toBe("fixture");
    expect(readSessionToken(token, options, new Date(expiresAt * 1000))).toBeNull();
    expect(readSessionToken(token, options, new Date(expiresAt * 1000 + 1000))).toBeNull();
    expect(readSessionToken(token, options, new Date(Number.NaN))).toBeNull();
  });

  it.each(["", "0", "-1", "01", "1e12", "Infinity", "NaN", "9007199254740992", "123.45"])(
    "rejects correctly signed invalid expiry %j",
    (expiry) => expect(readSessionToken(signedToken(expiry), options, now)).toBeNull(),
  );

  it.each(["", "+", "with.dot", "x".repeat(1025)])("rejects invalid encoded payload %j", (payload) => {
    expect(readSessionToken(signedToken(String(expiresAt), payload), options, now)).toBeNull();
  });

  it("rejects old formats, unknown versions, altered signatures and extra segments without throwing", () => {
    const legacyBody = `${expiresAt}.fixture`;
    const legacyToken = `${legacyBody}.${createHmac("sha256", secret).update(legacyBody).digest("base64url")}`;
    const token = signedToken(String(expiresAt));
    const malformed = [
      legacyToken,
      signedToken(String(expiresAt), "fixture", "v3"),
      token.replace(/.$/, "!"),
      token.slice(0, -1),
      `${token}.extra`,
      token.replace("fixture", "changed"),
      token.replace(/\.[^.]+$/, `.${"x".repeat(43)}`),
      "x".repeat(1201),
    ];
    for (const value of malformed) expect(readSessionToken(value, options, now)).toBeNull();
  });
});
