import { startEmbyFixture } from "./real-upstream";

export const orderViews = {
  movies: { Id: "order-movies", Guid: "a".repeat(32), Name: "联动电影库" },
  series: { Id: "order-series", Guid: "b".repeat(32), Name: "联动剧集库" },
  hidden: { Id: "order-hidden", Guid: "c".repeat(32), Name: "隐藏原生库" },
  injected: { Id: "order-trending", Guid: "d".repeat(32), Name: "TgtoDrive 注入榜单" },
};

const { movies, series, hidden, injected } = orderViews;
const native = [movies, series, hidden];
const accounts = [
  { Id: "order-admin", Name: "排序管理员", Policy: { IsAdministrator: true } },
  { Id: "order-member", Name: "排序会员", Policy: { IsAdministrator: false } },
  { Id: "order-limited", Name: "限权会员", Policy: { IsAdministrator: false } },
];

export function startLibraryOrderUpstreams() {
  const preferences = new Map(
    accounts.map(({ Id }) => [
      Id,
      {
        OrderedViews: Id === "order-limited" ? [movies.Guid] : native.map(({ Guid }) => Guid),
        MyMediaExcludes: [hidden.Guid],
        AudioLanguagePreference: "zho",
      },
    ]),
  );
  const writes: Array<{ id: string; viaTgtoDrive: boolean; body: unknown }> = [];
  let failTgtoDrive = false;

  const open = (viaTgtoDrive: boolean) =>
    startEmbyFixture({
      handle(request, response, url, path) {
        const userPath = /^\/Users\/([^/]+)(\/.*)?$/.exec(path);
        const account = accounts.find(({ Id }) => Id === userPath?.[1]);
        if (!account && !["/Users", "/Library/VirtualFolders", "/Library/MediaFolders"].includes(path)) {
          return false;
        }
        const send = (body: unknown, status = 200) => {
          response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
          return true;
        };
        const token = request.headers["x-emby-token"];
        const adminKey = token === "local-fixture-only";
        if (!adminKey && (!account || token !== `${account.Id}-token`)) return send({}, 401);
        if (viaTgtoDrive && failTgtoDrive) return send({}, 503);
        if (path === "/Users") return send(accounts);
        if (path === "/Library/VirtualFolders") {
          return send(native.map(({ Id, Name }) => ({ ItemId: Id, Name, CollectionType: "movies", Locations: [] })));
        }
        const dto = (view: (typeof native)[number]) => ({ ...view, Type: "CollectionFolder", IsFolder: true });
        if (path === "/Library/MediaFolders") {
          return send({ Items: (viaTgtoDrive ? [injected, ...native] : native).map(dto) });
        }
        if (!account) return send({}, 404);
        const configuration = preferences.get(account.Id)!;
        if (!userPath?.[2]) return send({ ...account, Configuration: configuration });
        if (userPath[2] === "/Configuration/Partial" && request.method === "POST") {
          const chunks: Buffer[] = [];
          request.on("data", (chunk: Buffer) => chunks.push(chunk));
          request.once("end", () => {
            try {
              const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { OrderedViews: string[] };
              writes.push({ id: account.Id, viaTgtoDrive, body });
              configuration.OrderedViews = body.OrderedViews.filter((id) => native.some(({ Guid }) => Guid === id));
              response.writeHead(204).end();
            } catch {
              response.writeHead(400).end();
            }
          });
          return true;
        }
        if (userPath[2] !== "/Views") return send({}, 404);
        const visible = account.Id === "order-limited" ? [movies] : [movies, series];
        if (account.Id !== "order-limited" && url.searchParams.get("IncludeHidden") === "true") visible.push(hidden);
        const ordered = configuration.OrderedViews.flatMap((id) => visible.filter(({ Guid }) => Guid === id));
        const list = [...new Set([...ordered, ...visible])];
        if (viaTgtoDrive && url.searchParams.get("IncludeExternalContent") !== "false") list.unshift(injected);
        const start = Number(url.searchParams.get("StartIndex") ?? 0);
        const limit = Number(url.searchParams.get("Limit") ?? list.length);
        return send({ Items: list.slice(start, start + limit).map(dto), TotalRecordCount: list.length });
      },
    });

  return {
    open,
    preferences,
    writes,
    setTgtoDriveFailure: (failed: boolean) => {
      failTgtoDrive = failed;
    },
  };
}
