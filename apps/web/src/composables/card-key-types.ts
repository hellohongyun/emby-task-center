export interface CardRow {
  id: number;
  code: string;
  kind: string;
  kindLabel: string;
  /** 管理员起的名字（没起时为 null）。 */
  name: string | null;
  /** 展示名：名称优先，没名字回落类型标签——列表与用户侧都用它，不出现空白。 */
  displayName: string;
  days: number;
  /** 固定到期日（ISO）；null 表示"兑换后 N 天"的相对卡（月/年/试用卡与老卡）。 */
  expiresAt: string | null;
  /** 到期时间名称（管理员 DIY）；有值时用户侧优先显示它。 */
  expiryLabel: string | null;
  /** 到期主文案（服务端算好：名称优先）。 */
  expiryText: string;
  /** 真实到期日 `YYYY-MM-DD`，相对卡为 null。 */
  expiryDate: string | null;
  /** 固定到期日已过：这张卡不能再被兑换。 */
  expired: boolean;
  /** 彩蛋祝福文案；为空则不弹窗。 */
  blessing: string | null;
  status: string;
  statusLabel: string;
  usedByEmail: string | null;
  usedAt: string | null;
  createdAt: string;
}

export interface CardStats {
  total: number;
  unused: number;
  used: number;
}

export interface CreateCardInput {
  kind: string;
  /** 相对天数（自定义卡且没给 expiresAt 时必填）。 */
  days?: number;
  /** 固定到期日 `YYYY-MM-DD`（日历选出来的）：给了就走"固定到期日"语义。 */
  expiresAt?: string;
  name?: string;
  expiryLabel?: string;
  blessing?: string;
  count: number;
}

/** AI 生成失败的机器可读原因 → 管理员该做的下一步。 */
export const AI_ERROR_TEXT: Record<string, string> = {
  ai_not_configured: "AI 还没配置：请到 系统设置 → AI 文案 填写接口地址、API Key 与模型，并打开「启用 AI 文案」。",
  ai_unauthorized: "AI 接口拒绝了这个 API Key，请检查 Key 是否正确或已过期。",
  ai_timeout: "AI 接口响应超时，请稍后重试，或把「请求超时」调大一些。",
  ai_request_failed: "AI 接口请求失败，请检查接口地址与网络。",
  ai_empty_result: "AI 没有返回可用文案，换个场景描述再试一次。",
};
