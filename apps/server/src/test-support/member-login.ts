/**
 * 测试专用：走门户的验证码流程拿到会员会话 Cookie。
 *
 * 历史上测试都用 `POST /api/public/submissions/login`（邮箱即登录）拿 Cookie；该端点已随
 * 投稿功能整体删除，门户会话现在只能由 public-subscriptions.ts 的验证码/卡密流程下发。
 * 这里把「签发验证码 → 登录 → 取 Cookie」收成一处，避免各测试文件各写一份。
 */
import type { AppDatabase } from "@emby-task-center/database/client";
import { issueVerificationCode } from "../subscriptions/verification";

export async function loginAsMember(baseUrl: string, database: AppDatabase, email: string): Promise<string> {
  const code = issueVerificationCode(database, email);
  const response = await fetch(`${baseUrl}/api/public/subscriptions/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, code }),
  });
  if (response.status !== 200) {
    throw new Error(`member login failed: ${response.status} ${await response.text()}`);
  }
  return (response.headers.get("set-cookie") ?? "").split(";")[0];
}

/** 管理端创建会员后立刻用验证码登录（会员必须先存在，否则 /login 返回 not_member）。 */
export async function loginAsMemberAfterAdminCreate(
  baseUrl: string,
  database: AppDatabase,
  adminCookie: string,
  email: string,
): Promise<string> {
  await fetch(`${baseUrl}/api/submission-users`, {
    method: "POST",
    headers: { cookie: adminCookie, "content-type": "application/json" },
    body: JSON.stringify({ email }),
  });
  return loginAsMember(baseUrl, database, email);
}
