import BetterSqlite3 from "better-sqlite3";
import { startEmbyFixture } from "./real-upstream";

export const inactivityAccounts = {
  due: "inactivity-due",
  recovered: "inactivity-recovered",
  playing: "inactivity-playing",
  administrator: "inactivity-admin",
  unavailable: "inactivity-unverified",
  fresh: "inactivity-fresh",
  unlinked: "inactivity-unlinked",
};

export const inactivityEmail = (id: string) => `${id}@example.test`;

export function memberInactivityFixture() {
  const { due, recovered, playing, administrator, unavailable, fresh, unlinked } = inactivityAccounts;
  const now = Date.now();
  const daysAgo = (days: number) => new Date(now - days * 86_400_000).toISOString();
  const accounts = new Map(
    [due, recovered, playing, administrator, unavailable, fresh].map((id) => [
      id,
      { Id: id, Name: id, Policy: { IsAdministrator: id === administrator, IsDisabled: false } },
    ]),
  );
  const lastPlayed = new Map([...accounts.keys()].map((id) => [id, id === fresh ? null : daysAgo(16)]));
  const deleteRequests: string[] = [];
  let playbackRaceReads: number | undefined;
  let activePlayback = false;
  let releaseDeletion!: () => void;
  const allowDeletion = new Promise<void>((resolve) => {
    releaseDeletion = resolve;
  });

  return {
    accounts,
    deleteRequests,
    releaseDeletion,
    recoverPlayback: () => lastPlayed.set(recovered, daysAgo(1)),
    makeRecoveredInactive: () => lastPlayed.set(recovered, daysAgo(16)),
    armPlaybackRace: () => {
      playbackRaceReads = 0;
    },
    playbackRaceReads: () => playbackRaceReads,
    seedDatabase(path: string) {
      const db = new BetterSqlite3(path, { fileMustExist: true });
      try {
        const insert = db.prepare(`INSERT INTO submission_users
          (email, emby_user_id, emby_username, subscription_expires_at, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)`);
        for (const id of [...accounts.keys(), unlinked]) {
          const bound = id === unlinked ? null : id;
          insert.run(inactivityEmail(id), bound, bound, daysAgo(-30), daysAgo(id === fresh ? 1 : 40), daysAgo(1));
        }
      } finally {
        db.close();
      }
    },
    startUpstream: () =>
      startEmbyFixture({
        handle(request, response, url, path) {
          const [, id, suffix] = /^\/Users\/([^/]+)(\/(?:Items|Policy))?$/.exec(path) ?? [];
          const accountPath = id && Object.values(inactivityAccounts).includes(id);
          if (!accountPath && !["/Users", "/Users/Query", "/Sessions"].includes(path)) return false;
          const send = (body: unknown, status = 200) => {
            response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
            return true;
          };
          if (request.headers["x-emby-token"] !== "local-fixture-only") return send({}, 401);
          if (path === "/Users") return send([...accounts.values()]);
          if (path === "/Users/Query") return send({ Items: [...accounts.values()], TotalRecordCount: accounts.size });
          if (path === "/Sessions") {
            return send(
              activePlayback ? [{ Id: "fixture-playback", UserId: playing, NowPlayingItem: { Id: "movie" } }] : [],
            );
          }
          const account = id ? accounts.get(id) : undefined;
          if (!id || !account) return send({}, 404);
          if (suffix === "/Policy") {
            if (request.method !== "POST") return send({}, 405);
            let body = "";
            request.setEncoding("utf8");
            request.on("data", (chunk: string) => {
              body += chunk;
            });
            request.once("end", () => {
              try {
                const policy = JSON.parse(body) as typeof account.Policy;
                if (typeof policy.IsAdministrator !== "boolean" || typeof policy.IsDisabled !== "boolean") {
                  return void send({}, 400);
                }
                account.Policy = policy;
                response.writeHead(204).end();
              } catch {
                send({}, 400);
              }
            });
            return true;
          }
          if (suffix === "/Items") {
            if (id === unavailable) return send({}, 503);
            if (url.searchParams.get("SortBy") !== "DatePlayed") return send({}, 400);
            if (id === playing && playbackRaceReads !== undefined) {
              playbackRaceReads++;
              if (playbackRaceReads === 2) activePlayback = true;
            }
            const last = lastPlayed.get(id);
            return send({
              Items: [
                {
                  Id: "movie",
                  UserData: { LastPlayedDate: last, Played: !!last, PlayCount: last ? 1 : 0, PlaybackPositionTicks: 0 },
                },
              ],
              TotalRecordCount: 1,
            });
          }
          if (request.method === "DELETE") {
            deleteRequests.push(id);
            if (id !== due) return send({}, 403);
            void allowDeletion.then(() => {
              accounts.delete(id);
              response.writeHead(204).end();
            });
            return true;
          }
          return send(account);
        },
      }),
  };
}
