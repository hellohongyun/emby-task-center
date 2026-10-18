import { nextTick } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useDialogFocus } from "./useDialogFocus";

afterEach(() => {
  document.body.innerHTML = "";
});

describe("useDialogFocus", () => {
  it("focuses, traps, closes, and restores a modal surface", async () => {
    document.body.innerHTML =
      '<button id="opener">Open</button><section><button id="first">First</button><button id="last">Last</button></section>';
    const opener = document.querySelector<HTMLButtonElement>("#opener")!;
    const surface = document.querySelector<HTMLElement>("section")!;
    const first = document.querySelector<HTMLButtonElement>("#first")!;
    const last = document.querySelector<HTMLButtonElement>("#last")!;
    const close = vi.fn();
    opener.focus();
    const focus = useDialogFocus(close);
    focus.surface.value = surface;

    focus.activate();
    await nextTick();
    expect(first).toHaveFocus();
    last.focus();
    focus.onKeydown(new KeyboardEvent("keydown", { key: "Tab" }));
    expect(first).toHaveFocus();
    focus.onKeydown(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(close).toHaveBeenCalledOnce();
    focus.deactivate();
    expect(opener).toHaveFocus();
  });
});
