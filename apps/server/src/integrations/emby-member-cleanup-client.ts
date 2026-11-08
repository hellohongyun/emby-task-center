import { z } from "zod";
import { discardBody } from "../util/http";

type AccountRole = "ordinary" | "administrator" | "unknown";
type Credentials = { baseUrl: string | undefined; apiKey: string | undefined };

export interface EmbyMemberCleanupSession {
  readonly identity: object;
  serverId(): Promise<string>;
  listAccounts(): Promise<Array<{ id: string; name: string; role: AccountRole }>>;
  readRole(id: string): Promise<AccountRole | "missing">;
  readLastPlayed?(id: string): Promise<string | null>;
  readPlaybackSessions?(): Promise<ReadonlySet<string>>;
  deleteAccount(
    id: string,
    allowDelete?: () => boolean,
    verifyBeforeDelete?: () => Promise<boolean>,
    expectedServerId?: string,
  ): Promise<void>;
}

export class EmbyCleanupDeleteError extends Error {
  constructor(
    message: string,
    readonly deleteStarted: boolean,
    readonly status?: number,
  ) {
    super(message);
  }
}

class EmbyCleanupHttpError extends Error {
  constructor(readonly status: number) {
    super(`emby_http_${status}`);
  }
}

const idSchema = z.string().regex(/^[a-z0-9_-]{1,128}$/i);
const accountSchema = z.object({
  Id: idSchema,
  Name: z.string().min(1),
  Policy: z.object({ IsAdministrator: z.boolean().optional() }).nullish(),
});
const accountDetailSchema = accountSchema.omit({ Name: true });
const accountListSchema = z.object({
  Items: z.array(accountSchema),
  TotalRecordCount: z.number().int().nonnegative(),
});
const serverSchema = z.object({ Id: idSchema });
const latestItemSchema = z.object({
  Items: z
    .array(
      z.object({
        Id: z.string().min(1),
        UserData: z.object({
          LastPlayedDate: z.iso.datetime({ offset: true }).nullish(),
          Played: z.boolean().optional(),
          PlayCount: z.number().int().nonnegative().optional(),
          PlaybackPositionTicks: z.number().int().nonnegative().optional(),
        }),
      }),
    )
    .max(1),
  TotalRecordCount: z.number().int().nonnegative(),
});
const playbackSessionsSchema = z.array(
  z.object({
    Id: z.string().min(1),
    UserId: z.union([idSchema, z.literal("")]).nullish(),
    AdditionalUsers: z.array(z.object({ UserId: idSchema })).nullish(),
    NowPlayingItem: z.object({}).nullish(),
  }),
);
const latestItemQuery = new URLSearchParams({
  Recursive: "true",
  Filters: "IsNotFolder",
  SortBy: "DatePlayed",
  SortOrder: "Descending",
  Limit: "1",
  EnableTotalRecordCount: "true",
  EnableUserData: "true",
  Fields: "UserDataLastPlayedDate,UserDataPlayCount",
  EnableImages: "false",
  GroupItemsIntoCollections: "false",
});

function accountRole(user: z.infer<typeof accountDetailSchema>): AccountRole {
  if (user.Policy?.IsAdministrator === true) return "administrator";
  if (user.Policy?.IsAdministrator === false) return "ordinary";
  return "unknown";
}

function comparisonId(id: string): string {
  return /^(?:[a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i.test(id)
    ? id.replaceAll("-", "").toLowerCase()
    : id;
}

export function createEmbyMemberCleanupSessionFactory(
  resolve: () => Credentials,
): () => EmbyMemberCleanupSession | undefined {
  let lastCredentials: Credentials | undefined;
  let identity = {};

  return () => {
    const { baseUrl, apiKey } = resolve();
    if (lastCredentials?.baseUrl !== baseUrl || lastCredentials?.apiKey !== apiKey) {
      lastCredentials = { baseUrl, apiKey };
      identity = {};
    }
    if (!baseUrl || !apiKey) return undefined;

    const request = (method: "GET" | "DELETE", path: string) =>
      fetch(`${baseUrl}/emby${path}`, {
        method,
        headers: { "X-Emby-Token": apiKey },
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });

    function expectStatus(response: Response, ...statuses: number[]) {
      if (statuses.includes(response.status)) return;
      discardBody(response);
      throw new EmbyCleanupHttpError(response.status);
    }

    async function listAccounts() {
      // Emby documents this endpoint as administrator-only and returns a total for completeness checks.
      const response = await request("GET", "/Users/Query");
      expectStatus(response, 200);
      const { Items, TotalRecordCount } = accountListSchema.parse(await response.json());
      if (Items.length !== TotalRecordCount || new Set(Items.map(({ Id }) => comparisonId(Id))).size !== Items.length) {
        throw new Error("emby_cleanup_incomplete_accounts");
      }
      return Items.map((user) => ({ id: user.Id, name: user.Name, role: accountRole(user) }));
    }

    const userPath = (id: string) => `/Users/${encodeURIComponent(idSchema.parse(id))}`;

    async function readAccount(id: string) {
      const response = await request("GET", userPath(id));
      if (response.status === 404) {
        discardBody(response);
        return null;
      }
      expectStatus(response, 200);
      const user = accountDetailSchema.parse(await response.json());
      if (user.Id !== id) throw new Error("emby_cleanup_account_id_changed");
      return accountRole(user);
    }

    async function readServerId() {
      const response = await request("GET", "/System/Info");
      expectStatus(response, 200);
      return serverSchema.parse(await response.json()).Id;
    }

    return {
      identity,
      serverId: readServerId,
      listAccounts,
      async readRole(id) {
        const role = await readAccount(id);
        if (role !== null) return role;
        const accounts = await listAccounts();
        return accounts.some((account) => comparisonId(account.id) === comparisonId(id)) ? "unknown" : "missing";
      },
      async readLastPlayed(id) {
        const response = await request("GET", `${userPath(id)}/Items?${latestItemQuery}`);
        expectStatus(response, 200);
        const { Items, TotalRecordCount } = latestItemSchema.parse(await response.json());
        if (Items.length !== Math.min(TotalRecordCount, 1)) throw new Error("emby_cleanup_incomplete_playback_history");
        const data = Items[0]?.UserData;
        if (data?.LastPlayedDate) return new Date(data.LastPlayedDate).toISOString();
        if (data && (data.Played !== false || data.PlayCount !== 0 || data.PlaybackPositionTicks !== 0)) {
          throw new Error("emby_cleanup_unverified_playback_history");
        }
        return null;
      },
      async readPlaybackSessions() {
        const response = await request("GET", "/Sessions");
        expectStatus(response, 200);
        const sessions = playbackSessionsSchema.parse(await response.json());
        const playing = new Set<string>();
        for (const { NowPlayingItem, UserId, AdditionalUsers } of sessions) {
          if (!NowPlayingItem) continue;
          if (!UserId && !AdditionalUsers?.length) throw new Error("emby_cleanup_unidentified_playback_session");
          if (UserId) playing.add(comparisonId(UserId));
          for (const user of AdditionalUsers ?? []) playing.add(comparisonId(user.UserId));
        }
        return playing;
      },
      async deleteAccount(id, allowDelete, verifyBeforeDelete, expectedServerId) {
        let role: AccountRole | null;
        try {
          // Check the latest role after the caller's claim and just before the irreversible request.
          role = await readAccount(id);
        } catch (error) {
          throw new EmbyCleanupDeleteError(
            "emby_cleanup_role_unverified",
            false,
            error instanceof EmbyCleanupHttpError ? error.status : undefined,
          );
        }
        if (role !== "ordinary") throw new EmbyCleanupDeleteError("emby_cleanup_not_ordinary", false);
        let allowed: boolean;
        try {
          if (verifyBeforeDelete && (!(await verifyBeforeDelete()) || (await readAccount(id)) !== "ordinary")) {
            throw new Error("emby_cleanup_preflight_rejected");
          }
          // The upstream behind a stable URL can change while the preflight awaits Emby.
          if (expectedServerId !== undefined && (await readServerId()) !== expectedServerId) {
            throw new Error("emby_cleanup_server_changed");
          }
          const current = resolve();
          allowed = current.baseUrl === baseUrl && current.apiKey === apiKey && allowDelete?.() !== false;
        } catch {
          allowed = false;
        }
        if (!allowed) {
          throw new EmbyCleanupDeleteError("emby_cleanup_cancelled", false);
        }
        try {
          const response = await request("DELETE", userPath(id));
          expectStatus(response, 200, 204);
          discardBody(response);
        } catch (error) {
          throw new EmbyCleanupDeleteError(
            error instanceof EmbyCleanupHttpError ? error.message : "emby_cleanup_delete_unverified",
            true,
            error instanceof EmbyCleanupHttpError ? error.status : undefined,
          );
        }
      },
    };
  };
}
