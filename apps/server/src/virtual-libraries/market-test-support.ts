import { eq } from "drizzle-orm";
import type { AppDatabase } from "@emby-task-center/database/client";
import { submissionUsers } from "@emby-task-center/database/schema";
import { createPrivateIdentityStore } from "./private-identity-store";
import { createPrivateTokenIdentity } from "./private-token-identity";
import { createVirtualLibraryMarketService } from "./market-service";

/** Test fixture only: models a successful upstream login and explicit market enablement. */
export function seedMarketViewer(
  database: AppDatabase,
  upstream: string,
  userId: string,
  token: string,
  libraryIds: string[],
) {
  const email = `fixture-${encodeURIComponent(userId)}@example.invalid`;
  const now = new Date().toISOString();
  let member = database.select().from(submissionUsers).where(eq(submissionUsers.embyUserId, userId)).get();
  if (!member)
    member = database
      .insert(submissionUsers)
      .values({ email, embyUserId: userId, createdAt: now, updatedAt: now })
      .returning()
      .get();
  const market = createVirtualLibraryMarketService(database);
  for (const id of libraryIds) {
    market.publication({ adminId: "primary-admin" }, id, true);
    market.subscribe(`member:${member.id}`, id, true);
  }
  createPrivateTokenIdentity(createPrivateIdentityStore(database)).observe(upstream, {
    AccessToken: token,
    User: { Id: userId },
  });
  return member.id;
}
