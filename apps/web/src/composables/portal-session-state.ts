import { ref, watch } from "vue";
import type { ConcurrencyMemberStatus } from "../types";
import { fetchJsonWithTimeout } from "./request-timeout";
import { friendlyError, type ActivatedEmby, type MemberUnfreezeStatus, type PortalMember } from "./portal-member";
import {
  portalAccessError,
  guardedPortalFetch,
  portalRefusalRevision,
  portalIdentityRevision,
  invalidatePortalIdentity,
} from "./portal-access";

export const email = ref("");
export const loggedInEmail = ref("");
export const memberStatus = ref("");
export const subscriptionExpiresAt = ref<string | null>(null);
export const memberExpiryLabel = ref<string | null>(null);
export const memberEmbyMaxStreams = ref<number | null>(null);
export const memberConcurrency = ref<ConcurrencyMemberStatus | null>(null);
export const memberUnfreeze = ref<MemberUnfreezeStatus | null>(null);
export const activatedEmby = ref<ActivatedEmby | null>(null);
export const explicitContentAccess = ref<boolean | null>(null);
export const error = ref("");
export const loading = ref(false);
const pending = new Map<string, AbortController>();
export const sessionGeneration = portalIdentityRevision;
export const isStaleSessionError = (caught: unknown) => caught instanceof Error && caught.message === "stale_response";

export function invalidateSessionRequests(): void {
  invalidatePortalIdentity();
  for (const controller of pending.values()) controller.abort();
  pending.clear();
  loading.value = false;
}

export function applyMember(member: PortalMember, address?: string): void {
  if (address !== undefined) loggedInEmail.value = address;
  portalAccessError.value = "";
  explicitContentAccess.value = member.contentAccess ?? null;
  memberStatus.value = member.status;
  subscriptionExpiresAt.value = member.subscriptionExpiresAt;
  memberExpiryLabel.value = member.membershipExpiryLabel ?? null;
  memberEmbyMaxStreams.value = member.embyMaxStreams ?? null;
  memberConcurrency.value = member.concurrency ?? null;
  memberUnfreeze.value = member.unfreeze ?? null;
}

export async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const started = sessionGeneration();
  pending.get(url)?.abort();
  const controller = new AbortController();
  pending.set(url, controller);
  const current = () => sessionGeneration() === started && pending.get(url) === controller;
  const revision = portalRefusalRevision();
  try {
    const { response, body } = await fetchJsonWithTimeout<T & { error?: string }>(
      (input, options) => guardedPortalFetch(input, options, current),
      url,
      { credentials: "include", ...init, signal: controller.signal },
      init?.method && init.method !== "GET" ? 90_000 : 15_000,
      true,
    );
    if (!current()) throw new Error("stale_response");
    if (!response.ok) {
      if (!current()) throw new Error("stale_response");
      throw new Error(body?.error ?? "request_failed");
    }
    if (!current() || revision !== portalRefusalRevision()) throw new Error("stale_response");
    return body as T;
  } catch (caught) {
    if (!current()) throw Object.assign(new Error("stale_response"), { cause: caught });
    throw caught;
  } finally {
    if (pending.get(url) === controller) pending.delete(url);
  }
}

export function resetPortalSession(): void {
  invalidateSessionRequests();
  portalAccessError.value = "";
  explicitContentAccess.value = null;
  email.value = "";
  loggedInEmail.value = "";
  memberStatus.value = "";
  subscriptionExpiresAt.value = null;
  memberExpiryLabel.value = null;
  memberEmbyMaxStreams.value = null;
  memberConcurrency.value = null;
  memberUnfreeze.value = null;
  activatedEmby.value = null;
  error.value = "";
  loading.value = false;
}

watch(email, invalidateSessionRequests, { flush: "sync" });

watch(
  portalAccessError,
  (code) => {
    if (["unauthorized", "member_disabled", "not_member"].includes(code)) {
      resetPortalSession();
      error.value = friendlyError(code);
    }
  },
  { flush: "sync" },
);
