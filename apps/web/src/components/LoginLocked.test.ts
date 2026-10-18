import { render, screen } from "@testing-library/vue";
import { afterEach, describe, expect, it, vi } from "vitest";

import LoginLocked from "./LoginLocked.vue";

describe("LoginLocked", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows the remaining lock time and emits unlock when it expires", async () => {
    vi.useFakeTimers();
    const { emitted } = render(LoginLocked, { props: { retryAfterSeconds: 65 } });

    expect(screen.getByRole("heading", { name: "尝试次数过多" })).toBeInTheDocument();
    expect(screen.getByText("1 分 5 秒")).toBeInTheDocument();

    await vi.advanceTimersByTimeAsync(65_000);

    expect(emitted().unlock).toBeTruthy();
  });
});
