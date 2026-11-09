import { z } from "zod";

export interface TgtoDriveShare115Result {
  status: "saved" | "already_exists" | "failed" | "unconfirmed";
  targetFolderId?: string;
  resultCode: string;
  resultMessage: string;
  shareTitle?: string;
  identifiedMedia?: unknown[];
}

interface Transfer115ShareOptions {
  baseUrl: string;
  token: string;
  shareUrl: string;
  signal?: AbortSignal;
}

const transferPath = "/api/media/resources/transfer";
const transferTimeoutMs = 30_000;
const bearerTokenPattern = /^[A-Za-z0-9._~+/-]+=*$/;

const envelope = z.object({
  success: z.boolean().optional(),
  code: z.string().optional(),
  data: z.unknown().optional(),
});

const completedTransfer = z.object({
  success: z.literal(true),
  provider: z.literal("115"),
  mode: z.literal("share"),
  already_owned: z.boolean().optional(),
  target: z.object({ folder_id: z.string().regex(/^\d+$/) }),
  transfer: z.object({ selected_count: z.number().int().positive() }),
  share_title: z.unknown().optional(),
});

const rejectionMessages = new Map([
  ["RESOURCE_SOURCE_UNAVAILABLE", "TgtoDrive 的资源来源不可用，请联系管理员检查配置。"],
  ["SHARE_URL_REQUIRED", "请填写 115 分享链接。"],
  ["INVALID_115_SHARE", "无法识别该 115 分享链接。"],
]);

function failure(resultCode: string, resultMessage: string): TgtoDriveShare115Result {
  return { status: "failed", resultCode, resultMessage };
}

function unconfirmed(resultCode: string): TgtoDriveShare115Result {
  return { status: "unconfirmed", resultCode, resultMessage: "未能确认 TgtoDrive 是否完成转存。" };
}

function transferUrl(baseUrl: string): string | undefined {
  if (!URL.canParse(baseUrl)) return undefined;
  const url = new URL(baseUrl);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    return undefined;
  }
  return `${url.href.replace(/\/+$/, "")}${transferPath}`;
}

export function isTgtoDriveShare115Configured(baseUrl: string, token: string): boolean {
  return bearerTokenPattern.test(token) && Boolean(transferUrl(baseUrl));
}

export async function transfer115Share(options: Transfer115ShareOptions): Promise<TgtoDriveShare115Result> {
  const url = transferUrl(options.baseUrl);
  if (!url || !bearerTokenPattern.test(options.token)) {
    return failure("TGTO_NOT_CONFIGURED", "请联系管理员检查 TgtoDrive 地址与 OpenAPI 令牌。");
  }

  const deadline = AbortSignal.timeout(transferTimeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  let response: Response;
  let body: unknown;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${options.token}`,
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        provider: "115",
        source: "guanying",
        share_url: options.shareUrl,
        enforce_points_limit: true,
        max_points: 0,
      }),
      redirect: "manual",
      signal,
    });
    body = await response.json().catch(() => undefined);
  } catch {
    return unconfirmed(deadline.aborted ? "TGTO_TIMEOUT" : "TGTO_CONNECTION_LOST");
  }

  if (signal.aborted) return unconfirmed(deadline.aborted ? "TGTO_TIMEOUT" : "TGTO_CONNECTION_LOST");
  if (response.status >= 300 && response.status < 400) return unconfirmed("TGTO_UNEXPECTED_REDIRECT");
  if (response.status === 408 || response.status >= 500) return unconfirmed("TGTO_SERVER_ERROR");

  const parsed = envelope.safeParse(body);
  if (!parsed.success) return unconfirmed("TGTO_INVALID_RESPONSE");
  const { success, code, data } = parsed.data;
  if (success === false) {
    const knownMessage = code ? rejectionMessages.get(code) : undefined;
    if (code && knownMessage) return failure(code, knownMessage);
    if (response.status === 401 || response.status === 403) {
      return failure("TGTO_ACCESS_DENIED", "TgtoDrive 拒绝访问，请联系管理员检查令牌和服务配置。");
    }
    return failure("TGTO_TRANSFER_REJECTED", "TgtoDrive 未接受转存，请检查分享链接与访问码。");
  }

  const completed = completedTransfer.safeParse(data);
  // HTTP 202 and generic success envelopes can acknowledge work without reporting its result.
  if (response.status !== 200 || success !== true || !completed.success) {
    return unconfirmed("TGTO_TRANSFER_RESULT_MISSING");
  }

  const transfer = completed.data;
  const title = z.string().trim().min(1).max(300).safeParse(transfer.share_title);
  return {
    status: transfer.already_owned ? "already_exists" : "saved",
    targetFolderId: transfer.target.folder_id,
    resultCode: transfer.already_owned ? "TGTO_ALREADY_EXISTS" : "TGTO_SAVED",
    resultMessage: transfer.already_owned ? "分享内容已存在。" : "已保存到 115 网盘。",
    ...(title.success ? { shareTitle: title.data } : {}),
  };
}
