import { fireEvent, render, screen } from "@testing-library/vue";
import { expect, it } from "vitest";
import VirtualLibraryForm from "./VirtualLibraryForm.vue";
import VirtualLibraryItems from "./VirtualLibraryItems.vue";
import VirtualSourcePicker from "./VirtualSourcePicker.vue";

const movie = { itemId: "42", name: "周末电影", type: "Movie", year: 2026, imageTag: null };
const series = { ...movie, itemId: "43", name: "周末剧集", type: "Series" };

it("keeps incompatible source content visible with a disabled checkbox and explanation", async () => {
  const view = render(VirtualSourcePicker, {
    props: {
      collectionType: "tvshows",
      items: [movie, series],
      roots: [],
      selected: [],
      added: new Set<string>(),
      search: "",
      parent: "",
      loading: false,
      busy: false,
      total: 2,
      start: 0,
      limit: 24,
    },
  });
  expect(screen.getByRole("checkbox", { name: "选择 周末电影" })).toBeDisabled();
  expect(screen.getByText(/《周末电影》.*不兼容/)).toHaveTextContent("混合库");
  expect(screen.getByRole("checkbox", { name: "选择 周末剧集" })).toBeEnabled();
  await view.rerender({ collectionType: "movies" });
  expect(screen.getByRole("checkbox", { name: "选择 周末电影" })).toBeEnabled();
  expect(screen.getByRole("checkbox", { name: "选择 周末剧集" })).toBeDisabled();
  await view.rerender({ collectionType: "mixed" });
  expect(screen.getByRole("checkbox", { name: "选择 周末电影" })).toBeEnabled();
  expect(screen.getByRole("checkbox", { name: "选择 周末剧集" })).toBeEnabled();
});

it("offers only movies and whole series even if a source response includes seasons, episodes or people", () => {
  render(VirtualSourcePicker, {
    props: {
      collectionType: "tvshows",
      items: [
        movie,
        series,
        { ...movie, itemId: "season", name: "第一季", type: "Season" },
        { ...movie, itemId: "episode", name: "第一集", type: "Episode" },
        { ...movie, itemId: "person", name: "演员", type: "Person" },
      ],
      roots: [],
      selected: [],
      added: new Set<string>(),
      search: "",
      parent: "",
      loading: false,
      busy: false,
      total: 5,
      start: 0,
      limit: 24,
    },
  });
  expect(screen.getAllByRole("checkbox")).toHaveLength(2);
  expect(screen.queryByText("第一季")).not.toBeInTheDocument();
  expect(screen.queryByText("第一集")).not.toBeInTheDocument();
  expect(screen.queryByText("演员")).not.toBeInTheDocument();
  expect(screen.getByText(/不单独选择季和分集/)).toBeInTheDocument();
  expect(screen.getByText(/^剧集库只允许加入整部剧/)).toBeInTheDocument();
});

it("keeps existing season and episode mappings visible", () => {
  render(VirtualLibraryItems, {
    props: {
      collectionType: "tvshows",
      items: [
        { ...movie, itemId: "season", name: "第一季", type: "Season" },
        { ...movie, itemId: "episode", name: "第一集", type: "Episode" },
      ],
      loading: false,
      busy: false,
    },
  });
  expect(screen.getByText("第一季")).toBeInTheDocument();
  expect(screen.getByText("第一集")).toBeInTheDocument();
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("warns about existing mismatched mappings without removing them", () => {
  render(VirtualLibraryItems, { props: { collectionType: "tvshows", items: [movie], loading: false, busy: false } });
  expect(screen.getByRole("alert")).toHaveTextContent("有 1 项内容与当前剧集库类型不兼容");
  expect(screen.getByRole("alert")).toHaveTextContent("《周末电影》");
  expect(screen.getByRole("alert")).toHaveTextContent("混合");
  expect(screen.getByRole("button", { name: "从虚拟库移除 周末电影" })).toBeEnabled();
});

it("blocks incompatible type changes before save and allows mixed", async () => {
  const view = render(VirtualLibraryForm, {
    props: {
      initial: { name: "精选", collectionType: "mixed", sortOrder: 0 },
      editing: true,
      busy: false,
      items: [movie],
      itemsLoading: false,
    },
  });
  expect(screen.getByText(/显示类型会影响客户端筛选/)).toBeInTheDocument();
  await fireEvent.update(screen.getByRole("combobox", { name: "显示类型" }), "tvshows");
  expect(screen.getByRole("button", { name: "保存媒体库" })).toBeDisabled();
  expect(screen.getByRole("alert")).toHaveTextContent("无法切换到此类型");
  await fireEvent.submit(view.container.querySelector("form")!);
  expect(view.emitted().save).toBeUndefined();
  await fireEvent.update(screen.getByRole("combobox", { name: "显示类型" }), "mixed");
  await fireEvent.click(screen.getByRole("button", { name: "保存媒体库" }));
  expect(view.emitted().save).toEqual([[{ name: "精选", collectionType: "mixed", sortOrder: 0 }]]);
});

it("allows renaming a legacy mismatched library without changing its type", async () => {
  const view = render(VirtualLibraryForm, {
    props: {
      initial: { name: "旧库", collectionType: "tvshows", sortOrder: 0 },
      editing: true,
      busy: false,
      items: [movie],
      itemsLoading: false,
    },
  });
  await fireEvent.update(screen.getByRole("textbox", { name: "媒体库名称" }), "新库名");
  await fireEvent.click(screen.getByRole("button", { name: "保存媒体库" }));
  expect(view.emitted().save).toEqual([[{ name: "新库名", collectionType: "tvshows", sortOrder: 0 }]]);
});

it("waits for existing mappings before checking a changed library type", async () => {
  render(VirtualLibraryForm, {
    props: {
      initial: { name: "精选", collectionType: "mixed", sortOrder: 0 },
      editing: true,
      busy: false,
      items: [],
      itemsLoading: true,
    },
  });
  await fireEvent.update(screen.getByRole("combobox", { name: "显示类型" }), "movies");
  expect(screen.getByRole("status")).toHaveTextContent("正在检查已加入内容");
  expect(screen.getByRole("button", { name: "保存媒体库" })).toBeDisabled();
});
