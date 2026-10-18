import { describe, expect, it } from "vitest";
import { createDatabase } from "@emby-task-center/database/client";
import { createTask } from "@emby-task-center/task-domain/task-service";
import { readTaskAliases, saveTaskAliases } from "./task-settings";

// 任务收件人的增删改查随「任务更新通知」整条链删除（2026-09）：那条邮件链已无发送方，
// 这里只剩"别名"（它服务的是片源匹配，仍然活着）。
describe("task settings (aliases)", () => {
  it("reads and saves task aliases", () => {
    const handle = createDatabase(":memory:");
    const task = createTask(handle.db, { mediaType: "tv", taskType: "ingest", title: "斗破苍穹", tmdbId: 5 });
    const saved = saveTaskAliases(handle.db, task.id, ["斗破苍穹年番", " 斗破苍穹年番 "]);
    expect(saved).toEqual(["斗破苍穹年番"]);
    expect(readTaskAliases(handle.db, task.id)).toEqual(["斗破苍穹年番"]);
    handle.close();
  });
});
