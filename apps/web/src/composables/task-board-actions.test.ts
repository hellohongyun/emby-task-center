import { effectScope } from "vue";
import { describe, expect, it, vi } from "vitest";
import type { Task, TmdbMedia } from "../types";
import { useTaskBoardActions } from "./task-board-actions";

const hit = { id: 100, title: "测试电影", mediaType: "movie" } as TmdbMedia;
const task = { id: 3, title: "测试任务", mediaType: "tv" } as Task;
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function setup(actions: Parameters<typeof useTaskBoardActions>[0] = {}, search = vi.fn(async () => [hit])) {
  const scope = effectScope();
  const cancel = vi.fn();
  const refresh = vi.fn();
  const board = scope.run(() => useTaskBoardActions(actions, { search, cancel }, refresh))!;
  return { board, cancel, refresh, stop: () => scope.stop() };
}

describe("task board request lifecycle", () => {
  it("closing and reopening cancels search and ignores old success/finally", async () => {
    const first = deferred<TmdbMedia[]>();
    const second = deferred<TmdbMedia[]>();
    const search = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { board, cancel, stop } = setup({}, search);
    board.openCreate();
    board.query.value = "旧关键词";
    const oldRun = board.search();
    board.drawerOpen.value = false;
    board.openCreate();
    board.query.value = "新关键词";
    const newRun = board.search();
    first.resolve([hit]);
    await oldRun;
    expect(board.results.value).toEqual([]);
    expect(board.searching.value).toBe(true);
    expect(cancel).toHaveBeenCalledTimes(3);
    second.resolve([{ ...hit, id: 200 }]);
    await newRun;
    expect(board.results.value[0]?.id).toBe(200);
    expect(board.searching.value).toBe(false);
    stop();
  });

  it("old search failure cannot add an error to a new rebind drawer", async () => {
    const pending = deferred<TmdbMedia[]>();
    const { board, stop } = setup(
      {},
      vi.fn(() => pending.promise),
    );
    board.openCreate();
    board.query.value = "旧请求";
    const run = board.search();
    board.openRebind(task);
    pending.reject(new Error("请求超时，请稍后重试。"));
    await run;
    expect(board.drawerMessage.value).toBe("");
    expect(board.rebindTarget.value?.id).toBe(3);
    stop();
  });

  it("search timeout is visible and permits a retry", async () => {
    const search = vi.fn().mockRejectedValueOnce(new Error("请求超时，请稍后重试。")).mockResolvedValueOnce([hit]);
    const { board, stop } = setup({}, search);
    board.openCreate();
    board.query.value = "电影";
    await board.search();
    expect(board.drawerMessage.value).toBe("请求超时，请稍后重试。");
    expect(board.searching.value).toBe(false);
    await board.search();
    expect(board.results.value).toHaveLength(1);
    expect(board.drawerMessage.value).toBe("");
    stop();
  });

  it.each(["create", "rebind"] as const)(
    "%s errors are handled and write timeout warns about uncertain result",
    async (mode) => {
      const action = vi
        .fn()
        .mockRejectedValueOnce(new Error("网络断流"))
        .mockResolvedValueOnce({ ok: false, error: "timeout" });
      const { board, refresh, stop } = setup({ createTask: action, rebindTask: action });
      if (mode === "rebind") {
        board.openRebind(task);
        board.pickCandidate(hit);
      } else board.openCreate();
      const run = () => (mode === "create" ? board.create(hit) : board.confirmRebind());
      await expect(run()).resolves.toBeUndefined();
      expect(board.drawerMessage.value).toContain("刷新检查结果");
      expect(board.creating.value || board.rebinding.value).toBe(false);
      await run();
      expect(board.drawerMessage.value).toContain("操作可能已提交");
      expect(board.drawerMessage.value).toContain("刷新检查结果后再重试");
      expect(refresh).not.toHaveBeenCalled();
      stop();
    },
  );

  it("reopening during create ignores old success and does not clear the new busy state", async () => {
    const first = deferred<{ ok: boolean }>();
    const second = deferred<{ ok: boolean }>();
    const createTask = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { board, refresh, stop } = setup({ createTask });
    board.openCreate();
    const oldRun = board.create(hit);
    board.drawerOpen.value = false;
    board.openCreate();
    const newRun = board.create(hit);
    first.resolve({ ok: true });
    await oldRun;
    expect(board.drawerOpen.value).toBe(true);
    expect(board.creating.value).toBe(true);
    expect(refresh).not.toHaveBeenCalled();
    second.resolve({ ok: true });
    await newRun;
    expect(board.drawerOpen.value).toBe(false);
    expect(refresh).toHaveBeenCalledTimes(1);
    stop();
  });

  it("unmount during rebind never refreshes or changes drawer state", async () => {
    const pending = deferred<{ ok: boolean }>();
    const { board, refresh, stop } = setup({ rebindTask: vi.fn(() => pending.promise) });
    board.openRebind(task);
    board.pickCandidate(hit);
    const run = board.confirmRebind();
    stop();
    pending.resolve({ ok: true });
    await run;
    expect(refresh).not.toHaveBeenCalled();
    expect(board.drawerMessage.value).toBe("");
  });

  it("cancelled create is handled silently and restores the button", async () => {
    const { board, refresh, stop } = setup({
      createTask: vi.fn().mockRejectedValue(new DOMException("cancelled", "AbortError")),
    });
    board.openCreate();
    await board.create(hit);
    expect(board.drawerMessage.value).toBe("");
    expect(board.creating.value).toBe(false);
    expect(refresh).not.toHaveBeenCalled();
    stop();
  });

  it("delete completion after unmount does not refresh", async () => {
    const pending = deferred<void>();
    const confirmation = vi.spyOn(window, "confirm").mockReturnValue(true);
    const { board, refresh, stop } = setup({ deleteTask: vi.fn(() => pending.promise) });
    const run = board.removeTask(task);
    stop();
    pending.resolve();
    await run;
    expect(refresh).not.toHaveBeenCalled();
    confirmation.mockRestore();
  });

  it("delete timeout and cancellation settle without misleading errors", async () => {
    const confirmation = vi.spyOn(window, "confirm").mockReturnValue(true);
    const action = vi
      .fn()
      .mockRejectedValueOnce(new Error("请求超时"))
      .mockRejectedValueOnce(new DOMException("cancelled", "AbortError"));
    const { board, refresh, stop } = setup({ deleteTask: action });
    await board.removeTask(task);
    expect(board.actionMessage.value).toContain("操作可能已提交");
    expect(board.deletingId.value).toBeNull();
    await board.removeTask(task);
    expect(board.actionMessage.value).toBe("");
    expect(refresh).not.toHaveBeenCalled();
    stop();
    confirmation.mockRestore();
  });
});
