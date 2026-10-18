import { fireEvent, render, screen } from "@testing-library/vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineComponent, h, ref } from "vue";

import UnfreezeModal from "./UnfreezeModal.vue";
import { resetPortalSession } from "../composables/usePortalSession";

/**
 * 自助解冻弹窗：**强制显示 + 强制等待**。
 *
 * 为什么值得测：这是会员绕过冻结的唯一入口，"倒计时结束前点不动"必须在界面上真的成立
 * （服务端还会再校验一次，见 self-unfreeze.test.ts）。弹窗里的每一句提示都来自后台，
 * 这里只断言"后台给什么就显示什么"，不写死文案。
 */

const WAIT_SECONDS = 60;
const NOTICE = "你的账号因同时在多台设备播放，已被临时冻结。\n请先关闭多余设备，再等倒计时结束点击「确认解冻」。";

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const baseUnfreeze = {
  enabled: false,
  frozen: false,
  reason: "not_frozen",
  disabledUntil: null,
  waitSeconds: WAIT_SECONDS,
  // 口径：每月 3 次、一次没用过 → 横幅/前置说明显示"本月还剩 3 次"，"本次解冻后还剩 2 次"。
  monthlyLimit: 3,
  usedThisMonth: 0,
  remainingChances: 3,
  remainingAfterThis: 2,
  requestedAt: null,
  readyAt: null,
  title: "申请提前解冻",
  notice: NOTICE,
};

function memberPayload(unfreeze: Record<string, unknown>) {
  return {
    email: "member@example.com",
    member: {
      email: "member@example.com",
      status: "active",
      subscriptionExpiresAt: null,
      embyUsername: "member@example.com",
      embyUserId: "u1",
      embyMaxStreams: 1,
      concurrency: { overshooting: false, notified: true, disabled: false, disabledUntil: null, remainingMs: null },
      unfreeze,
    },
  };
}

/** 点开弹窗（ack）→ 冻结中、等待 60 秒；确认解冻按需返回失败。 */
function stubFetch(options: { confirmError?: string; memberFrozen?: boolean } = {}) {
  const calls: Array<{ url: string; method: string }> = [];
  /** 服务端给的倒计时终点：申请时定下，失败重算时更新（前端不自己造时间）。 */
  let readyAt: string | null = null;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const target = String(url instanceof Request ? url.url : url);
      calls.push({ url: target, method: init?.method ?? "GET" });
      if (target.includes("/member/unfreeze/ack")) {
        const requestedAt = new Date().toISOString();
        readyAt = new Date(Date.parse(requestedAt) + WAIT_SECONDS * 1_000).toISOString();
        return json(200, {
          ok: true,
          unfreeze: {
            ...baseUnfreeze,
            enabled: true,
            frozen: true,
            reason: null,
            requestedAt,
            readyAt,
          },
        });
      }
      if (target.includes("/member/unfreeze")) {
        if (options.confirmError) {
          // 服务端说"还没等满"：把剩余时间如实告诉客户端（真实服务端也这样返回 retryAfterMs）
          readyAt = new Date(Date.now() + 15_000).toISOString();
          return json(400, { error: options.confirmError, retryAfterMs: 15_000 });
        }
        // 解冻成功：本月已用 1 次 → 还剩 2 次（上限 3）。这里刻意用"还剩 2"而不是"还剩 1"，
        // 就是为了钉住曾经那个"解冻后又少算一次"的文案 bug。
        return json(200, {
          ok: true,
          member: memberPayload({ ...baseUnfreeze, usedThisMonth: 1, remainingChances: 2, remainingAfterThis: 1 })
            .member,
        });
      }
      if (target.includes("/public/subscriptions/member"))
        // 会员此刻确实还在冻结中（弹窗场景的前提），并带着服务端的 readyAt
        return json(
          200,
          memberPayload(
            options.memberFrozen === false
              ? { ...baseUnfreeze, frozen: false, enabled: false, reason: "not_frozen", readyAt: null }
              : {
                  ...baseUnfreeze,
                  enabled: true,
                  frozen: true,
                  reason: null,
                  readyAt,
                },
          ),
        );
      return json(404, { error: "not_found" });
    }),
  );
  return calls;
}

const Wrapper = defineComponent({
  setup() {
    // 弹窗的打开入口挂在组件实例上（defineExpose），测试通过它驱动
    const modal = ref<{ open: () => void } | null>(null);
    return () =>
      h("div", [
        h("button", { "data-testid": "open", onClick: () => modal.value?.open() }, "申请解冻"),
        h(UnfreezeModal, {
          ref: (instance: unknown) => {
            modal.value = (instance as { open: () => void } | null) ?? null;
          },
        }),
      ]);
  },
});

async function openModal() {
  render(Wrapper);
  await fireEvent.click(screen.getByTestId("open"));
  await vi.advanceTimersByTimeAsync(0);
}

describe("UnfreezeModal 自助解冻弹窗", () => {
  beforeEach(() => {
    resetPortalSession();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("强制显示后台文案 + 倒计时期间按钮点不动", async () => {
    const calls = stubFetch();
    await openModal();

    // 文案来自后台（服务端渲染好的），前端不写死
    expect(screen.getByText(/同时在多台设备播放/)).toBeTruthy();
    expect(screen.getByText(/请阅读以下提示，倒计时结束后才能解冻/)).toBeTruthy();

    const confirm = screen.getByTestId("unfreeze-confirm") as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    expect(confirm.textContent).toContain(`请阅读提示（${WAIT_SECONDS}s）`);

    // 等待期间的前置说明是"本次解冻后还剩"：3 次上限、没用过 → 本次后还剩 2 次
    expect(screen.getByText(/本次解冻后还剩 2 次/)).toBeTruthy();

    // 倒计时中途点一下：不许发解冻请求
    await vi.advanceTimersByTimeAsync(30_000);
    expect(confirm.disabled).toBe(true);
    await fireEvent.click(confirm);
    expect(calls.filter((call) => call.url.endsWith("/member/unfreeze"))).toHaveLength(0);
  });

  it("等满等待秒数后才可确认；确认成功后显示已解冻", async () => {
    const calls = stubFetch();
    await openModal();

    await vi.advanceTimersByTimeAsync(WAIT_SECONDS * 1_000);
    const confirm = screen.getByTestId("unfreeze-confirm") as HTMLButtonElement;
    expect(confirm.disabled).toBe(false);
    expect(confirm.textContent).toContain("确认解冻");

    await fireEvent.click(confirm);
    await vi.advanceTimersByTimeAsync(0);

    const confirmCall = calls.find((call) => call.url.endsWith("/member/unfreeze"));
    expect(confirmCall?.method).toBe("POST");
    expect(screen.getByText(/账号已解冻/)).toBeTruthy();
    expect(screen.getByTestId("unfreeze-finish")).toBeTruthy();
    // 成功文案必须与"已用 1 / 3"自洽：本月还剩 2 次（不是 1 次）
    const done = document.querySelector(".done-meta")?.textContent ?? "";
    expect(done).toContain("已用 1 / 3 次");
    expect(done).toContain("本月还剩 2 次");
  });

  it("服务端说还没等满时不显示成功，继续等并按服务端时刻重算", async () => {
    stubFetch({ confirmError: "wait_not_elapsed" });
    await openModal();

    await vi.advanceTimersByTimeAsync(WAIT_SECONDS * 1_000);
    await fireEvent.click(screen.getByTestId("unfreeze-confirm"));
    await vi.advanceTimersByTimeAsync(0);

    expect(screen.queryByText(/账号已解冻/)).toBeNull();
    expect(screen.getByText("请等待倒计时结束再点确认。")).toBeTruthy();
    // 以服务端给的剩余时间重新拉起倒计时：按钮回到禁用，不是"还能再点"
    const confirm = screen.getByTestId("unfreeze-confirm") as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    expect(confirm.textContent).toContain("请阅读提示（15s）");
  });

  it("失败后已不满足自助解冻条件（冻结到期等）：如实告知并放人走，不锁在弹窗里", async () => {
    stubFetch({ confirmError: "not_frozen", memberFrozen: false });
    await openModal();

    await vi.advanceTimersByTimeAsync(WAIT_SECONDS * 1_000);
    await fireEvent.click(screen.getByTestId("unfreeze-confirm"));
    await vi.advanceTimersByTimeAsync(0);

    expect(screen.getByText("账号当前没有被冻结，无需解冻。")).toBeTruthy();
    // 有「知道了」可以离开（等待期间是没有关闭入口的）
    expect(screen.getByTestId("unfreeze-close")).toBeTruthy();
  });

  it("解冻成功前没有关闭入口（强制显示）", async () => {
    stubFetch();
    await openModal();

    // 等待期间只有「请阅读提示（Ns）」这一个按钮，没有关闭/取消
    expect(screen.queryByTestId("unfreeze-close")).toBeNull();
    expect(screen.queryByTestId("unfreeze-finish")).toBeNull();
  });
});
