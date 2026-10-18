export function describeRequest(method: string, path: string): string {
  if (method === "POST" && path === "/api/auth/login") return "登录";
  if (method === "POST" && path === "/api/auth/logout") return "退出登录";
  if (path.startsWith("/api/tmdb")) return "查询 TMDB 信息";
  if (path.startsWith("/api/library")) return "媒体库操作";
  if (method === "GET" && path === "/api/system/status") return "读取系统状态";
  if (method === "GET" && path === "/api/activity") return "读取执行记录";
  if (path.startsWith("/api/integrations")) return "外部集成操作";
  if (path.startsWith("/api/task-settings")) return "任务自动化设置";
  if (path.startsWith("/api/webhooks")) {
    if (path === "/api/webhooks") {
      if (method === "GET") return "读取 Webhook 配置";
      if (method === "POST") return "新增 Webhook";
    }
    if (method === "POST" && path.endsWith("/test")) return "测试 Webhook";
    if (method === "PUT") return "更新 Webhook";
    if (method === "DELETE") return "删除 Webhook";
  }
  if (path === "/api/tasks") {
    if (method === "GET") return "读取任务列表";
    if (method === "POST") return "创建任务";
  }
  if (path.startsWith("/api/tasks/")) {
    if (method === "POST" && path.endsWith("/cancel")) return "取消任务";
    if (method === "POST" && path.endsWith("/retry")) return "重试任务";
    if (method === "PUT" && path.endsWith("/tmdb")) return "改绑任务的 TMDB 条目";
    if (method === "DELETE") return "删除任务";
  }
  return "收到请求";
}
