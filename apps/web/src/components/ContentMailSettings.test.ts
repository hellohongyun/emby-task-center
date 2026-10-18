import { fireEvent, render, screen, waitFor } from "@testing-library/vue";
import { afterEach, describe, expect, it, vi } from "vitest";

import ContentMailSettings from "./ContentMailSettings.vue";

/**
 * 这四块原先在「会员与运营 → 运营设置」里，随那一段一起搬进「系统设置」。
 * 这里守住接口接线：公告/平台说明读 /api/articles，邮件偏好读 /api/settings/mail-defaults，
 * 保存分别打 PUT /api/articles/:code 与 PUT /api/settings/mail-defaults。
 */
function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const calls: string[] = [];
function stubApi() {
  calls.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation(async (url: string | URL | Request, init?: RequestInit) => {
      const target = String(url instanceof Request ? url.url : url);
      calls.push(`${init?.method ?? "GET"} ${target}`);
      if (target.includes("/api/articles") && (init?.method ?? "GET") === "GET") {
        return json(200, {
          articles: [
            { code: "announcement", title: "平台公告", content: "今晚维护", enabled: true, sort: 1, forceSeconds: 5 },
            { code: "rules", title: "平台使用规范", content: "一、账号使用", enabled: true, sort: 2 },
          ],
        });
      }
      if (target.includes("/api/settings/mail-defaults") && (init?.method ?? "GET") === "GET") {
        return json(200, { defaults: { membership_reminder: true } });
      }
      return json(200, { ok: true });
    }),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("ContentMailSettings", () => {
  it("renders the moved blocks with live data and saves the mail defaults", async () => {
    stubApi();
    render(ContentMailSettings, { props: { requireAuth: vi.fn() } });

    expect(await screen.findByRole("heading", { name: "公告管理（弹窗）" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "平台说明与规范" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "邮件默认发送设置" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "用户邮件代设" })).toBeInTheDocument();

    // 公告正文来自后端（管理员就地编辑）；公告同时出现在下面的「平台说明」列表里，所以用 getAll
    await waitFor(() => expect(screen.getAllByDisplayValue("今晚维护").length).toBeGreaterThan(0));
    expect(screen.getAllByDisplayValue("今晚维护")[0]).toBeInTheDocument();
    // 平台说明里除了公告还有别的条目
    expect(screen.getByText("平台使用规范")).toBeInTheDocument();

    // 邮件默认：勾选状态跟随接口，保存走 PUT
    const checkboxes = screen.getAllByRole("checkbox");
    expect(checkboxes.length).toBeGreaterThanOrEqual(2);
    await fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(calls.some((entry) => entry.startsWith("PUT /api/settings/mail-defaults"))).toBe(true));
  });

  it("saves the announcement through the article endpoint", async () => {
    stubApi();
    render(ContentMailSettings, { props: { requireAuth: vi.fn() } });

    const [body] = await screen.findAllByDisplayValue("今晚维护");
    if (!body) throw new Error("公告正文没渲染出来");
    await fireEvent.update(body, "改到明晚维护");
    await fireEvent.click(screen.getByRole("button", { name: /保存并生效/ }));

    await waitFor(() => expect(calls.some((entry) => entry.startsWith("PUT /api/articles/announcement"))).toBe(true));
  });
});
