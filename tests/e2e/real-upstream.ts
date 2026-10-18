import { createServer } from "node:http";
import { createMissingFixtureHandler } from "./missing-fixture-data";

/** Local Emby and TMDB HTTP fixtures; these are not real upstream services. */
export async function startEmbyFixture(options: { missingEpisodes?: boolean } = {}) {
  const missingHandler = options.missingEpisodes ? createMissingFixtureHandler() : undefined;
  const hits: Array<{ method: string; path: string }> = [];
  const unexpected: string[] = [];
  const holds = new Map<string, { entered(): void; ready: Promise<void>; release(): void }>();
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const path = url.pathname.replace(/^\/emby/, "");
    hits.push({ method: request.method ?? "GET", path });
    const missingResult = missingHandler?.(url, request.method ?? "GET");
    if (missingResult) {
      response
        .writeHead(missingResult.status ?? 200, { "content-type": "application/json" })
        .end(missingResult.body === undefined ? undefined : JSON.stringify(missingResult.body));
      return;
    }
    let body: unknown;
    if (request.method !== "GET") {
      unexpected.push(`${request.method} ${path}`);
      response.writeHead(405).end();
      return;
    }
    if (path === "/tmdb/3/search/multi") {
      body = {
        results: ["联动电影", "联动慢搜索"].includes(url.searchParams.get("query") ?? "")
          ? [
              {
                id: 900001,
                media_type: "movie",
                title: "API 隔离测试任务",
                original_title: "Local task fixture",
                release_date: "2025-01-01",
                poster_path: null,
                overview: "Local fixture only",
              },
            ]
          : [],
      };
    } else if (path === "/tmdb/3/movie/900001") {
      body = {
        id: 900001,
        title: "API 隔离测试任务",
        original_title: "Local task fixture",
        overview: "Local fixture only",
        release_date: "2025-01-01",
        poster_path: null,
        backdrop_path: null,
        genres: [],
        credits: { cast: [], crew: [] },
        videos: { results: [] },
      };
    } else if (path === "/Library/VirtualFolders") {
      body = [{ ItemId: "fixture-movies", Name: "隔离测试电影库", CollectionType: "movies", Locations: [] }];
    } else if (path === "/Users/fixture-user/Views") {
      body = {
        Items: [
          {
            Id: "fixture-movies",
            Name: "隔离测试电影库",
            Type: "CollectionFolder",
            CollectionType: "movies",
            IsFolder: true,
          },
        ],
        TotalRecordCount: 1,
      };
    } else if (path === "/Items" || path === "/Users/fixture-user/Items") {
      const ids = url.searchParams.get("Ids")?.split(",");
      let items =
        url.searchParams.get("ParentId") === "fixture-movies" || ids?.includes("fixture-movie")
          ? [
              {
                Id: "fixture-movie",
                Name: "隔离测试电影",
                Type: "Movie",
                ProductionYear: 2025,
                ProviderIds: {},
                ImageTags: {},
                Genres: ["剧情"],
                DateCreated: "2025-01-01T00:00:00Z",
              },
            ]
          : [];
      if (ids) items = items.filter((item) => ids.includes(item.Id));
      const term = url.searchParams.get("SearchTerm")?.toLocaleLowerCase();
      if (term) items = items.filter((item) => item.Name.toLocaleLowerCase().includes(term));
      const types = url.searchParams.get("IncludeItemTypes")?.split(",");
      if (types) items = items.filter((item) => types.includes(item.Type));
      const start = Number(url.searchParams.get("StartIndex") ?? 0);
      const limit = Number(url.searchParams.get("Limit") ?? 100);
      body = { Items: items.slice(start, start + limit), TotalRecordCount: items.length };
    } else if (path === "/System/Info") {
      body = { Id: "fixture-server", ServerName: "Local fixture", Version: "4.8.0" };
    } else if (path === "/Users" || path === "/Sessions") {
      body = [];
    } else if (path === "/System/ActivityLog/Entries") {
      body = { Items: [], TotalRecordCount: 0 };
    } else {
      unexpected.push(`GET ${path}`);
      response.writeHead(404).end();
      return;
    }
    const send = () => {
      if (!response.destroyed)
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
    };
    const hold = holds.get(path);
    if (hold) {
      hold.entered();
      void hold.ready.then(send);
    } else send();
  });
  await new Promise<void>((done, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      done();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture_address_missing");
  return {
    baseURL: `http://127.0.0.1:${address.port}`,
    hits,
    unexpected,
    /** A causal gate keeps the upstream pending until the test observes another real API complete. */
    pause(path: string) {
      if (holds.has(path)) throw new Error(`fixture_already_paused: ${path}`);
      let entered!: () => void;
      let release!: () => void;
      const observed = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const ready = new Promise<void>((resolve) => {
        release = resolve;
      });
      const resume = () => {
        holds.delete(path);
        release();
      };
      holds.set(path, { entered, ready, release: resume });
      return { entered: observed, release: resume };
    },
    async close() {
      for (const hold of holds.values()) hold.release();
      server.closeAllConnections();
      await new Promise<void>((done, reject) => server.close((error) => (error ? reject(error) : done())));
    },
  };
}
