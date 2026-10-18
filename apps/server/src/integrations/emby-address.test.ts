import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDatabase, type DatabaseHandle } from "@emby-task-center/database/client";
import { writeSettings } from "../settings/store";
import { EMBY_SERVER_ADDRESS_TOKEN, embyServerAddress, renderArticleContent } from "./emby-address";

/**
 * 平台须知里的服务器地址不能硬编码：正文用 {{embyServerAddress}} 占位，
 * 对外返回时替换成后台配置的 Emby 地址。
 */
describe("emby server address placeholder", () => {
  let directory: string;
  let database: DatabaseHandle;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "emby-address-"));
    database = createDatabase(join(directory, "app.sqlite"));
  });

  afterEach(() => {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("renders the token with the configured Emby address", () => {
    writeSettings(database.db, { "emby.baseUrl": "https://emby.example.invalid" });
    expect(embyServerAddress(database.db)).toBe("https://emby.example.invalid");
    expect(
      renderArticleContent(`2. 服务器地址：${EMBY_SERVER_ADDRESS_TOKEN}（端口 443）；`, embyServerAddress(database.db)),
    ).toBe("2. 服务器地址：https://emby.example.invalid（端口 443）；");
  });

  it("falls back to a hint when no Emby address is configured", () => {
    // 连 Emby 地址都没配才提示联系管理员，且文案里不出现内部端口
    const hint = embyServerAddress(database.db);
    expect(hint).toBe("请联系管理员获取 Emby 服务器地址");
    expect(hint).not.toMatch(/:\d{4}/);
  });

  it("leaves articles without the token untouched", () => {
    expect(renderArticleContent("没有任何占位符的正文")).toBe("没有任何占位符的正文");
  });
});
