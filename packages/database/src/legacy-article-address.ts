import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";

import type { AppDatabase } from "./client";

// 仅识别曾由旧版本写入的默认地址，不将私人部署域名保留为公开默认值。
const legacyAddressLength = 25;
const legacyAddressHash = "e4499fb9feca7fe54f39e86c1fac63fd5d69233ad04dfea31469268c3fb8182b";
const addressToken = "{{embyServerAddress}}";

/** 精确识别旧地址前缀；保留其后路径以及管理员设置的其他地址。 */
export function replaceArticleAddressMatchingHash(content: string, length: number, hash: string): string {
  let result = content;
  for (const match of content.matchAll(/https:\/\//g)) {
    const candidate = content.slice(match.index, match.index + length);
    if (createHash("sha256").update(candidate).digest("hex") === hash) {
      result = result.replaceAll(candidate, addressToken);
    }
  }
  return result;
}

export function reconcileLegacyArticleAddresses(database: AppDatabase, updatedAt: string): void {
  const articles = database.all<{ id: number; content: string }>(
    sql`SELECT id, content FROM content_articles WHERE content LIKE '%https://%'`,
  );
  for (const article of articles) {
    const content = replaceArticleAddressMatchingHash(article.content, legacyAddressLength, legacyAddressHash);
    if (content === article.content) continue;
    database.run(
      sql`UPDATE content_articles SET content = ${content}, updated_at = ${updatedAt} WHERE id = ${article.id}`,
    );
  }
}
