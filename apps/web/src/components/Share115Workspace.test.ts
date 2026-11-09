import { fireEvent, render, screen, waitFor, within } from "@testing-library/vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import Share115Workspace from "./Share115Workspace.vue";
import type { Share115Item } from "../composables/share-115-api";

const row: Share115Item = {
  id: 9,
  jobId: 3,
  submittedAt: "2026-11-09T05:00:00.000Z",
  shareUrl: "https://115.com/s/test-share",
  shareCode: "test-share",
  accessCode: "Ab42",
  status: "queued",
  note: "测试分享",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const page = (items: Share115Item[], accepting = true) =>
  json({ items, accepting, total: items.length, page: 1, pageSize: 20 });

afterEach(() => vi.unstubAllGlobals());

describe("115 shares workspace", () => {
  it("submits a share directly and shows the link and access code in the member record", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementationOnce(async () => page([]))
      .mockImplementationOnce(async () => json({ item: row }, 202))
      .mockImplementationOnce(async () => page([{ ...row, status: "saved", shareTitle: "分享片名" }]));
    vi.stubGlobal("fetch", fetch);
    render(Share115Workspace);
    const input = screen.getByLabelText("115 分享链接或文案");
    await waitFor(() => expect(input).toBeEnabled());
    await fireEvent.update(input, row.shareUrl);
    await fireEvent.update(screen.getByLabelText(/访问码/), row.accessCode);
    await fireEvent.update(screen.getByLabelText(/片名或补充说明/), row.note);
    await fireEvent.click(screen.getByRole("button", { name: "提交转存" }));
    const record = await screen.findByRole("article");
    await waitFor(() => expect(within(record).getByText("已保存")).toBeInTheDocument());
    expect(within(record).getByRole("heading", { name: "分享片名" })).toBeInTheDocument();
    expect(within(record).getByText("Ab42")).toBeInTheDocument();
    expect(fetch.mock.calls[1]?.[0]).toBe("/api/public/115-shares");
    expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toEqual({
      shareText: row.shareUrl,
      accessCode: row.accessCode,
      note: row.note,
    });
    expect(input).toHaveValue("");
  });

  it("keeps history accessible when submissions are disabled", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => page([{ ...row, status: "already_exists" }], false)),
    );
    render(Share115Workspace);
    expect(await screen.findByText("当前暂不可提交转存，仍可查看历史记录。")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "提交转存" })).toBeDisabled();
    expect(within(screen.getByRole("article")).getByText("已存在")).toBeInTheDocument();
  });

  it("keeps only the rejected link in the form after a partial batch submission", async () => {
    const rejected = { index: 2, error: "invalid_access_code", retryText: "https://115.com/s/second?password=long" };
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementationOnce(async () => page([]))
      .mockImplementationOnce(async () => json({ items: [row], rejected: [rejected] }, 202))
      .mockImplementationOnce(async () => page([row]));
    vi.stubGlobal("fetch", fetch);
    render(Share115Workspace);
    const input = screen.getByLabelText("115 分享链接或文案");
    await waitFor(() => expect(input).toBeEnabled());
    const pasted = row.shareUrl + "\n" + rejected.retryText;
    await fireEvent.update(input, pasted);
    const note = screen.getByLabelText(/片名或补充说明/);
    await fireEvent.update(note, "本批补充");
    await fireEvent.click(screen.getByRole("button", { name: "提交转存" }));
    expect(await screen.findByText(/第 2 条链接.*访问码须为 4 位字母或数字/)).toBeInTheDocument();
    expect(input).toHaveValue(rejected.retryText);
    expect(note).toHaveValue("本批补充");
    expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toEqual({ shareText: pasted, note: "本批补充" });
  });

  it("submits as the administrator and displays the new record after clearing list filters", async () => {
    const adminRow = { ...row, adminUsername: "fixture-admin", memberId: null, memberEmail: null };
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementationOnce(async () => page([]))
      .mockImplementationOnce(async () => page([]))
      .mockImplementationOnce(async () => json({ item: adminRow }, 202))
      .mockImplementationOnce(async () => page([adminRow]));
    vi.stubGlobal("fetch", fetch);
    render(Share115Workspace, { props: { admin: true } });

    const input = screen.getByLabelText("115 分享链接或文案");
    await waitFor(() => expect(input).toBeEnabled());
    const search = screen.getByLabelText("搜索提交记录");
    await fireEvent.update(search, "会员查询");
    await fireEvent.click(screen.getByRole("button", { name: "搜索" }));
    expect(String(fetch.mock.calls[1]?.[0])).toContain("q=");

    await fireEvent.update(input, row.shareUrl);
    await fireEvent.click(screen.getByRole("button", { name: "提交转存" }));
    expect(await screen.findByText("管理员 · fixture-admin")).toBeInTheDocument();
    expect(fetch.mock.calls[2]?.[0]).toBe("/api/115-shares");
    expect(fetch.mock.calls[2]?.[1]?.method).toBe("POST");
    expect(JSON.parse(String(fetch.mock.calls[2]?.[1]?.body))).toEqual({ shareText: row.shareUrl });
    expect(fetch.mock.calls[3]?.[0]).toBe("/api/115-shares?page=1&pageSize=20");
    expect(search).toHaveValue("");
  });

  it("only sends the administrator resolution after a result is selected", async () => {
    const pendingRow = { ...row, status: "unconfirmed" as const, memberEmail: "fixture@example.test" };
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementationOnce(async () => page([pendingRow]))
      .mockImplementationOnce(async () => page([pendingRow]))
      .mockImplementationOnce(async () => json({ ok: true }))
      .mockImplementationOnce(async () => page([]));
    vi.stubGlobal("fetch", fetch);
    render(Share115Workspace, { props: { admin: true } });
    expect(await screen.findByText("fixture@example.test")).toBeInTheDocument();
    await fireEvent.update(screen.getByLabelText("转存状态"), "unconfirmed");
    await fireEvent.click(await screen.findByRole("button", { name: "核对结果" }));
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(String(fetch.mock.calls[1]?.[0])).toContain("status=unconfirmed");
    await fireEvent.click(screen.getByRole("button", { name: "标记已保存" }));
    expect(await screen.findByText("任务 #3 已标记为已保存。")).toBeInTheDocument();
    expect(fetch.mock.calls[2]?.[0]).toBe("/api/115-shares/jobs/3/resolve");
    expect(fetch.mock.calls[2]?.[1]?.method).toBe("PATCH");
    expect(JSON.parse(String(fetch.mock.calls[2]?.[1]?.body))).toEqual({ status: "saved" });
  });
});
