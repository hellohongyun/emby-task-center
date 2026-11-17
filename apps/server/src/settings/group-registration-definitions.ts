import { z } from "zod";
import type { SettingDefinition } from "./registry";

export const GROUP_REGISTRATION_NOTICE_SETTINGS = {
  "member.groupInviteNoticeEnabled": {
    group: "member",
    label: "显示群邀请码提示",
    help: "控制注册页获取邀请码的说明是否显示；关闭后仍显示邀请码输入框和复制群号按钮，并继续校验邀请码。",
    schema: z.boolean().default(true),
  },
  "member.groupInviteNotice": {
    group: "member",
    label: "群邀请码提示文案",
    help: "注册页显示的说明，支持换行，最多 2000 字。{groupNumber} 会自动替换为注册 QQ 群号。",
    multiline: true,
    schema: z
      .string()
      .max(2000)
      .default("请在 QQ 搜索群号 {groupNumber} 并申请入群，打开「群公告」查看「会员注册邀请码」。"),
  },
} satisfies Record<string, SettingDefinition>;
