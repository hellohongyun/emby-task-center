import { friendlyError, type ActivatedEmby, type PortalMember, type RegistrationProof } from "./portal-member";
import {
  activatedEmby,
  applyMember,
  error,
  invalidateSessionRequests,
  isStaleSessionError,
  loading,
  renewalEmailStatus,
  request,
  sessionGeneration,
} from "./portal-session-state";

type CardActivation = { email: string; cardCode: string } & (
  { code: string } | { registrationToken: string; joinSource?: string }
);

export async function activateWithCard(input: CardActivation, loadMember: () => Promise<boolean>): Promise<boolean> {
  invalidateSessionRequests();
  const started = sessionGeneration();
  loading.value = true;
  error.value = "";
  try {
    const body = await request<{
      email: string;
      member: PortalMember;
      emby?: ActivatedEmby | null;
      emailStatus?: string;
    }>("/api/public/subscriptions/activate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    if (started !== sessionGeneration()) return false;
    applyMember(body.member, body.email);
    activatedEmby.value = body.emby ?? null;
    renewalEmailStatus.value = body.emailStatus ?? null;
    await loadMember();
    return started === sessionGeneration();
  } catch (caught) {
    if (!isStaleSessionError(caught)) {
      error.value = caught instanceof Error ? friendlyError(caught.message) : "开通失败";
    }
    return false;
  } finally {
    if (started === sessionGeneration()) loading.value = false;
  }
}

export async function verifyRegistration(
  email: string,
  code: string,
  cardCode: string,
  inviteCode?: string,
): Promise<RegistrationProof | null> {
  const started = sessionGeneration();
  loading.value = true;
  error.value = "";
  try {
    return await request<RegistrationProof>("/api/public/subscriptions/register/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, code, cardCode, inviteCode }),
    });
  } catch (caught) {
    if (!isStaleSessionError(caught)) {
      error.value = caught instanceof Error ? friendlyError(caught.message) : "邮箱验证失败";
    }
    return null;
  } finally {
    if (started === sessionGeneration()) loading.value = false;
  }
}
