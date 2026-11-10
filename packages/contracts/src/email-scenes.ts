export const EMAIL_SCENES = {
  test: "邮件服务测试",
  login: "登录验证码",
  registration: "注册验证码",
  welcome: "账号开通",
  renewal: "会员续期",
  expiring: "即将到期",
  expired: "会员已到期",
} as const;

export type EmailScene = keyof typeof EMAIL_SCENES;
