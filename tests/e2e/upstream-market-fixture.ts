import { startEmbyFixture } from "./real-upstream";
import { marketEmails } from "./market-fixture";
import { DEFAULT_LIBRARY_POSTER_PNG_BASE64 } from "@emby-task-center/contracts/library-poster-png";

const native = { Id: "fixture-movies", Name: "隔离测试电影库", Type: "CollectionFolder", IsFolder: true };
const collections = { Id: "native-collections", Name: "Emby 合集", Type: "CollectionFolder", IsFolder: true };
export const upstreamMarketLibraries = [
  {
    Id: "ttd-science",
    Guid: "ttd-science-guid",
    Name: "TgtoDrive 科幻精选",
    Type: "CollectionFolder",
    IsFolder: true,
    CollectionType: "movies",
    ImageTags: { Primary: "ttd-cover" },
    Ttd: { opaque: "preserve" },
  },
  {
    Id: "ttd-series",
    Guid: "ttd-series-guid",
    Name: "TgtoDrive 剧集精选",
    Type: "CollectionFolder",
    IsFolder: true,
    CollectionType: "tvshows",
    ImageTags: {},
  },
];

/** Two distinct HTTP origins represent one Emby server, with optional TTD injection. */
export function startUpstreamMarketFixture(injected: boolean) {
  return startEmbyFixture({
    handle(request, response, url, path) {
      const send = (body: unknown, status = 200) =>
        response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
      const userId =
        /^\/Users\/([^/]+)/.exec(path)?.[1] ??
        url.searchParams.get("UserId") ??
        (request.headers["x-emby-token"] === "other-token" ? "other-user" : "fixture-user");
      const entries = [
        native,
        collections,
        ...(injected
          ? upstreamMarketLibraries.filter((item) => userId !== "other-user" || item.Id === "ttd-series")
          : []),
      ];
      if (request.method === "POST" && path === "/Users/AuthenticateByName") {
        let raw = "";
        request.on("data", (chunk) => {
          raw += chunk;
        });
        request.once("end", () => {
          const body = JSON.parse(raw);
          const index = marketEmails.indexOf(body.Username);
          if (index < 0 || body.Pw !== "fixture-password") send({ error: "unauthorized" }, 401);
          else
            send({
              AccessToken: index ? "other-token" : "owner-token",
              User: { Id: index ? "other-user" : "fixture-user" },
            });
        });
        return true;
      }
      if (path === "/System/Info/Public") {
        send({ Id: "fixture-server" });
        return true;
      }
      if (path === "/Users/Query") {
        send({
          Items: marketEmails.map((Name, i) => ({ Name, Id: i ? "other-user" : "fixture-user" })),
          TotalRecordCount: 2,
        });
        return true;
      }
      if (/^\/Users\/(fixture-user|other-user)$/.test(path)) {
        send({ Id: userId, Name: userId, Configuration: { OrderedViews: [native.Id], MyMediaExcludes: [] } });
        return true;
      }
      if (/\/Views$/.test(path) || path === "/Library/MediaFolders") {
        const offset = Number(url.searchParams.get("StartIndex") ?? 0);
        const limit = Number(url.searchParams.get("Limit") ?? 200);
        send({ Items: entries.slice(offset, offset + limit), TotalRecordCount: entries.length });
        return true;
      }
      if (
        /^\/(?:Users\/[^/]+\/)?Items$/.test(path) &&
        url.searchParams.get("IncludeItemTypes") === "CollectionFolder"
      ) {
        send({ Items: [native, collections], TotalRecordCount: 2 });
        return true;
      }
      const poster = /^\/Items\/(ttd-science|ttd-series)\/Images\/Primary/.exec(path);
      if (poster) {
        response
          .writeHead(200, { "content-type": "image/png" })
          .end(Buffer.from(DEFAULT_LIBRARY_POSTER_PNG_BASE64, "base64"));
        return true;
      }
      const detail = /^\/(?:Users\/[^/]+\/)?Items\/(ttd-science|ttd-series)\/?$/.exec(path);
      if (detail) {
        send(
          entries.find((item) => item.Id === detail[1]) ?? {},
          entries.some((item) => item.Id === detail[1]) ? 200 : 404,
        );
        return true;
      }
      if (/^\/(?:Users\/[^/]+\/)?Items$/.test(path) && url.searchParams.get("ParentId")?.startsWith("ttd-")) {
        const allowed = entries.some((item) => item.Id === url.searchParams.get("ParentId"));
        send({
          Items: allowed ? [{ Id: "fixture-movie", Name: "隔离测试电影", Type: "Movie" }] : [],
          TotalRecordCount: allowed ? 1 : 0,
        });
        return true;
      }
      return false;
    },
  });
}
