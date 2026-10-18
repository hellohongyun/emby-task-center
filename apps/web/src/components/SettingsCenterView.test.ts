import { fireEvent, render, screen, waitFor } from "@testing-library/vue";
import { afterEach, describe, expect, it, vi } from "vitest";

import SettingsCenterView from "./SettingsCenterView.vue";

const payload = {
  groups: [
    {
      group: "admin",
      label: "管理员",
      settings: [
        {
          key: "admin.username",
          group: "admin",
          label: "管理员用户名",
          secret: false,
          hasValue: true,
          source: "db" as const,
          value: "admin",
        },
      ],
    },
    {
      group: "email",
      label: "邮件通知",
      settings: [
        {
          key: "email.host",
          group: "email",
          label: "SMTP 服务器",
          secret: false,
          hasValue: false,
          source: "default" as const,
          value: "",
        },
        {
          key: "email.password",
          group: "email",
          label: "SMTP 密码",
          secret: true,
          hasValue: true,
          source: "db" as const,
          value: "****",
        },
      ],
    },
    {
      group: "library",
      label: "媒体库",
      settings: [
        {
          key: "library.scanIntervalMinutes",
          group: "library",
          label: "扫描间隔（分钟，0=关闭周期扫描）",
          secret: false,
          hasValue: true,
          source: "default" as const,
          value: 30,
        },
        {
          key: "emby.enabled",
          group: "emby",
          label: "启用 Emby 相关后台任务",
          secret: false,
          hasValue: true,
          source: "default" as const,
          value: true,
        },
      ],
    },
  ],
  admin: { username: "admin", hasPassword: true, mustChangePassword: true },
  warnings: [],
};

function jsonResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

afterEach(() => vi.restoreAllMocks());

describe("SettingsCenterView", () => {
  it("renders registry groups, labels and masks secrets", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(payload)));
    render(SettingsCenterView, { props: {} });

    await waitFor(() => expect(screen.getByText("邮件通知")).toBeInTheDocument());
    expect(screen.getByText("管理员用户名")).toBeInTheDocument();
    expect(screen.getByText("SMTP 密码")).toBeInTheDocument();
    // 密钥字段不渲染明文也不渲染掩码：只显示"已配置"状态 + 留空即不修改的占位提示。
    expect(screen.getByText("密钥·已配置")).toBeInTheDocument();
    expect(screen.queryByText("****")).toBeNull();
    expect(screen.getAllByText("后台已保存").length).toBeGreaterThan(0);
    expect(screen.getAllByText("默认值").length).toBeGreaterThan(0);
  });

  it("warns while the default password is still in use", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(payload)));
    render(SettingsCenterView, { props: {} });

    await waitFor(() => expect(screen.getByText(/仍在使用初始化默认口令/)).toBeInTheDocument());
    // 提示里不应该复述默认口令本身
    expect(screen.queryByText(/admin123/)).toBeNull();
  });

  it("renders multi-line copy settings (mail body / member notice) as a textarea", async () => {
    // 邮件正文、会员端提示这类文案是多行的：塞进一行 input 里根本没法改。
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          ...payload,
          groups: [
            {
              group: "member",
              label: "会员",
              settings: [
                {
                  key: "member.welcomeEmailBody",
                  group: "member",
                  label: "开通邮件正文",
                  secret: false,
                  hasValue: true,
                  multiline: true,
                  source: "default" as const,
                  value: "第一行 {{username}}\n第二行 {{password}}",
                },
                {
                  key: "member.welcomeEmailSubject",
                  group: "member",
                  label: "开通邮件主题",
                  secret: false,
                  hasValue: true,
                  source: "default" as const,
                  value: "主题",
                },
              ],
            },
          ],
        }),
      ),
    );
    render(SettingsCenterView, { props: {} });

    await waitFor(() => expect(screen.getByText("会员")).toBeInTheDocument());
    const body = screen.getByLabelText(/开通邮件正文/, { selector: "textarea" }) as HTMLTextAreaElement;
    expect(body.value).toContain("{{username}}");
    // 单行项仍然是一行 input，不被多行开关影响
    expect(screen.getByLabelText(/开通邮件主题/, { selector: "input" })).toBeInTheDocument();
  });

  it("submits only the fields the operator actually changed", async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        return jsonResponse({ ...payload, updated: ["email.host"], rejected: [] });
      }
      return jsonResponse(payload);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(SettingsCenterView, { props: {} });

    await waitFor(() => expect(screen.getByText("邮件通知")).toBeInTheDocument());
    const hostInput = screen.getByLabelText(/SMTP 服务器/, { selector: "input" });
    await fireEvent.update(hostInput, "smtp.example.com");
    await fireEvent.click(screen.getByRole("button", { name: /保存修改/ }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const patch = fetchMock.mock.calls.find((call) => (call[1] as RequestInit | undefined)?.method === "PATCH");
    expect(patch?.[0]).toBe("/api/settings");
    expect(JSON.parse((patch?.[1] as RequestInit).body as string)).toEqual({
      values: { "email.host": "smtp.example.com" },
    });
  });

  it("tells the page to refresh the status card after a successful save", async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === "PATCH") return jsonResponse({ ...payload, updated: ["email.host"], rejected: [] });
      return jsonResponse(payload);
    });
    vi.stubGlobal("fetch", fetchMock);
    const saved = vi.fn();
    render(SettingsCenterView, { props: {}, attrs: { onSaved: saved } });

    await waitFor(() => expect(screen.getByText("邮件通知")).toBeInTheDocument());
    await fireEvent.update(screen.getByLabelText(/SMTP 服务器/, { selector: "input" }), "smtp.example.com");
    await fireEvent.click(screen.getByRole("button", { name: /保存修改/ }));

    // 保存后外层会重新拉 /api/integrations/status，SMTP 一填好状态卡片就变"已配置"。
    await waitFor(() => expect(saved).toHaveBeenCalledTimes(1));
  });

  it("does not ask for a status refresh when everything was rejected", async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        return jsonResponse({
          ...payload,
          updated: [],
          rejected: [{ key: "email.host", error: "取值不合法" }],
        });
      }
      return jsonResponse(payload);
    });
    vi.stubGlobal("fetch", fetchMock);
    const saved = vi.fn();
    render(SettingsCenterView, { props: {}, attrs: { onSaved: saved } });

    await waitFor(() => expect(screen.getByText("邮件通知")).toBeInTheDocument());
    await fireEvent.update(screen.getByLabelText(/SMTP 服务器/, { selector: "input" }), "smtp.example.com");
    await fireEvent.click(screen.getByRole("button", { name: /保存修改/ }));

    await waitFor(() => expect(screen.getByText("取值不合法")).toBeInTheDocument());
    expect(saved).not.toHaveBeenCalled();
  });

  it("sends the raw secret when it is edited and never echoes the mask back", async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === "PATCH") return jsonResponse({ ...payload, updated: ["email.password"], rejected: [] });
      return jsonResponse(payload);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(SettingsCenterView, { props: {} });

    await waitFor(() => expect(screen.getByText("SMTP 密码")).toBeInTheDocument());
    const secretInput = screen.getByLabelText(/SMTP 密码/, { selector: "input" }) as HTMLInputElement;
    expect(secretInput.value).toBe("");
    expect(secretInput.placeholder).toContain("已配置");

    await fireEvent.update(secretInput, "brand-new-secret");
    await fireEvent.click(screen.getByRole("button", { name: /保存修改/ }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const patch = fetchMock.mock.calls.find((call) => (call[1] as RequestInit | undefined)?.method === "PATCH");
    expect(JSON.parse((patch?.[1] as RequestInit).body as string)).toEqual({
      values: { "email.password": "brand-new-secret" },
    });
  });

  it("reports per-field rejections from the server", async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        return jsonResponse({
          ...payload,
          updated: [],
          rejected: [{ key: "library.scanIntervalMinutes", error: "Too small" }],
        });
      }
      return jsonResponse(payload);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(SettingsCenterView, { props: {} });

    await waitFor(() => expect(screen.getByText("媒体库")).toBeInTheDocument());
    const interval = screen.getByLabelText(/扫描间隔/, { selector: "input" });
    await fireEvent.update(interval, "-5");
    await fireEvent.click(screen.getByRole("button", { name: /保存修改/ }));

    await waitFor(() => expect(screen.getByText("Too small")).toBeInTheDocument());
  });
});

describe("multi-choice settings (PanSou platforms)", () => {
  const choicePayload = {
    groups: [
      {
        group: "pansou",
        label: "PanSou 聚合搜索",
        settings: [
          {
            key: "pansou.enabledPlatforms",
            group: "pansou",
            label: "启用的网盘/磁力",
            secret: false,
            hasValue: true,
            source: "db" as const,
            value: ["115", "magnet"],
            choices: [
              { value: "115", label: "115网盘", help: "网盘" },
              { value: "magnet", label: "磁力", help: "磁力" },
              { value: "quark", label: "夸克网盘", help: "网盘" },
            ],
          },
        ],
      },
    ],
    admin: { username: "admin", hasPassword: true, mustChangePassword: false },
    warnings: [],
  };

  it("renders candidate switches instead of a comma separated text box", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(choicePayload)));
    render(SettingsCenterView, { props: {} });

    await waitFor(() => expect(screen.getByText("115网盘")).toBeInTheDocument());
    const boxes = screen.getAllByRole("checkbox") as HTMLInputElement[];
    expect(boxes).toHaveLength(3);
    expect(boxes[0]!.checked).toBe(true); // 115 已启用
    expect(boxes[1]!.checked).toBe(true); // 磁力 已启用
    expect(boxes[2]!.checked).toBe(false); // 夸克 未启用
  });

  it("sends the selected platform keys as an array", async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        const body = JSON.parse(String(init.body)) as { values: Record<string, unknown> };
        // 与真实接口一致：回完整载荷 + updated/rejected（只回局部会让 admin 变 undefined）
        return jsonResponse({ ...choicePayload, updated: Object.keys(body.values), rejected: [] });
      }
      return jsonResponse(choicePayload);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(SettingsCenterView, { props: {} });

    await waitFor(() => expect(screen.getByText("夸克网盘")).toBeInTheDocument());
    // 第三个开关是「夸克网盘」（未启用 → 点开）
    await fireEvent.click(screen.getAllByRole("checkbox")[2]!);
    await fireEvent.click(screen.getByRole("button", { name: /保存修改/ }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const patch = fetchMock.mock.calls.find((call) => (call[1] as RequestInit | undefined)?.method === "PATCH");
    const body = JSON.parse(String((patch?.[1] as RequestInit).body)) as { values: Record<string, unknown> };
    expect(body.values["pansou.enabledPlatforms"]).toEqual(["115", "magnet", "quark"]);
  });
});
