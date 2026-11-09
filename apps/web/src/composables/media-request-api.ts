import { useAuthenticatedRequest } from "./authenticated-request";

const messages: Record<string, string> = {
  unauthorized: "登录已失效，请重新登录。",
  membership_expired: "会员已过期，请先续期。",
  member_frozen: "账号被冻结，请先处理冻结状态。",
  member_disabled: "会员已停用。",
  not_member: "会员不存在，请重新登录。",
  tmdb_unavailable: "暂时无法读取 TMDB，请联系管理员。",
  tmdb_search_failed: "搜索失败，请稍后重试。",
  tmdb_details_failed: "作品资料读取失败，请重新选择。",
  rate_limited: "操作过于频繁，请稍后重试。",
  invalid_request: "请检查作品、分季和说明是否填写完整。",
  request_conflict: "这条申请已被更新，请刷新后再处理。",
  request_changed: "这条申请已被更新，请取消编辑并刷新，再重新编辑。",
  request_closed: "申请已结束，无法继续修改说明，请刷新记录。",
  request_not_found: "申请不存在或已不可访问，请刷新记录。",
  request_already_active: "同一作品或分季已有未结束申请，不能重复开启。",
  tmdb_lookup_failed: "无法确认作品资料，申请尚未提交，请稍后重试。",
  season_required: "请选择该剧实际存在的一个季。",
  description_required: "请填写缺少的集号或补集说明。",
  member_changed: "会员身份已变化，请重新登录后操作。",
};

export function useMediaRequestApi(admin = false, requireAuth: () => void = () => {}) {
  return useAuthenticatedRequest(messages, admin, requireAuth);
}
