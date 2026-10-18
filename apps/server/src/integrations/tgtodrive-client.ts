/**
 * TgtoDrive 管理台 HTTP 客户端。
 *
 * 新版架构里 emby-task-center 只负责跟踪/提醒，实际的搜索、转存、整理、STRM
 * 都由 TgtoDrive 完成。当投稿命中/转存完成后，本客户端用于：
 *  - 触发某来源的网盘整理（/api/organize-history/run）
 *  - 触发某来源的 STRM 全量同步（/api/strm-sync/run）
 *  - （可选）TMDB 识别确认（/api/tmdb-regex-rules/search-tmdb）
 *
 * 登录使用管理台账号密码（ENV_WEB_PASSPORT / ENV_WEB_PASSWORD），拿到会话 Cookie
 * 后走后续 API。凭据只从环境变量读取，绝不写入代码/仓库。
 */

export type TgtoDriveSource = "123云盘" | "光鸭云盘" | "115网盘" | "115网盘分享";

export type NetdiskProviderKey = "115" | "123" | "guangya" | "magnet";

/** TgtoDrive `/api/media/resources/search` 原始条目（API 实际返回 snake_case）。 */
interface TgtoDriveRawItem {
  title?: string;
  size?: string;
  link_type?: string;
  provider?: string;
  share_url?: string;
  resource_url?: string;
  /** 注意：API 返回的是逗号连接的字符串（如 "115,123,guangya"），少数情况为数组。 */
  supported_targets?: string | string[];
  item_key?: string;
  quality?: string;
  subtitle_languages?: string[];
  resolution?: string;
  source?: string;
  technical_tags?: string[];
  resource_specs?: Record<string, unknown>;
  published_at?: string;
}

export interface TgtoDriveResourceHit {
  title: string;
  size: string;
  linkType: "magnet" | "share" | string;
  provider: string;
  shareUrl?: string;
  resourceUrl?: string;
  supportedTargets?: string[];
  itemKey?: string;
  quality?: string;
  subtitleLanguages?: string[];
}

/** supported_targets 可能是 "115,123,guangya" 字符串或数组，统一成数组。 */
function toTargets(value: string | string[] | undefined): string[] {
  if (Array.isArray(value)) return value.filter(Boolean);
  if (typeof value !== "string" || !value.trim()) return [];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/** 把 API 的 snake_case 条目规范化成内部 camelCase 结构。 */
function normalizeItem(raw: TgtoDriveRawItem): TgtoDriveResourceHit {
  return {
    title: raw.title ?? "",
    size: raw.size ?? "",
    linkType: raw.link_type ?? "",
    provider: raw.provider ?? "",
    shareUrl: raw.share_url ?? undefined,
    resourceUrl: raw.resource_url ?? undefined,
    supportedTargets: toTargets(raw.supported_targets),
    itemKey: raw.item_key ?? undefined,
    quality: raw.quality ?? undefined,
    subtitleLanguages: raw.subtitle_languages ?? [],
  };
}

export interface TgtoDriveClient {
  /** 是否已配置（有 baseUrl + 账号密码）。 */
  configured: boolean;
  /** TMDB 识别：确认投稿片名对应的 TMDB 条目（安全只读）。 */
  searchTmdb(query: string, type?: "movie" | "tv"): Promise<unknown[]>;
  /** 触发某来源整理或 STRM 同步。 */
  trigger(kind: "organize" | "strm-sync", source: TgtoDriveSource): Promise<{ ok: boolean; message?: string }>;
  /** 影视发现-资源检索：返回磁力/网盘资源及其真实大小/完整链接。 */
  searchResources(input: {
    title: string;
    tmdbId?: number | null;
    mediaType?: "movie" | "tv";
    year?: number | string | null;
    aliases?: string[];
    sources?: string[];
  }): Promise<TgtoDriveResourceHit[]>;
}

export interface TgtoDriveClientOptions {
  baseUrl: string;
  username: string;
  password: string;
  timeoutMs?: number;
}

interface ApiEnvelope {
  success?: boolean;
  message?: string;
  error?: string;
  data?: unknown;
  results?: unknown[];
  [key: string]: unknown;
}

export function createTgtoDriveClient(options: TgtoDriveClientOptions): TgtoDriveClient {
  const base = options.baseUrl.replace(/\/+$/, "");
  const timeoutMs = options.timeoutMs ?? 15_000;
  let cookie: string | null = null;
  let loginPromise: Promise<void> | null = null;

  async function login(): Promise<void> {
    const response = await fetch(`${base}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: options.username, password: options.password }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const data = (await response.json().catch(() => ({}))) as ApiEnvelope;
    if (!response.ok || !data || data.success !== true) {
      throw new Error(`tgtodrive_login_failed: ${data?.error ?? data?.message ?? `http_${response.status}`}`);
    }
    const setCookies = response.headers.getSetCookie
      ? response.headers.getSetCookie()
      : response.headers.get("set-cookie")
        ? [response.headers.get("set-cookie")!]
        : [];
    if (!setCookies.length) throw new Error("tgtodrive_login_no_cookie");
    // 登录响应会同时下发 acw_tc / cdn_sec_tc / session 等；全部带上，后续请求才能通过鉴权。
    cookie = setCookies
      .map((entry) => entry.split(";")[0]?.trim())
      .filter(Boolean)
      .join("; ");
    if (!cookie) throw new Error("tgtodrive_login_no_cookie");
  }

  async function ensureLogin(): Promise<void> {
    if (cookie) return;
    if (!loginPromise) {
      loginPromise = login().finally(() => {
        loginPromise = null;
      });
    }
    await loginPromise;
  }

  async function requestJson(method: "GET" | "POST", path: string, body?: unknown): Promise<ApiEnvelope> {
    await ensureLogin();
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const data = (await response.json().catch(() => ({}))) as ApiEnvelope;
    if (!response.ok || data.success === false) {
      throw new Error(
        `tgtodrive_api_${path.slice(1).replaceAll("/", "_")}_failed: ${data?.error ?? data?.message ?? `http_${response.status}`}`,
      );
    }
    return data;
  }

  return {
    configured: true,
    async searchTmdb(query, type = "tv") {
      const url = `/api/tmdb-regex-rules/search-tmdb?query=${encodeURIComponent(query)}&type=${encodeURIComponent(type)}`;
      const data = await requestJson("GET", url);
      return Array.isArray(data.results) ? data.results : [];
    },
    async trigger(kind, source) {
      const path = kind === "organize" ? "/api/organize-history/run" : "/api/strm-sync/run";
      const data = await requestJson("POST", path, { source });
      return { ok: true, message: typeof data.message === "string" ? data.message : "" };
    },
    async searchResources(input) {
      const data = await requestJson("POST", "/api/media/resources/search", {
        title: input.title,
        aliases: (input.aliases ?? []).slice(0, 2),
        tmdb_id: input.tmdbId ?? null,
        media_type: input.mediaType === "tv" ? "tv" : "movie",
        year: String(input.year ?? ""),
        sources: input.sources ?? ["guanying", "seedhub", "tg", "butailing"],
      });
      // API 返回 snake_case 原始条目，必须先规范化；直接当 camelCase 读会全是 undefined。
      const items = Array.isArray((data.data as { items?: unknown[] } | undefined)?.items)
        ? (data.data as { items?: TgtoDriveRawItem[] }).items!
        : [];
      return items.filter((item): item is TgtoDriveRawItem => Boolean(item && item.title)).map(normalizeItem);
    },
  };
}

export interface TgtoDriveConfig {
  baseUrl: string;
  username: string;
  password: string;
}

/** 由设置值构造；缺少 baseUrl/账号密码时返回 undefined（未启用）。 */
export function createTgtoDriveClientFromConfig(config: TgtoDriveConfig): TgtoDriveClient | undefined {
  if (!config.baseUrl || !config.username || !config.password) return undefined;
  return createTgtoDriveClient({ baseUrl: config.baseUrl, username: config.username, password: config.password });
}
