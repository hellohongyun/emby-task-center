import type { VirtualLibrary, VirtualLibraryItem } from "./virtual-library";

/** The application currently has one administrator principal, independent of its login name. */
export const VIRTUAL_LIBRARY_ADMIN_OWNER = "primary-admin";
export interface MarketLibrary extends VirtualLibrary {
  source?: "local" | "tgtodrive";
  playbackId?: string;
  authorName: string;
  authorAvatarUrl?: string | null;
  owned: boolean;
  enabled: boolean;
  canSubscribe?: boolean;
}
export interface MarketUserLibrary extends VirtualLibrary {
  ownerEmail: string | null;
  authorName: string;
  authorAvatarUrl?: string | null;
}
export interface MarketLibraryDetails {
  library: MarketLibrary;
  items: VirtualLibraryItem[];
  total: number;
  startIndex: number;
  limit: number;
}
export interface MarketDefaults {
  libraryIds: string[];
  adminEmbyUserId: string | null;
}
export interface LibraryOrderItem {
  id: string;
  name: string;
  kind: "native" | "owned" | "subscribed";
  posterImageTag?: string | null;
  marketId?: string;
  source?: "local" | "tgtodrive";
}
export interface LibraryOrderView {
  items: LibraryOrderItem[];
  order: string[];
  hasPersonalOrder: boolean;
}

export interface UpstreamLibraryCandidate {
  sourceId: string;
  name: string;
  sourceGuid?: string | null;
  collectionType: VirtualLibrary["collectionType"];
  posterImageTag?: string | null;
  posterAspectRatio?: number | null;
  imported?: boolean;
}
export interface UpstreamMarketLibrary extends MarketLibrary {
  available: boolean;
}
export interface UpstreamMarketCatalog {
  configured: boolean;
  libraries: UpstreamMarketLibrary[];
  candidates: UpstreamLibraryCandidate[];
  lastSyncedAt: string | null;
  initializationPending?: number;
  error?: string;
}
