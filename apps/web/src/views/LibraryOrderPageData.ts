export interface Library {
  id: string;
  name: string;
  kind: "native" | "virtual" | "proxy" | "owned" | "unknown";
  visibleUsers: number;
  inOrderedViews: boolean;
  /** 是否可直接写入 Emby 的 OrderedViews；反代上游注入的库为 false。 */
  direct: boolean;
  /** 是否出现在客户端实际访问的反代目录中。 */
  proxy?: boolean;
}

export interface ProxyStatus {
  configured: boolean;
  enabled: boolean;
  running: boolean;
  port: number | null;
  upstream: string | null;
}

export interface Account {
  id: string;
  name: string;
  isAdministrator: boolean;
  isDisabled: boolean;
}

export interface Catalog {
  libraries: Library[];
  order: string[];
  savedOrder: string[];
  saved: boolean;
  active: boolean;
  activeOrder: string[];
  updatedAt: string | null;
  users: Account[];
  warnings: string[];
  proxy: ProxyStatus;
}

export interface PreviewRow extends Account {
  status: "change" | "unchanged" | "skipped" | "failed";
  before: string[];
  after: string[];
  proxyBefore?: string[];
  proxyAfter?: string[];
  proxyReason?: string;
  reason?: string;
}

export interface Preview {
  previewToken: string;
  libraries: string[];
  users: PreviewRow[];
  warnings: string[];
  proxyChanged: boolean;
  proxyConfigured: boolean;
  proxyEnabled: boolean;
  proxyRunning: boolean;
}

export interface ResultRow extends Account {
  status: "updated" | "unchanged" | "skipped" | "failed";
  reason?: string;
}

export interface ApplyResult {
  users: ResultRow[];
  order: string[];
  proxyActivated: boolean;
  proxyReason?: string;
  proxyConfigured: boolean;
  proxyEnabled: boolean;
  proxyRunning: boolean;
}

export const messages: Record<string, string> = {
  library_order_not_configured: "请先在系统设置连接 Emby。",
  library_order_not_saved: "请先保存媒体库顺序。",
  library_order_unknown_user: "所选测试账号已不存在，请刷新页面。",
  library_order_unknown_library: "媒体库目录已变化，请刷新页面后重试。",
  library_order_duplicate_library: "媒体库顺序中不能有重复项。",
  library_order_preview_expired: "预览已失效，请重新生成预览。",
  library_order_order_changed: "媒体库目录或全局顺序已变化，请刷新页面后重新保存。",
  library_order_connection_changed: "Emby 连接已变更，请刷新页面后重新操作。",
  library_order_busy: "另一次同步正在执行，请稍后重试。",
  library_order_user_changed: "账号顺序已变更，请重新生成预览。",
  library_order_read_failed: "读取 Emby 媒体库失败。",
  library_order_proxy_read_failed: "读取反代上游的媒体库失败。请检查上游地址和连接后重新预览。",
  library_order_write_failed: "写入结果未确认，请重新生成预览核对。",
  library_order_verify_failed: "Emby 返回的顺序未通过核对，请重新生成预览。",
  library_order_proxy_save_failed: "反代模板启用失败，请重新生成预览。",
  library_order_proxy_disabled: "反代顺序已确认。启用本项目反代后，可通过该入口查看新顺序。",
  library_order_proxy_not_running: "反代顺序已确认。请检查本项目反代的监听状态。",
};

export const statusLabels = {
  change: "待同步",
  unchanged: "顺序一致",
  skipped: "已跳过",
  failed: "失败",
  updated: "已同步",
} as const;

export function rowMessage(reason?: string) {
  return reason ? (messages[reason] ?? "请重新生成预览核对。") : "";
}

export function proxyPreviewMessage(preview: Preview, scope: "all" | "one") {
  if (scope === "one") return "仅测试直连 Emby，反代继续使用当前设置。";
  if (!preview.proxyEnabled || !preview.proxyRunning) {
    const state = preview.proxyEnabled ? "尚未监听" : "尚未启用";
    const template = preview.proxyChanged ? "确认后会保存反代顺序" : "反代顺序已确认";
    return `${template}。本项目反代${state}。`;
  }
  return preview.proxyChanged ? "确认后，本项目反代将使用此顺序。" : "本项目反代已使用此顺序。";
}

export function proxyResultMessage(result: ApplyResult, scope: "all" | "one") {
  if (scope === "one") return "本次为直连测试。反代继续使用当前设置。";
  if (result.proxyReason) return rowMessage(result.proxyReason);
  if (!result.proxyActivated) return rowMessage("library_order_proxy_save_failed");
  if (!result.proxyEnabled) return rowMessage("library_order_proxy_disabled");
  if (!result.proxyRunning) return rowMessage("library_order_proxy_not_running");
  return "本项目反代正在使用已确认的顺序。";
}

export function accountLabel(account: Account) {
  const tags = [account.isAdministrator ? "管理员" : "", account.isDisabled ? "停用" : ""].filter(Boolean);
  return tags.length ? `${account.name}（${tags.join(" · ")}）` : account.name;
}

export function kindLabel(kind: Library["kind"]) {
  return {
    native: "Emby 原生",
    virtual: "上游虚拟库",
    proxy: "反代上游库",
    owned: "本项目虚拟库",
    unknown: "未识别",
  }[kind];
}

export function formatTime(value: string | null) {
  if (!value) return "尚未保存";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN");
}

export function sameOrder(left: string[], right: string[]) {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

export function librariesInOrder(libraries: Library[], order: string[]) {
  const byId = new Map(libraries.map((library) => [library.id, library]));
  return order.flatMap((id) => byId.get(id) ?? []);
}

export function previewOrders(row: PreviewRow) {
  const orders = [];
  if (row.status === "change" || row.status === "unchanged") {
    orders.push({ label: "直连原生 Emby", before: row.before, after: row.after });
  }
  if (row.proxyAfter) {
    orders.push({ label: "虚拟库反代（估算）", before: row.proxyBefore, after: row.proxyAfter });
  }
  return orders;
}

export function hasPreviewChanges(row: PreviewRow) {
  return row.status === "change" || (row.proxyAfter && !sameOrder(row.proxyBefore ?? [], row.proxyAfter));
}

export function previewAction(preview?: Preview) {
  const users = preview?.users ?? [];
  const changed = users.filter((row) => row.status === "change").length;
  if (changed) return { enabled: true, label: `确认同步 ${changed} 个账号` };
  if (preview?.proxyChanged) return { enabled: true, label: "确认反代顺序" };
  const problems = users.filter((row) => row.status === "failed" || row.status === "skipped").length;
  return { enabled: false, label: problems ? `${problems} 个账号需处理` : "无需同步" };
}
