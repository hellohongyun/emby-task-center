type Account = { id: number; email: string };
type ExpiryAccount = Account & { expiresAt: string };
type InactivityAccount = Account & { lastPlayedAt: string | null; createdAt: string };

export const cleanupBlockLabels = {
  administrator: "Emby 管理员受保护",
  role_unverified: "Emby 账号身份待核对",
  linked_elsewhere: "Emby 账号同时绑定其他会员",
  cleanup_in_progress: "已有删除请求待核对",
  activity_unverified: "播放记录待核对",
};

export type CleanupPreview = {
  previewToken: string;
  days: number;
  candidates: ((ExpiryAccount & { linked: boolean }) | InactivityAccount)[];
  blocked: (Account & { reason: keyof typeof cleanupBlockLabels })[];
};

export const memberCleanupSettings = {
  expiry: {
    endpoint: "/api/member-expiry-cleanup",
    defaultDays: "",
    title: "过期账号自动删除",
    scope: "过期满设定天数后，删除会员记录和已绑定的 Emby 账号。历史过期会员和未绑定 Emby 的会员也纳入。",
    protection: "有冻结时长、长期跟随网盘到期的会员及 Emby 管理员受保护。",
    rule: "过期满",
    field: "过期天数",
    confirmation: "我确认永久删除符合规则的会员和关联 Emby 账号，范围包括历史过期会员。",
  },
  inactivity: {
    endpoint: "/api/member-inactivity-cleanup",
    defaultDays: 15,
    title: "保号设置",
    scope: "按最近一次播放时间计算未播放天数。新会员从创建时开始计时，登录不会重置天数。",
    protection: "只检查已绑定 Emby 的会员，Emby 管理员受保护。仍在有效期内的会员也纳入清理。",
    rule: "未播放满",
    field: "未播放天数",
    confirmation: "我确认永久删除符合规则的会员和关联 Emby 账号，范围包括仍在有效期内的会员。",
  },
};

export type MemberCleanupMode = keyof typeof memberCleanupSettings;

export function cleanupCandidateDetail(account: CleanupPreview["candidates"][number]) {
  if ("expiresAt" in account) {
    return `${formatDate(account.expiresAt)} 到期 · ${account.linked ? "关联 Emby" : "仅会员记录"}`;
  }
  return account.lastPlayedAt
    ? `最近播放 · ${formatDate(account.lastPlayedAt)}`
    : `未查到播放记录 · 创建于 ${formatDate(account.createdAt)}`;
}

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString("zh-CN", { dateStyle: "medium", timeStyle: "short" });
}
