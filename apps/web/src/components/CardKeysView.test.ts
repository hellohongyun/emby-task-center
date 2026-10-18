import { fireEvent, render, screen, waitFor } from "@testing-library/vue";
import { afterEach, describe, expect, it, vi } from "vitest";

import CardKeysView from "./CardKeysView.vue";

/**
 * 后台卡密页：自定义卡的名称 / 到期口径 / 彩蛋文案 / AI 帮写。
 *
 * 这个页面最容易出的错是"表单看着能填、发出去的请求却是老形状"，所以核心断言放在
 * **请求体**上（不是"输入框里有字"）；列表则守"名称与到期时间优先显示管理员写的那句"。
 */
function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const customCard = {
  id: 1,
  code: "CARDAAAA1111",
  kind: "custom",
  kindLabel: "自定义",
  name: "国庆节卡密",
  displayName: "国庆节卡密",
  days: 120,
  expiresAt: "2027-02-20T15:59:59.999Z",
  expiryLabel: "2027 年春节结束到期",
  expiryText: "2027 年春节结束到期",
  expiryDate: "2027-02-20",
  expired: false,
  blessing: "祝你春节快乐！",
  status: "unused",
  statusLabel: "未使用",
  usedByEmail: null,
  usedAt: null,
  createdAt: "2026-09-16T00:00:00.000Z",
};

const monthCard = {
  ...customCard,
  id: 2,
  code: "CARDBBBB2222",
  kind: "month",
  kindLabel: "月卡",
  name: null,
  displayName: "月卡",
  days: 30,
  expiresAt: null,
  expiryLabel: null,
  expiryText: "兑换后 30 天",
  expiryDate: null,
  blessing: null,
  status: "used",
  statusLabel: "已使用",
  usedByEmail: "someone@example.com",
  usedAt: "2026-09-15T00:00:00.000Z",
};

let calls: Array<{ url: string; method: string; body: Record<string, unknown> | null }> = [];

function stubApi(
  options: { cards?: unknown[]; draft?: () => Response; test?: () => Response; create?: () => Response } = {},
) {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const target = String(url instanceof Request ? url.url : url);
      const raw = init?.body ? String(init.body) : null;
      calls.push({
        url: target,
        method: init?.method ?? "GET",
        body: raw ? (JSON.parse(raw) as Record<string, unknown>) : null,
      });
      if (target.includes("/api/cards/blessing/draft"))
        return options.draft?.() ?? json(409, { error: "ai_not_configured" });
      if (target.includes("/api/cards/blessing/test"))
        return options.test?.() ?? json(409, { error: "ai_not_configured" });
      if (target.endsWith("/api/cards") && (init?.method ?? "GET") === "POST")
        return options.create?.() ?? json(201, { codes: ["NEWCARD12345"], count: 1 });
      if (target.includes("/api/cards")) {
        const cards = options.cards ?? [customCard, monthCard];
        return json(200, { cards, total: cards.length, unused: 1, used: 1 });
      }
      return json(404, { error: "not_found" });
    }),
  );
}

/** 最后一次打向某前缀的请求（测试只关心"最终发出去的是什么"）。 */
function lastCall(fragment: string) {
  const matched = calls.filter((call) => call.url.includes(fragment));
  return matched[matched.length - 1];
}
const button = (name: string | RegExp) => screen.getByRole("button", { name }) as HTMLButtonElement;

async function pickCustom() {
  await fireEvent.update(screen.getByRole("combobox", { name: /类型/ }), "custom");
}

describe("CardKeysView 自定义卡密", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("月卡/年卡不显示日历与到期时间名称（相对天数卡没有这两件事）", async () => {
    stubApi();
    render(CardKeysView);
    await screen.findByText("国庆节卡密");

    expect(screen.queryByText("到期时间名称")).toBeNull();
    expect(screen.queryByText("自定义方式")).toBeNull();
    expect(screen.getByText(/月卡 \/ 年卡 \/ 试用卡是相对天数卡/)).toBeTruthy();
  });

  it("切到自定义 → 出现日历与到期时间名称，并说明固定到期日的含义", async () => {
    stubApi();
    render(CardKeysView);
    await screen.findByText("国庆节卡密");

    await pickCustom();
    expect(screen.getByText("到期时间")).toBeTruthy();
    expect(screen.getByText("到期时间名称")).toBeTruthy();
    expect(screen.getByText(/不论用户什么时候兑换/)).toBeTruthy();
  });

  it("自定义 + 按天数：保留老玩法，请求体带 days、不带 expiresAt", async () => {
    stubApi();
    render(CardKeysView);
    await screen.findByText("国庆节卡密");

    await pickCustom();
    await fireEvent.update(screen.getByRole("combobox", { name: /自定义方式/ }), "days");
    await fireEvent.update(screen.getByRole("spinbutton", { name: /天数/ }), "15");
    await fireEvent.update(screen.getByPlaceholderText("如：国庆节卡密（留空按类型显示）"), "十五天卡");
    await fireEvent.click(button(/生成卡密/));

    await waitFor(() => expect(lastCall("/api/cards")).toBeTruthy());
    const body = lastCall("/api/cards")!.body!;
    expect(body).toMatchObject({ kind: "custom", days: 15, name: "十五天卡" });
    expect(body.expiresAt).toBeUndefined();
    expect(body.expiryLabel).toBeUndefined();
  });

  it("自定义 + 按到期日期：请求体带 expiresAt 与到期时间名称，并带上彩蛋文案", async () => {
    stubApi();
    render(CardKeysView);
    await screen.findByText("国庆节卡密");

    await pickCustom();
    await fireEvent.update(screen.getByPlaceholderText("如：国庆节卡密（留空按类型显示）"), "国庆节卡密");
    await fireEvent.update(screen.getByPlaceholderText("如：2027 年春节结束到期"), "2027 年春节结束到期");
    await fireEvent.update(screen.getByPlaceholderText(/用户在注册或续期时点/), "祝你春节快乐，好片看不停！");
    await fireEvent.update(screen.getByRole("spinbutton", { name: /数量/ }), "3");
    await fireEvent.click(button(/生成卡密/));

    await waitFor(() =>
      expect(calls.some((call) => call.method === "POST" && call.url.endsWith("/api/cards"))).toBe(true),
    );
    const created = calls.filter((call) => call.method === "POST" && call.url.endsWith("/api/cards"));
    const body = created[created.length - 1]!.body!;
    expect(body).toMatchObject({
      kind: "custom",
      name: "国庆节卡密",
      expiryLabel: "2027 年春节结束到期",
      blessing: "祝你春节快乐，好片看不停！",
      count: 3,
    });
    // 日历给的日期是 YYYY-MM-DD 形态（服务端再归一到当天 23:59）
    expect(String(body.expiresAt)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(body.days).toBeUndefined();
  });

  it("AI 帮写把返回的文案写进输入框；未配置时给出可执行的引导而不是内部错误码", async () => {
    stubApi({ draft: () => json(200, { text: "国庆快乐，追剧愉快！" }) });
    render(CardKeysView);
    await screen.findByText("国庆节卡密");

    await fireEvent.click(button(/AI 帮写/));
    await waitFor(() =>
      expect((screen.getByPlaceholderText(/用户在注册或续期时点/) as HTMLTextAreaElement).value).toBe(
        "国庆快乐，追剧愉快！",
      ),
    );
    expect(lastCall("/blessing/draft")!.body).toMatchObject({ occasion: "月卡" });

    // 换成"未配置"：按钮旁边要告诉管理员去哪配，而不是显示 ai_not_configured
    stubApi({ draft: () => json(409, { error: "ai_not_configured" }) });
    render(CardKeysView);
    await screen.findAllByText("国庆节卡密");
    const aiButtons = screen.getAllByRole("button", { name: /AI 帮写/ });
    await fireEvent.click(aiButtons[aiButtons.length - 1]!);
    expect(await screen.findByText(/请到 系统设置 → AI 文案/)).toBeTruthy();
  });

  it("列表用「名称 + 到期文案」显示，自定义卡的名称优先于真实日期", async () => {
    stubApi();
    render(CardKeysView);

    // 名称列：没起名字的月卡回落类型标签（名称 + 类型两处都出现"月卡"），不出现空白
    expect(await screen.findByText("国庆节卡密")).toBeTruthy();
    expect(screen.getAllByText("月卡").length).toBeGreaterThanOrEqual(2);
    // 到期列：自定义卡显示管理员写的名称 + 小字真实日期；月卡显示"兑换后 30 天"
    expect(screen.getAllByText("2027 年春节结束到期").length).toBeGreaterThan(0);
    expect(screen.getByText("2027-02-20")).toBeTruthy();
    expect(screen.getByText("兑换后 30 天")).toBeTruthy();
    // 配了彩蛋的卡有 🎁 标记（用 title 说明），方便一眼看出会不会弹窗
    expect(screen.getByText(/🎁 表示配了彩蛋祝福/)).toBeTruthy();
  });

  it("行内编辑只改文案类字段，绝不碰到期时间", async () => {
    stubApi();
    render(CardKeysView);
    await screen.findByText("国庆节卡密");

    await fireEvent.click(screen.getAllByRole("button", { name: /编辑名称/ })[0]!);
    await fireEvent.update(screen.getByPlaceholderText("留空按类型显示"), "国庆节限定卡密");
    await fireEvent.click(button("保存"));

    await waitFor(() => expect(calls.some((call) => call.method === "PATCH")).toBe(true));
    const body = calls.find((call) => call.method === "PATCH")!.body!;
    expect(body).toMatchObject({ ids: [1], name: "国庆节限定卡密" });
    // 到期时间相关字段一概不出现在 patch 里
    expect(body.expiresAt).toBeUndefined();
    expect(body.days).toBeUndefined();
  });
});

/**
 * 删除的"手感"：不能因为一次删除就把整张表变成加载态。
 *
 * 用户报的现象是「生成了 10 个，删除时变卡，不能流畅地删除，需要等待一会才能删除」。
 * 根因不在服务端（实测删一条 0.0ms），而在列表区的加载态分支会把整张表格换成
 * 「正在读取…」——那段时间一个按钮都点不了。这组用例把"表格必须在位、行要立刻消失"
 * 钉成回归。
 */
describe("CardKeysView 删除手感", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("删除后行立刻消失、表格不闪成加载态，且能立刻删下一条", async () => {
    const cards = [
      customCard,
      monthCard,
      { ...customCard, id: 3, code: "CARDCCCC3333", name: "第三张卡", displayName: "第三张卡" },
    ];
    /** 挂起删除请求，用来模拟"服务端慢"的那段时间。放在对象里是为了让 TS 认得出可空调用。 */
    const pending: { resolve?: () => void } = {};
    const calls: Array<{ url: string; method: string; body: Record<string, unknown> | null }> = [];

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const target = String(url instanceof Request ? url.url : url);
        const method = init?.method ?? "GET";
        const raw = init?.body ? String(init.body) : null;
        calls.push({ url: target, method, body: raw ? JSON.parse(raw) : null });
        if (target.endsWith("/api/cards") && method === "DELETE") {
          // 故意让删除请求"慢"：旧实现在这段时间会把整张表换成"正在读取…"
          await new Promise<void>((resolve) => {
            pending.resolve = resolve;
          });
          return json(200, { ok: true, deleted: 1 });
        }
        if (target.includes("/api/cards")) return json(200, { cards, total: 3, unused: 2, used: 1 });
        return json(404, { error: "not_found" });
      }),
    );

    render(CardKeysView);
    await screen.findByText("国庆节卡密");
    expect(screen.getAllByRole("button", { name: /删除卡密|删除中/ })).toHaveLength(3);

    const deletes = screen.getAllByRole("button", { name: /删除卡密|删除中/ });
    await fireEvent.click(deletes[0]!);
    await fireEvent.click(deletes[1]!);
    await fireEvent.click(deletes[2]!);

    // 三个删除请求都发出去了（不被前一个阻塞）
    await waitFor(() => expect(calls.filter((call) => call.method === "DELETE")).toHaveLength(3));
    // 全程没有出现"正在读取…"
    expect(screen.queryByText("正在读取…")).toBeNull();
    // 行是从本地列表移除的，不等服务端
    expect(screen.getByText(/暂无卡密/)).toBeTruthy();

    pending.resolve?.();
  });
});
