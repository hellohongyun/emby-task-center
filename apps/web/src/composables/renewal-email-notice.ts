export function renewalEmailNotice(status: string | null | undefined): string {
  if (status === "sent") return "续期通知邮件已发送，请查收。";
  if (status === "pending" || status === "not_configured") return "通知邮件待发送，系统将自动补发；无需重复续费。";
  if (status === "unchanged") return "本次未重复续费，也未重复发送通知邮件。";
  return "";
}
