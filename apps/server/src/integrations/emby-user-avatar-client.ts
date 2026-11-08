import { discardBody } from "../util/http";
import { fetchImage } from "../util/image-request";

type Credentials = { baseUrl: string | undefined; apiKey: string | undefined };

export interface EmbyUserAvatarSession {
  readTag(userId: string, signal?: AbortSignal): Promise<string | null>;
  upload(userId: string, image: { contentType: string; body: Buffer }): Promise<void>;
  readImage(userId: string, tag: string, signal?: AbortSignal): Promise<Buffer>;
}

export function createEmbyUserAvatarSession(resolve: () => Credentials): EmbyUserAvatarSession | undefined {
  const { baseUrl, apiKey } = resolve();
  if (!baseUrl || !apiKey) return undefined;

  function checkConnection() {
    const current = resolve();
    if (current.baseUrl !== baseUrl || current.apiKey !== apiKey) throw new Error("emby_connection_changed");
  }

  const urlFor = (userId: string) => `${baseUrl}/emby/Users/${encodeURIComponent(userId)}`;
  const headers = { "X-Emby-Token": apiKey };
  const timeoutMs = 5000;

  async function request(url: string, options: RequestInit = {}) {
    checkConnection();
    const deadline = AbortSignal.timeout(timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
    const response = await fetch(url, { ...options, redirect: "error", signal });
    if (!response.ok) {
      discardBody(response);
      throw new Error(`emby_http_${response.status}`);
    }
    return response;
  }

  return {
    async readTag(userId, signal) {
      const response = await request(urlFor(userId), { headers, signal });
      const user = (await response.json()) as { Id?: string; PrimaryImageTag?: string };
      if (user.Id !== userId) throw new Error("emby_user_mismatch");
      return user.PrimaryImageTag || null;
    },
    async upload(userId, image) {
      const response = await request(`${urlFor(userId)}/Images/Primary`, {
        method: "POST",
        headers: { ...headers, "Content-Type": image.contentType },
        body: image.body.toString("base64"),
      });
      discardBody(response);
    },
    async readImage(userId, tag, signal) {
      checkConnection();
      const url = `${urlFor(userId)}/Images/Primary?tag=${encodeURIComponent(tag)}`;
      return (
        await fetchImage(url, {
          headers,
          timeoutMs,
          maxBytes: 1024 * 1024,
          signal,
          allowUrl: (target) => target === url,
        })
      ).body;
    },
  };
}
