/**
 * 短时 resourceId（token）→ 真实资源 映射。
 *
 * 前端只持有 resourceId，永远拿不到 url/password；确认入库时回传 resourceId，
 * 后端据此取回链接并发送给 TgtoDrive 机器人。token 有 TTL，过期自动清理。
 */

import { randomUUID } from "node:crypto";

import type { PansouResource } from "./pansou-filter";

export interface PansouResourceToken {
  resourceId: string;
  url: string;
  password: string;
  platformKey: PansouResource["platformKey"];
  displayType: PansouResource["displayType"];
  note: string;
  maskedNote: string;
  source: string;
  datetime: string;
  images: string[];
  isGying: boolean;
  score: number;
  quantityTags: string[];
  size?: string;
  /** 可离线平台：如 ["115","123","guangya"]；磁力为空表示该资源类型无目标。 */
  supportedTargets?: string[];
  expiresAt: number;
}

export interface PansouResourcePublicView {
  resourceId: string;
  displayType: PansouResource["displayType"];
  maskedNote: string;
  note: string;
  images: string[];
  score: number;
  qualityTags: string[];
  size?: string;
  sourceLabel: "观影" | "其他";
  datetime: string;
  supportedTargets?: string[];
}

export const RESOURCE_TOKEN_TTL_MS = 30 * 60_000;

export class ResourceTokenStore {
  private readonly ttlMs: number;
  private readonly tokens = new Map<string, PansouResourceToken>();

  constructor(ttlMs: number = RESOURCE_TOKEN_TTL_MS) {
    this.ttlMs = ttlMs;
  }

  private sweep(): void {
    const now = Date.now();
    for (const [id, token] of this.tokens) {
      if (token.expiresAt <= now) this.tokens.delete(id);
    }
  }

  private toToken(resource: PansouResource): PansouResourceToken {
    return {
      resourceId: resource.resourceId || randomUUID(),
      url: resource.url,
      password: resource.password,
      platformKey: resource.platformKey,
      displayType: resource.displayType,
      note: resource.note,
      maskedNote: resource.maskedNote,
      source: resource.source,
      datetime: resource.datetime,
      images: resource.images,
      isGying: resource.isGying,
      score: resource.score,
      quantityTags: resource.qualityTags,
      size: resource.size,
      supportedTargets: resource.supportedTargets,
      expiresAt: Date.now() + this.ttlMs,
    };
  }

  /** 为一条资源签发 resourceId。 */
  issue(resource: PansouResource): string {
    this.sweep();
    const token = this.toToken(resource);
    this.tokens.set(token.resourceId, token);
    return token.resourceId;
  }

  /** 通过 resourceId 取回完整资源（含 url/password）。 */
  resolve(resourceId: string): PansouResourceToken | null {
    this.sweep();
    const token = this.tokens.get(resourceId);
    if (!token) return null;
    if (token.expiresAt <= Date.now()) {
      this.tokens.delete(resourceId);
      return null;
    }
    return token;
  }

  /** 转为可下发给前端的脱敏视图（不含 url/password）。 */
  toPublicView(token: PansouResourceToken): PansouResourcePublicView {
    return {
      resourceId: token.resourceId,
      displayType: token.displayType,
      maskedNote: token.maskedNote,
      note: token.maskedNote,
      images: token.images,
      score: token.score,
      qualityTags: token.quantityTags,
      size: token.size,
      sourceLabel: token.isGying ? "观影" : "其他",
      datetime: token.datetime,
      supportedTargets: token.supportedTargets,
    };
  }

  clear(): void {
    this.tokens.clear();
  }

  size(): number {
    return this.tokens.size;
  }
}

export function createResourceTokenStore(ttlMs: number = RESOURCE_TOKEN_TTL_MS): ResourceTokenStore {
  return new ResourceTokenStore(ttlMs);
}
