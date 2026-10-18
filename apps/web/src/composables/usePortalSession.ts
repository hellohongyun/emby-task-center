import { computed } from "vue";
import { portalAccessError } from "./portal-access";
import {
  friendlyError,
  formatMemberExpiry,
  memberExpiryDetail,
  type PortalMember,
  type EntryCheck,
  type CardCheck,
  type SendCodeResult,
  type ActivatedEmby,
  type MemberUnfreezeStatus,
} from "./portal-member";
import {
  email,
  loggedInEmail,
  memberStatus,
  subscriptionExpiresAt,
  memberExpiryLabel,
  memberEmbyMaxStreams,
  memberConcurrency,
  memberUnfreeze,
  activatedEmby,
  explicitContentAccess,
  error,
  loading,
  request,
  resetPortalSession,
  invalidateSessionRequests,
  sessionGeneration,
  isStaleSessionError,
  applyMember,
} from "./portal-session-state";
export { resetPortalSession } from "./portal-session-state";
export { formatMemberExpiry, memberExpiryDetail } from "./portal-member";
export type {
  PortalMember,
  MemberUnfreezeStatus,
  ActivatedEmby,
  EntryCheck,
  CardCheckInfo,
  CardCheck,
  SendCodeResult,
} from "./portal-member";

export function usePortalSession() {
  /** 用 Cookie 恢复会话并刷新会员摘要（未登录返回 false，不报错）。 */
  async function loadMember(): Promise<boolean> {
    const started = sessionGeneration();
    try {
      const body = await request<{ email: string; member: PortalMember }>("/api/public/subscriptions/member");
      if (started !== sessionGeneration()) return false;
      applyMember(body.member, body.email);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 登录页「下一步」：问服务端这个邮箱该走登录还是走注册（卡密）。
   *
   * 只判断、不发信——所以登录页第一步可以只放一个邮箱输入框。
   */
  async function checkEntry(address: string): Promise<EntryCheck | null> {
    error.value = "";
    try {
      return await request<EntryCheck>("/api/public/subscriptions/entry", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: address }),
      });
    } catch (caught) {
      if (isStaleSessionError(caught)) return null;
      error.value = caught instanceof Error ? friendlyError(caught.message) : "查询失败";
      return null;
    }
  }

  /**
   * 卡密预检：在**发验证码之前**先确认卡密对不对（只校验、不消耗）。
   *
   * 注册页用它实现「先验证卡密 → 通过后『发送验证码』才可点」；发信时服务端会再验一次。
   */
  async function checkCard(address: string, cardCode?: string): Promise<CardCheck | null> {
    error.value = "";
    try {
      const trimmed = cardCode?.trim();
      return await request<CardCheck>("/api/public/subscriptions/card/check", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(trimmed ? { email: address, cardCode: trimmed } : { email: address }),
      });
    } catch (caught) {
      if (isStaleSessionError(caught)) return null;
      error.value = caught instanceof Error ? friendlyError(caught.message) : "卡密校验失败";
      return null;
    }
  }

  /**
   * 发送邮箱验证码。
   *
   * `cardCode` 必须与预检通过的是同一张：服务端发信前会再校验一次（前端禁用按钮挡不住直接
   * 打接口的人），并把卡密与这封验证码绑定，开通时提交另一张卡会被拒。
   */
  async function sendCode(address: string, cardCode?: string): Promise<SendCodeResult | null> {
    error.value = "";
    try {
      const trimmed = cardCode?.trim();
      return await request<SendCodeResult>("/api/public/subscriptions/code", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(trimmed ? { email: address, cardCode: trimmed } : { email: address }),
      });
    } catch (caught) {
      if (isStaleSessionError(caught)) return null;
      error.value = caught instanceof Error ? friendlyError(caught.message) : "发送失败";
      return null;
    }
  }

  /** 老用户：邮箱+验证码登录。 */
  async function loginWithCode(address: string, code: string): Promise<boolean> {
    invalidateSessionRequests();
    const started = sessionGeneration();
    loading.value = true;
    error.value = "";
    try {
      const body = await request<{ status: string; email: string; member: PortalMember }>(
        "/api/public/subscriptions/login",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: address, code }),
        },
      );
      if (started !== sessionGeneration()) return false;
      applyMember(body.member, body.email);
      await loadMember();
      return started === sessionGeneration();
    } catch (caught) {
      if (isStaleSessionError(caught)) return false;
      error.value = caught instanceof Error ? friendlyError(caught.message) : "登录失败";
      return false;
    } finally {
      if (started === sessionGeneration()) loading.value = false;
    }
  }

  /** 新用户：邮箱+卡密（已预检）+验证码 开通会员（并自动创建 Emby 账号）。 */
  async function activate(address: string, code: string, cardCode: string): Promise<boolean> {
    invalidateSessionRequests();
    const started = sessionGeneration();
    loading.value = true;
    error.value = "";
    try {
      const body = await request<{
        status: string;
        email: string;
        member: PortalMember;
        emby?: ActivatedEmby | null;
      }>("/api/public/subscriptions/activate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: address, code, cardCode }),
      });
      if (started !== sessionGeneration()) return false;
      applyMember(body.member, body.email);
      activatedEmby.value = body.emby ?? null;
      await loadMember();
      return started === sessionGeneration();
    } catch (caught) {
      if (isStaleSessionError(caught)) return false;
      error.value = caught instanceof Error ? friendlyError(caught.message) : "开通失败";
      return false;
    } finally {
      if (started === sessionGeneration()) loading.value = false;
    }
  }

  async function logout(): Promise<void> {
    resetPortalSession();
    await request<{ ok: boolean }>("/api/public/subscriptions/logout", { method: "POST" }).catch(() => undefined);
  }

  async function getEmbyAccount(): Promise<{ embyUserId: string | null; embyUsername: string | null } | null> {
    try {
      return await request<{ embyUserId: string | null; embyUsername: string | null }>(
        "/api/public/subscriptions/member/emby",
      );
    } catch {
      return null;
    }
  }

  /**
   * 自助解冻 · 第一步：点开弹窗。
   *
   * 服务端在这一步记下「申请时刻」并返回弹窗文案与等待秒数——倒计时以服务端返回的
   * readyAt 为准，刷新页面也不会重新计时（等待必须是真的等）。
   */
  async function ackUnfreeze(): Promise<MemberUnfreezeStatus | null> {
    error.value = "";
    try {
      const body = await request<{ ok: boolean; unfreeze: MemberUnfreezeStatus }>(
        "/api/public/subscriptions/member/unfreeze/ack",
        { method: "POST" },
      );
      memberUnfreeze.value = body.unfreeze;
      return body.unfreeze;
    } catch (caught) {
      if (isStaleSessionError(caught)) return null;
      error.value = caught instanceof Error ? friendlyError(caught.message) : "申请解冻失败";
      return null;
    }
  }

  /** 自助解冻 · 第二步：等满倒计时后确认解冻；成功后会员摘要一起刷新（横幅会消失）。 */
  async function confirmUnfreeze(): Promise<boolean> {
    error.value = "";
    try {
      const body = await request<{ ok: boolean; member: PortalMember }>("/api/public/subscriptions/member/unfreeze", {
        method: "POST",
      });
      applyMember(body.member);
      return true;
    } catch (caught) {
      if (isStaleSessionError(caught)) return false;
      error.value = caught instanceof Error ? friendlyError(caught.message) : "解冻失败";
      return false;
    }
  }

  /**
   * 用户侧统一的到期文案：管理员的到期时间名称优先，没有才回落真实日期。
   * 首页顶栏 / 「我的」有效期 / 登录页提示都读它，不允许各页面自己拼日期。
   */
  const memberExpiryText = computed(() => formatMemberExpiry(memberExpiryLabel.value, subscriptionExpiresAt.value));

  /** 自定义名称旁边的小字真实日期；没有名称时为 null（不重复显示同一个日期）。 */
  const memberExpiryNote = computed(() => memberExpiryDetail(memberExpiryLabel.value, subscriptionExpiresAt.value));

  async function changeEmbyPassword(password: string): Promise<boolean> {
    error.value = "";
    try {
      await request("/api/public/subscriptions/member/emby/password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password }),
      });
      return true;
    } catch (caught) {
      if (isStaleSessionError(caught)) return false;
      error.value = caught instanceof Error ? friendlyError(caught.message) : "修改失败";
      return false;
    }
  }

  const contentAllowed = computed(
    () =>
      Boolean(loggedInEmail.value) &&
      explicitContentAccess.value !== false &&
      memberStatus.value !== "expired" &&
      !memberConcurrency.value?.disabled &&
      !memberUnfreeze.value?.frozen &&
      !["membership_expired", "member_frozen"].includes(portalAccessError.value),
  );

  return {
    contentAllowed,
    email,
    loggedInEmail,
    memberStatus,
    subscriptionExpiresAt,
    memberExpiryLabel,
    /** 用户侧统一的到期文案：管理员的到期时间名称优先，没有才回落真实日期。 */
    memberExpiryText,
    memberExpiryNote,
    memberEmbyMaxStreams,
    memberConcurrency,
    memberUnfreeze,
    activatedEmby,
    error,
    loading,
    loadMember,
    checkEntry,
    checkCard,
    sendCode,
    loginWithCode,
    activate,
    logout,
    getEmbyAccount,
    changeEmbyPassword,
    ackUnfreeze,
    confirmUnfreeze,
  };
}
