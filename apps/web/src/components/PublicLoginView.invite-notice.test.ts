import { fireEvent, render, screen, waitFor } from "@testing-library/vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetPortalSession } from "../composables/usePortalSession";
import PublicLoginView from "./PublicLoginView.vue";

describe("注册入群提示配置", () => {
  beforeEach(() => resetPortalSession());
  afterEach(() => vi.unstubAllGlobals());

  it.each(["请加入 92345678\n<script>自定义提示</script>", null, ""])(
    "根据接口显示或隐藏提示，始终保留邀请码校验：%s",
    async (notice) => {
      const fetchMock = vi.fn(async (url: string | URL | Request) => {
        const target = String(url);
        let body: unknown = {};
        if (target.endsWith("/entry")) {
          body = {
            registered: false,
            needsCard: true,
            expired: false,
            groupInvite: { groupNumber: "92345678", notice },
          };
        } else if (target.endsWith("/card/check")) {
          body = { ok: true, registered: false, needsCard: true, expired: false };
        } else if (target.endsWith("/code")) {
          body = { sent: true, registered: false, needsCard: true, expired: false };
        }
        return new Response(JSON.stringify(body), { status: 200 });
      });
      vi.stubGlobal("fetch", fetchMock);
      const { container } = render(PublicLoginView);
      await fireEvent.update(screen.getByPlaceholderText("you@example.com"), "123456789@qq.com");
      await fireEvent.click(screen.getByRole("button", { name: "下一步" }));
      const invite = await screen.findByLabelText("群邀请码");

      if (notice) {
        expect(container.querySelector("#registration-group-help")?.textContent).toBe(notice);
        expect(invite).toHaveAttribute("aria-describedby", "registration-group-help");
        expect(container.querySelector("script")).toBeNull();
      } else {
        expect(container.querySelector("#registration-group-help")).toBeNull();
        expect(invite).not.toHaveAttribute("aria-describedby");
      }
      expect(screen.getByRole("button", { name: "复制群号" })).toBeTruthy();
      await fireEvent.update(screen.getByPlaceholderText("月卡 / 年卡 / 试用卡"), "CARDAAAA1111");
      await fireEvent.click(screen.getByRole("button", { name: "验证卡密" }));
      await screen.findByRole("button", { name: "卡密已验证" });
      const send = screen.getByRole("button", { name: "发送验证码" });
      expect(send).toBeDisabled();
      await fireEvent.update(invite, "Invite_2026");
      expect(send).not.toBeDisabled();
      await fireEvent.click(send);
      await waitFor(() =>
        expect(fetchMock).toHaveBeenCalledWith(
          expect.stringContaining("/subscriptions/code"),
          expect.objectContaining({ body: expect.stringContaining('"inviteCode":"Invite_2026"') }),
        ),
      );
    },
  );
});
