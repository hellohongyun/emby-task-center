import { useAuthenticatedRequest } from "./authenticated-request";

export const share115StatusLabels = {
  queued: "排队中",
  running: "转存中",
  saved: "已保存",
  already_exists: "已存在",
  failed: "失败",
  unconfirmed: "结果待确认",
};

export type Share115Status = keyof typeof share115StatusLabels;

export interface Share115Item {
  id: number;
  jobId: number;
  memberId?: number | null;
  memberEmail?: string | null;
  adminUsername?: string | null;
  note: string;
  submittedAt: string;
  shareUrl: string;
  shareCode: string;
  accessCode: string;
  status: Share115Status;
  startedAt?: string | null;
  finishedAt?: string | null;
  targetFolderId?: string | null;
  resultCode?: string | null;
  resultMessage?: string | null;
  shareTitle?: string | null;
  identifiedMedia?: Array<{ title: string } | string> | null;
}

export interface Share115Page {
  items: Share115Item[];
  total: number;
  page: number;
  pageSize: number;
  accepting: boolean;
}

export interface Share115RejectedLink {
  index: number;
  error: string;
  retryText: string;
}

interface Share115SubmitResponse {
  item?: Share115Item;
  items?: Share115Item[];
  rejected?: Share115RejectedLink[];
}

const messages: Record<string, string> = {
  unauthorized: "登录已失效，请重新登录。",
  membership_expired: "会员已过期，请先续期。",
  member_frozen: "账号被冻结，请先处理冻结状态。",
  member_disabled: "会员已停用。",
  not_member: "会员不存在，请重新登录。",
  invalid_request: "请检查分享文案、访问码和说明的格式。",
  invalid_share_link: "请粘贴有效的 115 分享链接。",
  too_many_share_links: "一次最多提交 10 条 115 分享链接，请分批提交。",
  access_code_requires_single_link: "手动访问码仅用于单条链接。批量提交时请把各自的访问码写在链接中或紧跟链接。",
  invalid_access_code: "访问码须为 4 位字母或数字。",
  conflicting_access_code: "这条链接的访问码有冲突，请核对后再提交。",
  rate_limited: "提交过于频繁，请稍后再试。",
  queue_full: "转存队列已满，请稍后再试。",
  share_115_unavailable: "当前暂不可提交转存，请稍后再试。",
  share_115_not_unconfirmed: "任务状态已更新，请刷新记录。",
};

export function share115ErrorMessage(error: string) {
  return messages[error] ?? "这条链接未提交，请稍后重试。";
}

export function useShare115Api(admin = false, requireAuth?: () => void) {
  const path = admin ? "/api/115-shares" : "/api/public/115-shares";
  const reader = useAuthenticatedRequest(messages, admin, requireAuth);
  const writer = useAuthenticatedRequest(messages, admin, requireAuth);
  return {
    reader,
    writer,
    list(params: URLSearchParams) {
      return reader.run<Share115Page>("list", `${path}?${params}`);
    },
    submit(body: { shareText: string; accessCode?: string; note?: string }) {
      return writer.run<Share115SubmitResponse>("write", path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    },
    resolve(jobId: number, status: "saved" | "failed") {
      return writer.run<{ ok: true }>("write", `${path}/jobs/${jobId}/resolve`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
    },
  };
}
