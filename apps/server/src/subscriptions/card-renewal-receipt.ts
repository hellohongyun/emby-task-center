import { eq } from "drizzle-orm";
import type { AppDatabase } from "@emby-task-center/database/client";
import { cardKeys } from "@emby-task-center/database/schema";
import { CARD_KIND_LABEL, type RedeemResult } from "./cards";
import { enqueueRenewalReceipt } from "./renewal-outbox";

export function queueCardRenewalReceipt(
  database: AppDatabase,
  card: RedeemResult,
  user: { email: string; subscriptionExpiresAt: string | null },
  expiry: string | null,
  label: string | null,
  showDuration = true,
): string {
  const stored = database.select({ id: cardKeys.id }).from(cardKeys).where(eq(cardKeys.code, card.code)).get();
  if (!stored) throw new Error("redeemed_card_missing");
  const key = `card:${stored.id}`;
  enqueueRenewalReceipt(database, key, {
    email: user.email,
    previousExpiresAt: user.subscriptionExpiresAt,
    subscriptionExpiresAt: expiry,
    expiryLabel: label,
    method: `卡密续期：${CARD_KIND_LABEL[card.kind]}${showDuration ? (card.expiresAt ? "（固定到期日）" : `（增加 ${card.days} 天）`) : ""}`,
  });
  return key;
}
