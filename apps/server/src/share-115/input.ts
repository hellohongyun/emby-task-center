const shareHosts = new Set(["115.com", "www.115.com", "115cdn.com"]);
const sharePath = /^\/s\/([a-zA-Z0-9]{1,64})\/?$/;
const accessCodePattern = /^[a-zA-Z0-9]{4}$/;
const codeLabel = /(?:访问码|提取码|密码)(?:\s*[:：]\s*|\s+)([^\s，。；、！？）】》｜.,;!?|()[\]]+)/g;
const startsWithCodeLabel = /^\s*(?:(?:[-*+>•]|\d+[.)、])\s+)?(?:访问码|提取码|密码)(?:\s*[:：]\s*|\s+)/;
export const MAX_SHARE_115_BATCH = 10;

type Share115Link = { shareUrl: string; shareCode: string; accessCode: string };
type InputError = "invalid_share_link" | "invalid_access_code" | "conflicting_access_code";
type Entry = { index: number; retryText: string } & ({ link: Share115Link } | { error: InputError });
type BatchError = "invalid_share_link" | "too_many_share_links" | "access_code_requires_single_link";

function findCodes(text: string): string[] {
  return [...text.matchAll(codeLabel)].map((match) => match[1]!);
}

function parseLink(url: URL, codeValues: string[]): { link: Share115Link } | { error: InputError } {
  const shareCode = url.pathname.match(sharePath)?.[1];
  if (!shareCode || url.username || url.password || url.port) return { error: "invalid_share_link" };
  const codes = [...new Set([...url.searchParams.getAll("password"), ...codeValues].filter(Boolean))];
  if (codes.some((code) => !accessCodePattern.test(code))) return { error: "invalid_access_code" };
  if (codes.length > 1) return { error: "conflicting_access_code" };

  const shareUrl = new URL("https://115.com/s/" + shareCode);
  const accessCode = codes[0] ?? "";
  if (accessCode) shareUrl.searchParams.set("password", accessCode);
  return { link: { shareUrl: shareUrl.href, shareCode, accessCode } };
}

export function parseShare115Batch(
  shareText: string,
  explicitAccessCode = "",
): { entries: Entry[] } | { error: BatchError } {
  // A Markdown label may display a shorter URL without the destination's access code.
  const text = shareText
    .replace(/[\u200b-\u200d\u2060]/g, " ")
    .replace(/\[https?:\/\/[^\s\]]+\]\((https?:\/\/[^\s)]+)\)/gi, "$1");
  const urls = [...text.matchAll(/https?:\/\/[^\s<>"'()[\],;|，。；、！？：）】》｜]+/gi)].map((match) => ({
    raw: match[0].replace(/[.!?]+$/, ""),
    start: match.index,
    end: match.index + match[0].length,
    parsed: URL.parse(match[0].replace(/[.!?]+$/, "")),
  }));
  const candidates = urls.flatMap(({ parsed }, index) =>
    parsed && shareHosts.has(parsed.hostname) && (parsed.pathname === "/s" || parsed.pathname.startsWith("/s/"))
      ? [index]
      : [],
  );
  if (!candidates.length) return { error: "invalid_share_link" };
  if (candidates.length > MAX_SHARE_115_BATCH) return { error: "too_many_share_links" };
  if (candidates.length > 1 && explicitAccessCode.trim()) return { error: "access_code_requires_single_link" };

  return {
    entries: candidates.map((position, index) => {
      const { raw, start, end, parsed } = urls[position]!;
      const previous = urls[position - 1];
      const next = urls[position + 1];
      const before = text.slice(previous?.end ?? 0, start).split(/\r?\n/);
      const after = text.slice(end, next?.start ?? text.length).split(/\r?\n/);
      // Inline codes after a URL belong to that URL. A new line can explicitly prefix its own URL.
      const leading = !previous || before.length > 1 ? findCodes(before.at(-1) ?? "") : [];
      const precedingLines = before.slice(previous ? 1 : 0, -1);
      const precedingBoundary = precedingLines.map((line) => startsWithCodeLabel.test(line)).lastIndexOf(false);
      if (!previous || precedingBoundary >= 0) {
        leading.push(...precedingLines.slice(precedingBoundary + 1).flatMap(findCodes));
      }
      const trailing = findCodes(after[0]!);
      for (const line of after.slice(1, next ? -1 : undefined)) {
        if (!startsWithCodeLabel.test(line)) break;
        trailing.push(...findCodes(line));
      }
      const labeledCodes =
        urls.length === 1 ? findCodes(text.slice(0, start) + " " + text.slice(end)) : [...leading, ...trailing];
      const codes = [...new Set([explicitAccessCode.trim(), ...labeledCodes].filter(Boolean))];
      const outcome = parseLink(parsed!, codes);
      return {
        index: index + 1,
        retryText:
          "link" in outcome ? outcome.link.shareUrl : [raw, ...codes.map((code) => "访问码：" + code)].join("\n"),
        ...outcome,
      };
    }),
  };
}
