import { effectScope, ref } from "vue";
import { afterEach, expect, it, vi } from "vitest";
import { useVirtualNameQueue } from "./useVirtualNameQueue";

const scopes: ReturnType<typeof effectScope>[] = [];
afterEach(() => scopes.splice(0).forEach((scope) => scope.stop()));
function setup() {
  const picker = {
    selectedId: ref("library-a"),
    searchTerm: ref(""),
    selectedItems: ref<string[]>([]),
    saving: ref(false),
    sourceLoading: ref(false),
    loadSources: vi.fn(async (_reset?: boolean) => {}),
    addItems: vi.fn<() => Promise<boolean | undefined>>().mockResolvedValue(true),
  };
  const scope = effectScope();
  scopes.push(scope);
  const queue = scope.run(() => useVirtualNameQueue(picker))!;
  return { picker, queue };
}

it("searches one name at a time and preserves duplicate lines and source selection behavior", async () => {
  const { picker, queue } = setup();
  await queue.start([" 电影甲 ", "", "电影乙", "电影甲"]);
  expect(picker.searchTerm.value).toBe("电影甲");
  expect(picker.loadSources).toHaveBeenCalledExactlyOnceWith(true);
  expect(picker.addItems).not.toHaveBeenCalled();
  picker.selectedItems.value = ["version-a", "version-b"];
  await queue.add();
  expect(picker.addItems).toHaveBeenCalledTimes(1);
  expect(picker.searchTerm.value).toBe("电影乙");
  expect(picker.selectedItems.value).toEqual([]);
  await queue.next();
  expect(picker.searchTerm.value).toBe("电影甲");
  expect(picker.addItems).toHaveBeenCalledTimes(1);
  await queue.next();
  expect(queue.index.value).toBe(3);
  expect(picker.loadSources).toHaveBeenCalledTimes(3);
});

it("keeps the current name and selection on an add failure", async () => {
  const { picker, queue } = setup();
  await queue.start(["甲", "乙"]);
  picker.selectedItems.value = ["chosen"];
  picker.addItems.mockResolvedValue(undefined);
  expect(await queue.add()).toBe(false);
  expect(queue.index.value).toBe(0);
  expect(picker.searchTerm.value).toBe("甲");
  expect(picker.selectedItems.value).toEqual(["chosen"]);
  expect(picker.loadSources).toHaveBeenCalledTimes(1);
});

it("does not advance an obsolete queue when libraries change during an add", async () => {
  const { picker, queue } = setup();
  let resolve!: (value: boolean) => void;
  picker.addItems.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  await queue.start(["甲", "乙"]);
  const adding = queue.add();
  expect(queue.busy.value).toBe(true);
  await queue.next();
  expect(queue.index.value).toBe(0);
  picker.selectedId.value = "library-b";
  expect(queue.names.value).toEqual([]);
  resolve(true);
  await adding;
  expect(queue.names.value).toEqual([]);
  expect(picker.loadSources).toHaveBeenCalledTimes(1);
});

it("leaves ordinary manual adds unchanged and stopping never removes associations", async () => {
  const { picker, queue } = setup();
  picker.searchTerm.value = "手动搜索";
  expect(await queue.add()).toBe(true);
  expect(picker.searchTerm.value).toBe("手动搜索");
  expect(picker.loadSources).not.toHaveBeenCalled();
  await queue.start(["甲", "乙"]);
  queue.stop();
  expect(queue.names.value).toEqual([]);
  expect(picker.addItems).toHaveBeenCalledTimes(1);
});

it("prevents replacing an active queue or advancing while a search is loading", async () => {
  const { picker, queue } = setup();
  await queue.start(["甲", "乙"]);
  await queue.start(["别的名单"]);
  expect(queue.names.value).toEqual(["甲", "乙"]);
  picker.sourceLoading.value = true;
  await queue.next();
  expect(await queue.add()).toBe(false);
  expect(queue.index.value).toBe(0);
});
