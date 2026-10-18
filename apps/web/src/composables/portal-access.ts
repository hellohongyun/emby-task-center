import { ref } from "vue";

/** Shared server refusals invalidate content already on screen. */
export const portalAccessError = ref("");
let refusalRevision = 0;
export const portalRefusalRevision = () => refusalRevision;
let identityRevision = 0;
export const portalIdentityRevision = () => identityRevision;
export const invalidatePortalIdentity = () => {
  identityRevision += 1;
};

export async function guardedPortalFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
  current: () => boolean = () => true,
): Promise<Response> {
  const identity = identityRevision;
  const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
  const active = () => current() && !signal?.aborted && identity === identityRevision;
  const response = await fetch(input, init);
  if (active() && !response.ok && (response.status === 401 || response.status === 403)) {
    const body = (await response
      .clone()
      .json()
      .catch(() => ({}))) as { error?: string };
    const code = body.error ?? (response.status === 401 ? "unauthorized" : "");
    if (
      active() &&
      ["unauthorized", "member_disabled", "not_member", "membership_expired", "member_frozen"].includes(code)
    ) {
      refusalRevision += 1;
      portalAccessError.value = code;
    }
  }
  return response;
}

export const portalFetch: typeof fetch = guardedPortalFetch;
