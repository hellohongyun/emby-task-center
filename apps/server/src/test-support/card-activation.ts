import { and, eq } from "drizzle-orm";
import type { AppDatabase } from "@emby-task-center/database/client";
import { verificationCodes } from "@emby-task-center/database/schema";
import { getSubmissionUserByEmail } from "../subscriptions/membership";
import { issueVerificationCode } from "../subscriptions/verification";

export function postSubscription(baseUrl: string, path: string, body: unknown) {
  return fetch(`${baseUrl}/api/public/subscriptions/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

export async function activateCardForTest(baseUrl: string, database: AppDatabase, email: string, cardCode: string) {
  if (getSubmissionUserByEmail(database, email)) {
    const code = issueVerificationCode(database, email);
    return postSubscription(baseUrl, "activate", { email, cardCode, code });
  }
  const sent = await postSubscription(baseUrl, "code", { email, cardCode });
  if (!sent.ok) return sent;
  const issued = database
    .select({ code: verificationCodes.code })
    .from(verificationCodes)
    .where(and(eq(verificationCodes.email, email), eq(verificationCodes.consumed, false)))
    .get();
  if (!issued) throw new Error("Registration did not issue a verification code");
  const verified = await postSubscription(baseUrl, "register/verify", { email, cardCode, code: issued.code });
  if (!verified.ok) return verified;
  const { registrationToken } = (await verified.json()) as { registrationToken: string };
  return postSubscription(baseUrl, "activate", { email, cardCode, registrationToken });
}
