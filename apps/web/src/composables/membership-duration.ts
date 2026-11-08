export function formatMembershipDuration(milliseconds: number): string {
  const minutes = Math.floor(milliseconds / 60_000);
  if (minutes < 1) return "不足 1 分钟";
  const days = Math.floor(minutes / (24 * 60));
  const hours = Math.floor((minutes % (24 * 60)) / 60);
  const remainder = minutes % 60;
  return [days && `${days} 天`, hours && `${hours} 小时`, remainder && `${remainder} 分钟`].filter(Boolean).join(" ");
}
