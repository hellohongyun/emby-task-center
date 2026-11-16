import { fireEvent, render, screen } from "@testing-library/vue";
import { expect, it } from "vitest";
import { DEFAULT_LIBRARY_POSTER_URL } from "@emby-task-center/contracts/library-poster";
import VirtualLibraryCover from "./VirtualLibraryCover.vue";

it("shows built-in artwork without an uploaded poster", () => {
  render(VirtualLibraryCover, { props: { name: "我的精选" } });
  expect(screen.getByRole("img", { name: "我的精选媒体库海报" })).toHaveAttribute("src", DEFAULT_LIBRARY_POSTER_URL);
});

it("falls back on load failure and retries a changed uploaded poster", async () => {
  const view = render(VirtualLibraryCover, { props: { name: "精选", src: "/cover?tag=old" } });
  const image = screen.getByRole("img");
  expect(image).toHaveAttribute("src", "/cover?tag=old");
  await fireEvent.error(image);
  expect(image).toHaveAttribute("src", DEFAULT_LIBRARY_POSTER_URL);
  await view.rerender({ src: "/cover?tag=new" });
  expect(image).toHaveAttribute("src", "/cover?tag=new");
  await view.rerender({ src: undefined });
  expect(image).toHaveAttribute("src", DEFAULT_LIBRARY_POSTER_URL);
});
