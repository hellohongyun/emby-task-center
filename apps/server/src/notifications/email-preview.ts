import type { EmailScene } from "@emby-task-center/contracts/email-scenes";
import type { AppDatabase } from "@emby-task-center/database/client";
import { buildEmbyWelcomeEmail } from "../subscriptions/member-notices";
import { buildRenewalReceipt } from "../subscriptions/renewal-receipt";
import { buildMembershipEmail } from "../subscriptions/send-notifications";
import { buildSmtpTestEmail, buildVerificationEmail, type RenderedEmail } from "./email-template";

const exampleEmail = "member@example.invalid";
const examplePortal = "https://cinema.example.invalid/";

export function buildEmailPreview(database: AppDatabase, scene: EmailScene): RenderedEmail {
  switch (scene) {
    case "test":
      return buildSmtpTestEmail();
    case "login":
    case "registration":
      return buildVerificationEmail("123456", scene === "login", true);
    case "welcome":
      return buildEmbyWelcomeEmail(
        database,
        {
          email: exampleEmail,
          username: exampleEmail,
          password: "示例密码",
          maxStreams: null,
          serverAddress: "https://emby.example.invalid/",
          platformUrl: examplePortal,
        },
        true,
      );
    case "renewal":
      return buildRenewalReceipt(
        {
          email: exampleEmail,
          method: "管理员续期",
          previousExpiresAt: "2030-04-30T12:00:00Z",
          subscriptionExpiresAt: "2030-05-30T12:00:00Z",
        },
        examplePortal,
        true,
      );
    case "expiring":
    case "expired":
      return buildMembershipEmail({ subscriptionExpiresAt: "2030-04-30T12:00:00Z" }, scene, examplePortal, true);
  }
}
