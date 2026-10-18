import { nextTick, ref } from "vue";

const focusableSelector = [
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "a[href]",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

export function useDialogFocus(close: () => void) {
  const surface = ref<HTMLElement | null>(null);
  let previousFocus: HTMLElement | null = null;

  function focusable(): HTMLElement[] {
    return Array.from(surface.value?.querySelectorAll<HTMLElement>(focusableSelector) ?? []);
  }

  function activate() {
    previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    void nextTick(() => (focusable()[0] ?? surface.value)?.focus());
  }

  function deactivate() {
    previousFocus?.focus();
    previousFocus = null;
  }

  function onKeydown(event: KeyboardEvent) {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if (event.key !== "Tab") return;
    const elements = focusable();
    if (!elements.length) return;
    const first = elements[0]!;
    const last = elements[elements.length - 1]!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return { surface, activate, deactivate, onKeydown };
}
