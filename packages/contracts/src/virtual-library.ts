import { z } from "zod";

export const VirtualLibraryCollectionTypeSchema = z.enum(["movies", "tvshows", "mixed"]);
export type VirtualLibraryCollectionType = z.infer<typeof VirtualLibraryCollectionTypeSchema>;

export function isVirtualLibraryItemCompatible(
  collectionType: VirtualLibraryCollectionType,
  itemType: string,
): boolean {
  if (collectionType === "mixed") return true;
  const type = itemType.toLowerCase();
  return collectionType === "movies" ? type === "movie" : ["series", "season", "episode"].includes(type);
}

export function virtualLibraryTypeHint(collectionType: VirtualLibraryCollectionType): string {
  if (collectionType === "movies") return "电影库只允许加入电影；需要加入其他类型时，请改为混合库。";
  if (collectionType === "tvshows") return "剧集库只允许加入剧集、季和分集；需要加入电影时，请改为混合库。";
  return "混合库可加入不同类型的已有内容。";
}
export const CreateVirtualLibrarySchema = z.strictObject({
  name: z.string().trim().min(1),
  collectionType: VirtualLibraryCollectionTypeSchema.default("mixed"),
  sortOrder: z.number().int().default(0),
});
export const UpdateVirtualLibrarySchema = z.strictObject({
  name: z.string().trim().min(1).optional(),
  collectionType: VirtualLibraryCollectionTypeSchema.optional(),
  sortOrder: z.number().int().optional(),
});
export const AddVirtualLibraryItemsSchema = z.strictObject({
  itemIds: z.array(z.string().trim().min(1)).min(1),
});

export interface VirtualLibrary {
  id: string;
  name: string;
  collectionType: z.infer<typeof VirtualLibraryCollectionTypeSchema>;
  sortOrder: number;
  itemCount: number;
  createdAt: string;
  updatedAt: string;
  posterImageTag?: string | null;
  posterAspectRatio?: number | null;
}

export interface VirtualLibraryItem {
  itemId: string;
  name: string;
  type: string;
  year: number | null;
  imageTag: string | null;
  tmdbId?: string | null;
}

export function normalizeVirtualLibraryTmdbId(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d+$/.test(value.trim())) return null;
  const normalized = value.trim().replace(/^0+/, "");
  return normalized || null;
}

export interface VirtualLibraryMappingIssue {
  itemId: string;
  reason: "missing" | "ambiguous" | "unidentified" | "unavailable" | "identity_mismatch";
  message: string;
}

export type CreateVirtualLibraryInput = z.input<typeof CreateVirtualLibrarySchema>;
export type UpdateVirtualLibraryInput = z.input<typeof UpdateVirtualLibrarySchema>;
