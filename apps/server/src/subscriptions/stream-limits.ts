import { eq } from "drizzle-orm";

import type { AppDatabase } from "@emby-task-center/database/client";
import { concurrencyEscalationState, submissionUsers } from "@emby-task-center/database/schema";
import type { EmbyClient } from "../integrations/emby-client";

/** 未登记会员的 Emby 账号，默认允许的同时播放路数（0 = 不限）。 */
export const DEFAULT_STREAM_LIMIT = 1;
/** Emby 用户列表（含是否管理员）的缓存时长：看门狗每秒检查时都要判定管理员，不能实时打 Emby。 */
const ADMIN_CACHE_MS = 60_000;

/**
 * 并发上限的解析器：决定"某个 Emby 账号允许同时播几路"。
 *
 * 规则（2026-09 用户确认）：
 *  - **Emby 管理员账号不限**（他自己的账号要能多设备/给自动化用）；
 *  - 「会员与运营」里登记了并发上限的会员，用登记值；
 *  - 其余账号一律按 {@link DEFAULT_STREAM_LIMIT}（默认 1 路）。
 *
 * 管理员判定需要 Emby 的用户列表，看门狗每隔几秒就会问一次，所以这里带 60s 缓存；
 * 查不到用户列表时按"不是管理员"处理（宁可管严格，也不放过超限）。
 */
export class StreamLimitResolver {
  private adminIds: Set<string> | null = null;
  private adminFetchedAt = 0;
  private connectionKey: string | undefined;

  constructor(
    private database: AppDatabase,
    private emby: EmbyClient | undefined,
    private defaultLimit: number = DEFAULT_STREAM_LIMIT,
  ) {}

  /** Keep the administrator cache between ticks, but discard it when the server changes. */
  configure(defaultLimit: number, connectionKey: string): void {
    this.defaultLimit = defaultLimit;
    if (this.connectionKey !== connectionKey) {
      this.connectionKey = connectionKey;
      this.adminIds = null;
      this.adminFetchedAt = 0;
    }
  }

  /** 解析上限：返回 null 表示不限。 */
  async limitFor(embyUserId: string): Promise<number | null> {
    // 管理员**先判**：他自己的账号要能多设备、要给自动化用，即便被登记成了会员也不受限。
    if (await this.isAdministrator(embyUserId)) return null;
    const member = this.database.select().from(submissionUsers).where(eq(submissionUsers.embyUserId, embyUserId)).get();
    if (member?.embyMaxStreams != null && member.embyMaxStreams > 0) return member.embyMaxStreams;
    return this.defaultLimit > 0 ? this.defaultLimit : null;
  }

  /**
   * 该 Emby 账号是否正处于"超限冻结"中（冻结周期内）。
   *
   * 冻结期间**一路都不许**：Emby 不会因为账号停用而中断已登录设备的播放，所以看门狗
   * 要把冻结会员的每一个会话都掐掉，直到冻结到期（到期由升级任务恢复账号）。
   */
  isFrozen(embyUserId: string): boolean {
    const member = this.database.select().from(submissionUsers).where(eq(submissionUsers.embyUserId, embyUserId)).get();
    if (!member) return false;
    const state = this.database
      .select()
      .from(concurrencyEscalationState)
      .where(eq(concurrencyEscalationState.memberId, member.id))
      .get();
    const until = state?.disabledUntil ? Date.parse(state.disabledUntil) : null;
    return until != null && !Number.isNaN(until) && until > Date.now();
  }

  /** 该 Emby 账号是不是管理员：管理员不受并发限制，也不进超限冻结流程。 */
  async isAdministrator(embyUserId: string): Promise<boolean> {
    const now = Date.now();
    if (!this.adminIds || now - this.adminFetchedAt > ADMIN_CACHE_MS) {
      try {
        const users = (await this.emby?.listUsers?.()) ?? [];
        this.adminIds = new Set(users.filter((user) => user.Policy?.IsAdministrator).map((user) => user.Id));
        this.adminFetchedAt = now;
      } catch {
        // 拉不到就先按"没有管理员信息"处理，下一次请求再试。
        return false;
      }
    }
    return this.adminIds.has(embyUserId);
  }
}
