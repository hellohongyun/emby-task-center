import { fireEvent, render, screen } from "@testing-library/vue";
import { describe, expect, it } from "vitest";
import LibraryView from "./LibraryView.vue";
import { libraryFixture } from "../test/library-fixture";

const flush = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};

describe("LibraryView request disposal", () => {
  it.each(["立即扫描", "补齐未匹配"])(
    "does not refresh or update shared state after leaving during %s",
    async (name) => {
      const { library, fetchImpl } = libraryFixture();
      const original = fetchImpl.getMockImplementation()!;
      let finish!: (response: Response) => void;
      fetchImpl.mockImplementation((input) => {
        if (String(input).includes("/scan") || String(input).includes("/match-unresolved"))
          return new Promise<Response>((resolve) => {
            finish = resolve;
          });
        return original(input);
      });
      const view = render(LibraryView, { props: { library } });
      await screen.findByRole("button", { name: "查看 仙逆" });
      await fireEvent.click(screen.getByRole("button", { name }));
      expect(fetchImpl).toHaveBeenCalledTimes(3);
      view.unmount();
      await flush();
      finish(Response.json({ matchedGroups: 2, linkedLibraryItems: 3, cleaned: 0 }));
      await flush();
      expect(fetchImpl).toHaveBeenCalledTimes(3);
      expect(library.error.value).toBe("");
      expect(library.scanningRootId.value).toBeNull();
      expect(library.summaryLoading.value).toBe(false);
    },
  );
});
