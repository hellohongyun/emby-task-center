import { render, screen } from "@testing-library/vue";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import LoginGate from "./LoginGate.vue";

describe("LoginGate", () => {
  it("submits a masked shared password", async () => {
    const user = userEvent.setup();
    const login = vi.fn().mockResolvedValue(true);
    render(LoginGate, { props: { login } });

    const username = screen.getByLabelText("管理员账号");
    expect(username).toHaveAttribute("autocomplete", "username");
    const password = screen.getByLabelText("管理员口令");
    expect(password).toHaveAttribute("type", "password");

    await user.type(password, "family-password");
    await user.click(screen.getByRole("button", { name: "进入任务中心" }));

    // 用户名随表单一起提交（默认 admin），密码管理器也能识别这两个字段
    expect(login).toHaveBeenCalledWith("family-password", "admin");
    expect(screen.getByText(/默认账号是 admin \/ admin123/)).toBeInTheDocument();
  });

  it("renders a failed-login error from the parent", async () => {
    render(LoginGate, { props: { login: vi.fn(), error: "管理员口令不正确。" } });

    expect(screen.getByRole("alert")).toHaveTextContent("管理员口令不正确");
  });

  it("clears the password field after a failed attempt", async () => {
    const user = userEvent.setup();
    const login = vi.fn().mockResolvedValue(false);
    render(LoginGate, { props: { login } });

    const username = screen.getByLabelText("管理员账号");
    expect(username).toHaveAttribute("autocomplete", "username");
    const password = screen.getByLabelText("管理员口令");
    await user.type(password, "wrong-password");
    await user.click(screen.getByRole("button", { name: "进入任务中心" }));

    expect(login).toHaveBeenCalledWith("wrong-password", "admin");
    expect(password).toHaveValue("");
  });

  it("disables the submit button while verifying", async () => {
    const user = userEvent.setup();
    let resolveLogin: (value: boolean) => void = () => {};
    const login = vi.fn().mockReturnValue(
      new Promise<boolean>((resolve) => {
        resolveLogin = resolve;
      }),
    );
    render(LoginGate, { props: { login } });

    await user.type(screen.getByLabelText("管理员口令"), "family-password");
    const submit = screen.getByRole("button", { name: "进入任务中心" });
    await user.click(submit);

    expect(screen.getByRole("button", { name: "验证中…" })).toBeDisabled();
    resolveLogin(true);
  });
});
