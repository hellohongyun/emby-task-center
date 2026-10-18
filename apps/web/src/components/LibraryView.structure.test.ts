import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { render, screen } from "@testing-library/vue";
import { describe, expect, it } from "vitest";
import LibraryView from "./LibraryView.vue";
import { libraryFixture } from "../test/library-fixture";

/** 更新分页媒体库结构时显式设置 UPDATE_LIBRARY_SKELETON=1。 */
function skeleton(html: string): string {
  return html
    .replace(/ data-v-[a-z0-9]+=""/g, "")
    .replace(/<svg\b[^>]*>.*?<\/svg>/g, "<svg/>")
    .replace(/\s+/g, " ")
    .replace(/> </g, "><")
    .trim();
}
describe("LibraryView structure", () => {
  it("keeps the paged view DOM skeleton stable", async () => {
    const { library } = libraryFixture();
    const { container } = render(LibraryView, { props: { library } });
    await screen.findByRole("button", { name: "查看 仙逆" });
    const actual = skeleton(container.innerHTML);
    const goldenPath = resolve(process.cwd(), "src/components/__fixtures__/library-view.skeleton.txt");
    if (!existsSync(goldenPath) || process.env.UPDATE_LIBRARY_SKELETON === "1") {
      writeFileSync(goldenPath, actual + "\n", "utf8");
    }
    expect(actual).toBe(readFileSync(goldenPath, "utf8").trim());
  });
});
