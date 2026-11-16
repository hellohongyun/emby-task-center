import BetterSqlite3 from "better-sqlite3";
import { startEmbyFixture } from "./real-upstream";
const moviePoster = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jGZkAAAAASUVORK5CYII=",
  "base64",
);

export const marketEmails = ["market-owner@example.test", "market-other@example.test"];
export function seedMarketMembers(databasePath: string) {
  const db = new BetterSqlite3(databasePath, { fileMustExist: true });
  try {
    const now = new Date().toISOString();
    for (const [i, email] of marketEmails.entries()) {
      db.prepare(
        "INSERT INTO submission_users (email,emby_user_id,emby_username,created_at,updated_at) VALUES (?,?,?,?,?)",
      ).run(email, i ? "other-user" : "fixture-user", email, now, now);
      db.prepare("INSERT INTO verification_codes (email,code,expires_at,created_at) VALUES (?,?,?,?)").run(
        email,
        "314159",
        new Date(Date.now() + 600_000).toISOString(),
        now,
      );
    }
  } finally {
    db.close();
  }
}
export function startMarketFixture(options: { emails?: string[]; missingEpisodes?: boolean } = {}) {
  const emails = options.emails ?? marketEmails;
  return startEmbyFixture({
    handle(request, response, url, path) {
      const send = (body: unknown) =>
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
      if (path === "/Items/fixture-movie/Images/Primary") {
        response.writeHead(200, { "content-type": "image/png" }).end(moviePoster);
        return true;
      }
      if (request.method === "POST" && path === "/Users/AuthenticateByName") {
        let raw = "";
        request.on("data", (c) => (raw += c));
        request.once("end", () => {
          const credentials = JSON.parse(raw);
          const index = emails.indexOf(credentials.Username);
          if (index < 0 || credentials.Pw !== "fixture-password") response.writeHead(401).end();
          else
            send({
              AccessToken: index ? "other-token" : "owner-token",
              User: { Id: index ? "other-user" : "fixture-user" },
            });
        });
        return true;
      }
      if (path === "/Users/Query") {
        send({
          Items: emails.map((Name, i) => ({
            Name,
            Id: i ? "other-user" : "fixture-user",
            Policy: { IsAdministrator: false },
          })),
          TotalRecordCount: 2,
        });
        return true;
      }
      if (path === "/Users/other-user") {
        send({ Id: "other-user", Configuration: { OrderedViews: ["fixture-movies"], MyMediaExcludes: [] } });
        return true;
      }
      if (path === "/Users/other-user/Views") {
        send({
          Items: [{ Id: "fixture-movies", Name: "隔离测试电影库", Type: "CollectionFolder", IsFolder: true }],
          TotalRecordCount: 1,
        });
        return true;
      }
      if (path === "/Users/other-user/Items") {
        const items =
          url.searchParams.get("Ids")?.includes("fixture-movie") ||
          url.searchParams.get("ParentId") === "fixture-movies"
            ? [
                {
                  Id: "fixture-movie",
                  Name: "隔离测试电影",
                  Type: "Movie",
                  ProductionYear: 2025,
                  ProviderIds: {},
                  ImageTags: {},
                },
              ]
            : [];
        send({ Items: items, TotalRecordCount: items.length });
        return true;
      }
      return false;
    },
  });
}
