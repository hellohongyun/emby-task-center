import { eq } from "drizzle-orm";
import type { AppDatabase } from "@emby-task-center/database/client";
import { appSettings, submissionUsers } from "@emby-task-center/database/schema";
import { memberAccessError } from "../subscriptions/member-access";
import { privateIdentity } from "./private-access";
import { catalogJson, catalogList, upstreamLibraryConfiguration } from "./upstream-library-catalog";

export function upstreamMarketSettings(database: AppDatabase) {
  return {
    read<T>(key: string, fallback: T): T {
      try {
        return (
          JSON.parse(database.select().from(appSettings).where(eq(appSettings.key, key)).get()?.value ?? "null") ??
          fallback
        );
      } catch {
        return fallback;
      }
    },
    write(key: string, value: unknown) {
      const row = {
        key,
        value: JSON.stringify(value),
        updatedAt: new Date().toISOString(),
        updatedBy: "upstream-library-market",
      };
      database.insert(appSettings).values(row).onConflictDoUpdate({ target: appSettings.key, set: row }).run();
    },
  };
}
interface InitialState {
  libraryIds: string[];
  subscribers: { id: string; userId: string }[];
}
export function createUpstreamMarketInitializer(database: AppDatabase, scope: string, fetcher: typeof fetch = fetch) {
  const settings = upstreamMarketSettings(database);
  const key = `upstreamLibraryMarket.initial.${scope}`;
  function capture(libraryIds: string[]) {
    if (settings.read<InitialState | null>(key, null)) return;
    const members = database
      .select()
      .from(submissionUsers)
      .all()
      .filter((m) => m.embyUserId && !memberAccessError(database, m.email, true));
    const subscribers = members.map((m) => ({ id: `member:${m.id}`, userId: m.embyUserId! }));
    const admin = settings.read<{ adminEmbyUserId?: string }>("virtualLibraryMarket.defaults", {}).adminEmbyUserId;
    if (admin && !members.some((m) => privateIdentity(m.embyUserId!) === privateIdentity(admin)))
      subscribers.push({ id: "admin:primary-admin", userId: admin });
    settings.write(key, { libraryIds, subscribers });
  }
  async function initialize(
    subscribe: (id: string, libraryId: string) => void,
    rows: { id: string; sourceId: string; sourceGuid: string | null }[],
  ) {
    const storedState = settings.read<InitialState | null>(key, null);
    if (!storedState) return;
    const state = storedState;
    const config = upstreamLibraryConfiguration(database);
    async function initializeSubscriber(subscriber: InitialState["subscribers"][number]) {
      const marker = (id: string) => `${key}.${subscriber.id}.${id}`;
      const pending = rows.filter((row) => state.libraryIds.includes(row.id) && !settings.read(marker(row.id), false));
      if (!pending.length) return;
      if (subscriber.id.startsWith("member:")) {
        const member = database
          .select()
          .from(submissionUsers)
          .where(eq(submissionUsers.id, Number(subscriber.id.slice(7))))
          .get();
        if (
          !member?.embyUserId ||
          privateIdentity(member.embyUserId) !== privateIdentity(subscriber.userId) ||
          memberAccessError(database, member.email, true)
        )
          return;
      } else if (
        settings.read<{ adminEmbyUserId?: string }>("virtualLibraryMarket.defaults", {}).adminEmbyUserId !==
        subscriber.userId
      )
        return;
      try {
        const path = `Users/${encodeURIComponent(subscriber.userId)}`;
        const [body, user] = await Promise.all([
          catalogList(config.upstream, `${path}/Views`, config.apiKey, fetcher),
          catalogJson(config.upstream, path, config.apiKey, fetcher),
        ]);
        const views = (body as { Items?: { Id?: string; Guid?: string }[] })?.Items;
        if (
          !Array.isArray(views) ||
          privateIdentity(String((user as { Id?: string })?.Id ?? "")) !== privateIdentity(subscriber.userId)
        )
          return;
        const excludes = (user as { Configuration?: { MyMediaExcludes?: unknown } })?.Configuration?.MyMediaExcludes;
        const hidden = new Set(
          Array.isArray(excludes)
            ? excludes.filter((id): id is string => typeof id === "string").map(privateIdentity)
            : [],
        );
        const visible = new Set(
          views
            .flatMap((item) => [item.Id, item.Guid].filter((id): id is string => typeof id === "string"))
            .map(privateIdentity),
        );
        database.transaction(() => {
          for (const row of pending) {
            const ids = [row.sourceId, ...(row.sourceGuid ? [row.sourceGuid] : [])].map(privateIdentity);
            if (ids.some((id) => visible.has(id)) && !ids.some((id) => hidden.has(id)))
              subscribe(subscriber.id, row.id);
            settings.write(marker(row.id), true);
          }
        });
      } catch {
        /* Keep pending; a failed read must never imply an empty initial subscription set. */
      }
    }
    const deadline = Date.now() + 45_000;
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(4, state.subscribers.length) }, async () => {
        while (next < state.subscribers.length && Date.now() < deadline) {
          await initializeSubscriber(state.subscribers[next++]);
        }
      }),
    );
  }
  function pendingCount(rows: { id: string }[]) {
    const state = settings.read<InitialState | null>(key, null);
    if (!state) return 0;
    return state.subscribers.filter((subscriber) =>
      rows.some(
        (row) => state.libraryIds.includes(row.id) && !settings.read(`${key}.${subscriber.id}.${row.id}`, false),
      ),
    ).length;
  }
  return { capture, initialize, pendingCount };
}
