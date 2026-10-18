export const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

/** 「正片更新时间」文本：周日/周三 18:00；未设置返回 null。 */
export function releaseText(days: number[] | null | undefined, time: string | null | undefined): string | null {
  if (!days || days.length === 0 || !time) return null;
  return `${days.map((day) => WEEKDAYS[day]).join("/")} ${time}`;
}

/** 下一个「正片更新时间」时刻（严格晚于 now，向后找 7 天）。 */
export function nextReleaseMoment(
  days: number[] | null | undefined,
  time: string | null | undefined,
  from = new Date(),
): Date | null {
  if (!days || days.length === 0 || !time) return null;
  const [hours, minutes] = time.split(":").map(Number);
  for (let offset = 0; offset < 7; offset += 1) {
    const candidate = new Date(from.getFullYear(), from.getMonth(), from.getDate() + offset, hours, minutes, 0, 0);
    if (days.includes(candidate.getDay()) && candidate.getTime() > from.getTime()) return candidate;
  }
  return null;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** 格式化：MM-DD 周X HH:mm（本地时区）。 */
export function formatMoment(date: Date): string {
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${WEEKDAYS[date.getDay()]} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
