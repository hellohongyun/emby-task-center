import BetterSqlite3 from "better-sqlite3";
import { seedMarketMembers } from "./market-fixture";
import { startEmbyFixture } from "./real-upstream";

export const previewLibrary = { id: "preview-market-library", name: "本地头像与详情精选" };
export const privateLibrary = "private-preview-library";
const pixel = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jGZkAAAAASUVORK5CYII=",
  "base64",
);

export function seedPreviewDatabase(path: string) {
  seedMarketMembers(path);
  const db = new BetterSqlite3(path, { fileMustExist: true });
  try {
    db.prepare("UPDATE submission_users SET qq_number = '123456789' WHERE email = ?").run("market-owner@example.test");
    const owner = db.prepare("SELECT id FROM submission_users WHERE email = ?").get("market-owner@example.test") as {
      id: number;
    };
    const now = new Date().toISOString();
    const insert = db.prepare(
      "INSERT INTO virtual_libraries (id,owner_member_id,published,publication_version,name,collection_type,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)",
    );
    insert.run(previewLibrary.id, owner.id, 1, 1, previewLibrary.name, "mixed", now, now);
    insert.run(privateLibrary, owner.id, 0, 0, "私人库不得预览", "mixed", now, now);
    const item = db.prepare(
      "INSERT INTO virtual_library_items (library_id,item_id,name,type,year,image_tag,position) VALUES (?,?,?,?,?,?,?)",
    );
    for (let index = 0; index < 43; index++)
      item.run(
        previewLibrary.id,
        `preview-film-${index}`,
        `本地影片 ${String(index).padStart(2, "0")}`,
        index % 2 ? "Series" : "Movie",
        2020 + (index % 5),
        `poster-${index}`,
        index,
      );
    item.run(privateLibrary, "private-film", "私有影片", "Movie", 2025, "private-tag", 0);
  } finally {
    db.close();
  }
}

export function startPreviewFixture() {
  return startEmbyFixture({
    handle(_request, response, _url, path) {
      if (path === "/Users/other-user/Views" || path === "/Users/other-user/Items") {
        response
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ Items: [], TotalRecordCount: 0 }));
        return true;
      }
      if (path === "/qq-avatar/g" || /^\/Items\/(preview-film-\d+|private-film)\/Images\/Primary$/.test(path)) {
        response.writeHead(200, { "content-type": "image/png" }).end(pixel);
        return true;
      }
      return false;
    },
  });
}
