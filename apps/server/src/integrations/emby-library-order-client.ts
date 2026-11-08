import { z } from "zod";
import { discardBody } from "../util/http";
import type { EmbyUser } from "./emby-client";

export interface EmbyLibraryOrderSession {
  readonly identity: object;
  readonly baseUrl: string;
  listUsers(): Promise<EmbyUser[]>;
  listServerLibraries(): Promise<Array<{ id: string; name: string; collectionType: string | null }>>;
  listMediaFolders(): Promise<Array<{ id: string; name: string; guid?: string }>>;
  getUserPreferences(userId: string): Promise<{
    isAdministrator: boolean;
    orderedViews: string[];
    hiddenViews: string[];
  }>;
  listUserViews(userId: string): Promise<Array<{ id: string; guid?: string; name: string }>>;
  updateOrder(userId: string, orderedViews: string[]): Promise<void>;
}

type Credentials = { baseUrl: string | undefined; apiKey: string | undefined };

const userIdSchema = z
  .string()
  .min(1)
  .refine((id) => id !== "." && id !== "..");
const userSchema = z.object({
  Id: userIdSchema,
  Name: z.string().min(1),
  Policy: z.object({ IsAdministrator: z.boolean().optional(), IsDisabled: z.boolean().optional() }).nullish(),
});
const preferenceIds = z.array(z.string().min(1)).nullish();
const userPreferencesSchema = z.object({
  Id: userIdSchema,
  Policy: z.object({ IsAdministrator: z.boolean() }),
  Configuration: z.object({ OrderedViews: preferenceIds, MyMediaExcludes: preferenceIds }),
});
const userViewsSchema = z.object({
  Items: z.array(z.object({ Id: z.string().min(1), Name: z.string().min(1), Guid: z.string().nullish() })),
  TotalRecordCount: z.number().int().nonnegative().optional(),
});
const serverLibrariesSchema = z.array(
  z.object({
    ItemId: z.string().min(1),
    Name: z.string().min(1),
    CollectionType: z.string().nullish(),
  }),
);
const mediaFoldersSchema = z.object({
  Items: z.array(z.object({ Id: z.string().min(1), Name: z.string().min(1), Guid: z.string().nullish() })),
});

function userPath(userId: string): string {
  return `/Users/${encodeURIComponent(userIdSchema.parse(userId))}`;
}

export function createEmbyLibraryOrderSessionFactory(
  resolve: () => Credentials,
): () => EmbyLibraryOrderSession | undefined {
  let lastCredentials: Credentials | undefined;
  let identity = {};

  return () => {
    const { baseUrl, apiKey } = resolve();
    if (lastCredentials?.baseUrl !== baseUrl || lastCredentials?.apiKey !== apiKey) {
      lastCredentials = { baseUrl, apiKey };
      identity = {};
    }
    if (!baseUrl || !apiKey) return undefined;

    const request = async (path: string, body?: string): Promise<unknown> => {
      const response = await fetch(`${baseUrl}/emby${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { "X-Emby-Token": apiKey, ...(body === undefined ? {} : { "content-type": "text/plain" }) },
        body,
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok || body !== undefined) discardBody(response);
      if (!response.ok) throw new Error(`emby_http_${response.status}`);
      return body === undefined ? response.json() : undefined;
    };

    return {
      identity,
      baseUrl,
      async listUsers() {
        const users = z.array(userSchema).parse(await request("/Users"));
        if (new Set(users.map(({ Id }) => Id)).size !== users.length) throw new Error("emby_duplicate_user");
        return users;
      },
      async listServerLibraries() {
        const libraries = serverLibrariesSchema.parse(await request("/Library/VirtualFolders"));
        return libraries.map(({ ItemId, Name, CollectionType }) => ({
          id: ItemId,
          name: Name,
          collectionType: CollectionType ?? null,
        }));
      },
      async listMediaFolders() {
        const folders = mediaFoldersSchema.parse(await request("/Library/MediaFolders"));
        return folders.Items.map(({ Id, Name, Guid }) => ({
          id: Id,
          name: Name,
          ...(Guid ? { guid: Guid } : {}),
        }));
      },
      async getUserPreferences(userId) {
        const user = userPreferencesSchema.parse(await request(userPath(userId)));
        if (user.Id !== userId) throw new Error("emby_user_mismatch");
        return {
          isAdministrator: user.Policy.IsAdministrator,
          orderedViews: user.Configuration.OrderedViews ?? [],
          hiddenViews: user.Configuration.MyMediaExcludes ?? [],
        };
      },
      async listUserViews(userId) {
        const query = "IncludeExternalContent=false&IncludeHidden=false&AllowDynamicChildren=false";
        const views = userViewsSchema.parse(await request(`${userPath(userId)}/Views?${query}`));
        if (views.TotalRecordCount !== undefined && views.TotalRecordCount !== views.Items.length) {
          throw new Error("emby_incomplete_views");
        }
        return views.Items.map(({ Id, Name, Guid }) => ({ id: Id, name: Name, ...(Guid ? { guid: Guid } : {}) }));
      },
      async updateOrder(userId, orderedViews) {
        // Use the same field-only endpoint as Emby Web, preserving all unrelated user configuration.
        await request(
          `${userPath(userId)}/Configuration/Partial?reqformat=json`,
          JSON.stringify({ OrderedViews: orderedViews }),
        );
      },
    };
  };
}
