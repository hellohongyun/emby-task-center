/**
 * 后台可编辑文案的占位符渲染（邮件正文、门户提示、弹窗正文共用一份实现）。
 *
 * 口径（与自我解冻弹窗一致）：
 *  - 只替换**已知**占位符，未知的原样留着 —— 后台一眼能看出写错了哪个，而不是静默渲染成空。
 *  - 取值一律 String()，方便直接写数字（次数、路数）。
 */
export function renderTemplate(template: string, context: Record<string, string | number>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) => (key in context ? String(context[key]) : match));
}
