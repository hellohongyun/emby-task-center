/**
 * 测试用凭据校验器。
 *
 * P1 之前每个路由测试都直接用 `auth: { sharedPassword }` 构造会话管理器；
 * 登录改由设置驱动后（默认 admin/admin123），这里把"固定口令"这套测试写法集中到一处，
 * 避免在十几个测试文件里各写一份 verifyCredentials 桩。
 */
import type { SessionCredentials } from "./session";

/** 用户名留空（兼容旧前端）或等于给定用户名时，口令匹配即通过。 */
export function staticCredentialVerifier(
  password: string,
  username = "admin",
  mustChangePassword = false,
): (candidate: string | undefined, secret: string) => SessionCredentials | null {
  return (candidate, secret) =>
    (candidate === undefined || candidate === "" || candidate === username) && secret === password
      ? { username, mustChangePassword }
      : null;
}
