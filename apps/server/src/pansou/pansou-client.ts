import { discardBody } from "../util/http";

/**
 * PanSou 聚合搜索 HTTP 客户端（后端代理）。
 *
 * 后端转发管理员配置的 PanSou 服务，前端永远不直连 PanSou。
 * PanSou 服务端会聚合多插件/多频道的搜索结果，`data.merged_by_type` 按网盘类型分组，
 * 每个元素包含分享链接 / 提取码 / 规格说明 / 来源插件 / 时间。
 */

export interface PansouRawItem {
  url: string;
  password?: string;
  note?: string;
  datetime?: string;
  source?: string;
  images?: string[];
}

export interface PansouRawData {
  total: number;
  merged_by_type: Record<string, PansouRawItem[]>;
}

export interface PansouRawResponse {
  code: number;
  message: string;
  data: PansouRawData;
}

export interface PansouSearchOptions {
  kw: string;
  src?: string;
  baseUrl?: string;
  timeoutMs?: number;
  retries?: number;
  retryDelayMs?: number;
}

export interface PansouClient {
  /** 调用 PanSou /api/search，返回原始分组结果（不经过过滤/排序）。 */
  search(kw: string): Promise<PansouRawResponse>;
}

export const DEFAULT_PANSOU_BASE_URL = "";
export const DEFAULT_PANSOU_SEARCH_SRC = "plugin";
export const DEFAULT_PANSOU_TIMEOUT_MS = 30_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createPansouClient(
  options: {
    baseUrl?: string;
    src?: string;
    timeoutMs?: number;
    retries?: number;
    retryDelayMs?: number;
  } = {},
): PansouClient {
  const baseUrl = (options.baseUrl ?? DEFAULT_PANSOU_BASE_URL).replace(/\/+$/, "");
  const src = options.src ?? DEFAULT_PANSOU_SEARCH_SRC;
  const timeoutMs = options.timeoutMs ?? DEFAULT_PANSOU_TIMEOUT_MS;
  const retries = options.retries ?? 2;
  const retryDelayMs = options.retryDelayMs ?? 800;

  async function searchOnce(kw: string): Promise<PansouRawResponse> {
    const url = `${baseUrl}/api/search?kw=${encodeURIComponent(kw)}&src=${encodeURIComponent(src)}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) {
      discardBody(response);
      throw new Error(`pansou_http_${response.status}`);
    }
    const data = (await response.json()) as PansouRawResponse;
    if (!data || data.code !== 0 || !data.data) throw new Error(`pansou_api_failed: ${data?.message ?? "unknown"}`);
    return data;
  }

  return {
    async search(kw: string): Promise<PansouRawResponse> {
      if (!baseUrl.trim()) throw new Error("pansou_not_configured");
      let lastError: unknown;
      for (let attempt = 0; attempt <= retries; attempt += 1) {
        try {
          return await searchOnce(kw);
        } catch (error) {
          lastError = error;
          if (attempt < retries) await sleep(retryDelayMs);
        }
      }
      throw lastError instanceof Error ? lastError : new Error("pansou_search_failed");
    },
  };
}
