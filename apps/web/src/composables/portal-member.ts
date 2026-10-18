import type { ConcurrencyMemberStatus } from "../types";

/**
 * 门户（公开站）会员会话状态：模块级单例，首页/影视库/「我的」共享同一份登录态，
 * 避免切页后状态丢失。
 *
 * 历史上的 useSubmissions 还持有投稿清单、投稿提交、额度排序与投稿缓冲天数；投稿功能与
 * 额度台账都删除后，这里只剩「会话 + 会员摘要」。
 */
export interface PortalMember {
  email: string;
  status: string;
  contentAccess?: boolean;
  subscriptionExpiresAt: string | null;
  /**
   * 当前这份有效期的「到期时间名称」（由带到期时间名称的自定义卡密写入）。
   *
   * 用户侧所有页面都以它为主口径，为空才回落真实日期——见 docs/card-keys.md。
   * 管理员侧不读这个字段（要看真日期核对）。
   */
  membershipExpiryLabel?: string | null;
  embyUsername: string | null;
  embyUserId: string | null;
  embyMaxStreams?: number | null;
  /** 并发超限处置状态（是否超限中/已冻结、解冻时间）。 */
  concurrency?: ConcurrencyMemberStatus | null;
  /** 自助解冻状态：能不能自己解冻、弹窗文案（后台可改）、本月还剩几次。 */
  unfreeze?: MemberUnfreezeStatus | null;
}

/**
 * 会员自助解冻状态（服务端下发）。
 *
 * 文案与等待秒数都由后端给：后台改完文案立即生效，前端不写死任何一句提示语。
 */
export interface MemberUnfreezeStatus {
  /** 现在能不能自助解冻（冻结中 + 后台开关打开 + 本月还有次数）。 */
  enabled: boolean;
  frozen: boolean;
  /** 不能自助解冻的原因：not_frozen / unfreeze_disabled / limit_reached / not_member。 */
  reason: string | null;
  disabledUntil: string | null;
  waitSeconds: number;
  monthlyLimit: number;
  usedThisMonth: number;
  /** 本月**当前**还剩几次（不扣本次）：横幅「本月还可自助解冻 N 次」用它。 */
  remainingChances: number;
  /** 若这一次解冻成功，之后本月还剩几次：只用于「本次解冻后还剩」的文案。 */
  remainingAfterThis: number;
  /** 已经点开过弹窗的时刻：刷新页面后倒计时接着走。 */
  requestedAt: string | null;
  /** 倒计时结束时刻。 */
  readyAt: string | null;
  title: string;
  notice: string;
}

export interface ActivatedEmby {
  embyUsername: string;
  password: string;
  serverAddress: string;
  /**
   * 「我的」页那块开通提示的标题与正文。
   *
   * 整块文案由服务端按后台模板（系统设置 →「会员」）渲染好再下发：前端只展示、不拼句子，
   * 所以管理员改文案不需要改前端，也不会出现"邮件改了、页面还是旧话术"的偏差。
   */
  onboardTitle?: string;
  onboardNotice?: string;
}

/** 登录页「下一步」的分流结果（`/entry`）：决定进登录还是进注册页。 */
export interface EntryCheck {
  /** 注册过没有（过期也算注册过——他照样要能登录）。 */
  registered: boolean;
  /** 没注册过 → true：必须走注册页，凭卡密。 */
  needsCard: boolean;
  expired: boolean;
}

/**
 * 卡密预检成功后的卡密信息（名称 / 到期口径 / 彩蛋文案都由服务端算好）。
 *
 * 前端不自己拼"到期时间"这句话：名称优先还是日期优先、小字要不要显示，
 * 都属于后台可改的口径，写死在前端就会出现"后台改了、页面还是旧话术"。
 */
export interface CardCheckInfo {
  kind: string;
  label: string;
  days: number;
  idempotent: boolean;
  /** 卡密名称（管理员 DIY）；没起名字时服务端已回落成类型标签。 */
  name: string;
  /** 固定到期日（ISO）；null 表示"兑换后 N 天"的相对卡。 */
  expiresAt: string | null;
  /** 管理员写的到期时间名称；有值时用户侧优先显示它。 */
  expiryLabel: string | null;
  /** 到期主文案（名称优先）。 */
  expiryText: string;
  /** 真实到期日小字（`YYYY-MM-DD`）；相对卡为 null。 */
  expiryDetail: string | null;
  /** 剩余天数；相对卡为 null。 */
  expiryDays: number | null;
  /** 彩蛋祝福文案；为空表示这张卡不弹窗。 */
  blessing: string | null;
}

/** 卡密预检结果（`/card/check`）：只校验不消耗卡密。 */
export interface CardCheck {
  ok: true;
  /** 该邮箱是否已注册（注册过的不需要卡密）。 */
  registered: boolean;
  /** 是否必须凭卡密（= 从没注册过）。 */
  needsCard: boolean;
  expired: boolean;
  /** 真的是去验了卡密才有值；没给卡密（注册过的）时为 null。 */
  card: CardCheckInfo | null;
}

/** 发码结果：告诉调用方下一步该走 activate（凭卡密开通）还是 login（直接登录）。 */
export interface SendCodeResult {
  registered: boolean;
  needsCard: boolean;
  expired: boolean;
}

export function friendlyError(code?: string): string {
  switch (code) {
    case "membership_expired":
      return "会员已过期，请在我的页面续费后浏览内容。";
    case "member_frozen":
      return "账号已冻结，请在我的页面查看解冻方式；续费不会解除冻结。";
    case "member_disabled":
      return "账号已被管理员停用，请联系管理员。";
    case "unauthorized":
      return "登录已失效，请重新登录。";
    case "not_authorized":
      return "该邮箱未开通会员，请联系管理员。";
    case "not_member":
      return "该邮箱尚未开通会员，请使用卡密开通。";
    case "rate_limited":
    case "rate_limited_email":
      return "操作过于频繁，请稍后再试。";
    case "invalid_code":
      return "验证码不正确或已过期。";
    case "too_many_attempts":
      return "验证码尝试次数过多，请重新获取。";
    case "invalid_card":
      return "卡密无效，请检查是否输错。";
    case "card_used":
      return "该卡密已被使用（同一张卡不能给两个账号兑换）。";
    case "card_expired":
      return "这张卡密已经过了它的到期时间，无法再兑换，请联系发卡人。";
    case "card_required":
      return "请先验证卡密，通过后再获取验证码。";
    case "card_mismatch":
      return "卡密与发送验证码时验证的不一致，请重新验证卡密。";
    case "email_send_failed":
      return "验证码发送失败，请稍后再试。";
    case "invalid_request":
      return "提交内容无效，请检查后重试。";
    case "not_frozen":
      return "账号当前没有被冻结，无需解冻。";
    case "unfreeze_disabled":
      return "自助解冻已关闭，请等待到期自动恢复或联系管理员。";
    case "limit_reached":
      return "本月自助解冻次数已用完，请等待到期自动恢复或联系管理员。";
    case "not_requested":
      return "请重新打开解冻提示并等待倒计时结束。";
    case "wait_not_elapsed":
      return "请等待倒计时结束再点确认。";
    case "release_failed":
      return "解冻没有生效（Emby 暂时没响应），请稍后重试；本次不消耗次数。";
    default:
      return code ?? "请求失败";
  }
}

/**
 * 用户侧**唯一**的到期时间渲染口径（首页顶栏 / 「我的」有效期 / 登录页提示 / 邀约弹窗共用）。
 *
 * 规则：管理员的「到期时间名称」优先（"2027 年春节结束到期"），没写名称才回落到真实日期。
 * 为什么要在这里收口：一旦某个页面自己 `new Date(...)` 拼日期，用自定义卡密的会员就会
 * 在那一页看到日期、在别的页看到名称，用户会以为是两套数据。
 */
export function formatMemberExpiry(label: string | null | undefined, expiresAt: string | null): string {
  const named = label?.trim();
  if (named) return named;
  if (!expiresAt) return "长期有效";
  const date = new Date(expiresAt);
  if (Number.isNaN(date.getTime())) return "长期有效";
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 有自定义名称时，顺带给出的真实日期小字（没有名称就没有小字，避免重复显示同一个日期）。 */
export function memberExpiryDetail(label: string | null | undefined, expiresAt: string | null): string | null {
  if (!label?.trim() || !expiresAt) return null;
  const date = new Date(expiresAt);
  if (Number.isNaN(date.getTime())) return null;
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
