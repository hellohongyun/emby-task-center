import { createHash } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import {
  freshPrivateIdentity,
  type PrivateIdentityPersistence,
  type PrivateIdentityProof,
} from "./private-identity-store";

function credential(url: URL, headers: IncomingHttpHeaders): string | undefined {
  const tokens: string[] = [];
  for (const [key, value] of url.searchParams) {
    if (/^(api_key|apikey|token|x-emby-token)$/i.test(key)) tokens.push(value);
  }
  for (const name of ["x-emby-token", "x-mediabrowser-token"]) {
    const value = headers[name];
    if (Array.isArray(value)) tokens.push(...value);
    else if (value !== undefined) tokens.push(value);
  }
  for (const name of ["authorization", "x-emby-authorization", "x-mediabrowser-authorization"]) {
    const value = headers[name];
    if (Array.isArray(value)) return undefined;
    if (!value) continue;
    const bearer = /^Bearer\s+(\S+)$/i.exec(value);
    if (bearer) tokens.push(bearer[1]);
    else {
      for (const match of value.matchAll(/(?:^|[\s,])Token\s*=\s*(?:"([^"]*)"|'([^']*)'|([^,\s]+))/gi))
        tokens.push(match[1] ?? match[2] ?? match[3]);
    }
  }
  // Conflicting credentials have server-dependent precedence; never guess the owner.
  const present = tokens.filter((token) => token.trim().length > 0);
  return present.length && present.every((token) => token === present[0]) ? present[0] : undefined;
}

function key(upstream: string, token: string) {
  return createHash("sha256")
    .update(JSON.stringify([upstream, token]))
    .digest("hex");
}

/** Only a successful upstream authentication response proves token ownership.
 * User and session lookup endpoints can expose other users, even with a valid token.
 * Persist only token hashes and proven user IDs, never raw credentials.
 */
export function createPrivateTokenIdentity(persistence?: PrivateIdentityPersistence) {
  const owners = new Map<string, PrivateIdentityProof>();
  return {
    observe(upstream: string, body: unknown) {
      const auth = body as {
        AccessToken?: unknown;
        User?: { Id?: unknown };
        SessionInfo?: { UserId?: unknown };
      } | null;
      if (
        typeof auth?.AccessToken !== "string" ||
        !auth.AccessToken ||
        typeof auth.User?.Id !== "string" ||
        !auth.User.Id
      )
        return "invalid_authentication_response" as const;
      const id = auth.User.Id;
      if (
        auth.SessionInfo?.UserId != null &&
        auth.SessionInfo.UserId !== "" &&
        String(auth.SessionInfo.UserId).replaceAll("-", "").toLowerCase() !== id.replaceAll("-", "").toLowerCase()
      )
        return "session_user_conflict" as const;
      const hash = key(upstream, auth.AccessToken);
      if (!owners.has(hash) && owners.size >= 10_000) owners.delete(owners.keys().next().value!);
      const proof = { userId: id, updatedAt: Date.now() };
      try {
        persistence?.write(hash, proof);
      } catch {
        return "persistence_error" as const;
      }
      owners.set(hash, proof);
      return "recorded" as const;
    },
    resolve(upstream: string, url: URL, headers: IncomingHttpHeaders) {
      const token = credential(url, headers);
      if (!token) return undefined;
      const hash = key(upstream, token);
      const proof = owners.get(hash) ?? persistence?.read(hash);
      return freshPrivateIdentity(proof) ? proof!.userId : undefined;
    },
  };
}

export function isPrivateAuthentication(method: string | undefined, url: URL) {
  return (
    method === "POST" &&
    /^\/(?:emby\/)?Users\/(?:AuthenticateByName|[^/]+\/Authenticate)(?:\.json)?\/?$/i.test(url.pathname)
  );
}
