import type { IncomingHttpHeaders } from "node:http";

export type PrivateClient = "SenPlayer" | "Yamby" | "Hills" | "VidHub" | "Emby Web" | "other";
export interface PrivateDiagnostic {
  client: PrivateClient;
  route: "login" | "views" | "home" | "folders" | "items";
  reason: string;
  status?: number;
  encoding?: string;
  bytes?: number;
  privateLibraryCount?: number;
}
export type PrivateDiagnosticReporter = (entry: PrivateDiagnostic) => void;

/** Classify a declared client; never put raw headers, paths, account IDs or tokens in logs. */
export function privateClient(headers: IncomingHttpHeaders): PrivateClient {
  const values = [
    "x-emby-authorization",
    "x-mediabrowser-authorization",
    "authorization",
    "x-emby-client",
    "user-agent",
  ]
    .flatMap((key) => headers[key] ?? [])
    .join(" ")
    .toLowerCase();
  return (
    (["SenPlayer", "Yamby", "Hills", "VidHub", "Emby Web"].find((client) => values.includes(client.toLowerCase())) as
      PrivateClient | undefined) ?? "other"
  );
}

export function privateDiscoveryRoute(url: URL): PrivateDiagnostic["route"] | undefined {
  if (/^\/Users\/[^/]+\/Views\/?$/i.test(url.pathname)) return "views";
  if (/^\/Users\/[^/]+\/(?:HomeSections|Sections\/[^/]+\/Items)\/?$/i.test(url.pathname)) return "home";
  if (/^\/Library\/MediaFolders\/?$/i.test(url.pathname)) return "folders";
  if (/^\/(?:Users\/[^/]+\/)?Items\/?$/i.test(url.pathname)) return "items";
  return undefined;
}

/** Repeated discovery requests are summarized once a minute per client/reason/route. */
export function createPrivateDiagnosticReporter(report?: PrivateDiagnosticReporter) {
  const last = new Map<string, number>();
  return (entry: PrivateDiagnostic) => {
    if (!report) return;
    if (entry.route !== "login") {
      const key = JSON.stringify([entry.client, entry.route, entry.reason, entry.status]);
      const now = Date.now();
      if (last.has(key) && now - last.get(key)! < 60_000) return;
      if (last.size >= 512) last.delete(last.keys().next().value!);
      last.set(key, now);
    }
    try {
      report(entry);
    } catch {
      /* Diagnostics must never affect authentication or streaming. */
    }
  };
}

const reasons: Record<string, string> = {
  recorded: "登录身份已记录",
  decoded: "登录响应已解析",
  non_success_response: "上游登录未成功",
  invalid_json: "登录响应无法解析",
  decoding_failed: "登录响应解压失败",
  unsupported_encoding: "登录响应压缩格式不支持",
  response_too_large: "登录响应超出解析大小限制",
  observer_error: "登录身份处理失败",
  invalid_authentication_response: "登录响应缺少账号或令牌字段",
  session_user_conflict: "登录响应中的账号标识不一致",
  persistence_error: "登录身份未能保存",
  login_proof_missing: "尚未记录或无法识别此播放器的登录凭据",
  validation_failed: "上游未通过登录凭据复核",
  invalid_identity_response: "上游账号复核响应无法识别",
  user_claim_mismatch: "请求账号与登录账号不一致",
  member_unavailable: "登录账号未唯一绑定可用会员",
  validation_unavailable: "上游账号复核失败或超时",
  private_scope_ready: "登录身份已确认，私人库范围已就绪",
  no_personal_library: "登录账号没有对应的私人库",
};
export function privateDiagnosticMessage(entry: PrivateDiagnostic) {
  return `私人库诊断［${entry.client}］：${reasons[entry.reason] ?? "登录身份未能确认"}`;
}
