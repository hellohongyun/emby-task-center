import type { IncomingMessage, ServerResponse } from "node:http";
import { startRegistrationSmtpSink } from "./member-registration-smtp";
import { startIsolatedServer } from "./real-server";
import { startEmbyFixture } from "./real-upstream";

const imageType = "image/png";
// Three distinct 1×1 PNGs. Exact bytes distinguish QQ updates from a custom Emby avatar.
const oddAvatar = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4IKMDAAM4ATnbe9fjAAAAAElFTkSuQmCC",
  "base64",
);
const evenAvatar = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgKPoPAAHnAXJ1jmLxAAAAAElFTkSuQmCC",
  "base64",
);
const customAvatar = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgWBUFAAGyAQUpuw49AAAAAElFTkSuQmCC",
  "base64",
);

function avatarFor(qq: string): Buffer {
  return Number(qq.at(-1)) % 2 ? oddAvatar : evenAvatar;
}

interface EmbyFixtureUser {
  id: string;
  email: string;
  policy: Record<string, unknown>;
  avatar: { tag: string; bytes: Buffer } | null;
}

function userDto(user: EmbyFixtureUser) {
  return { Id: user.id, Name: user.email, Policy: user.policy, PrimaryImageTag: user.avatar?.tag };
}

function replyJson(response: ServerResponse, value: unknown, status = 200) {
  response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
}

async function requestText(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function memberUpstream() {
  const users = new Map<string, EmbyFixtureUser>();
  const avatarUploads: Array<{ userId: string; bytes: Buffer; accepted: boolean }> = [];
  const unexpected: string[] = [];
  let failAvatar = false;
  let nextUser = 1;
  let nextTag = 1;

  async function handle(request: IncomingMessage, response: ServerResponse, url: URL, path: string) {
    const method = request.method;
    if (path === "/qq-avatar/g") {
      const qq = url.searchParams.get("nk");
      if (method === "GET" && qq && /^\d+$/.test(qq) && url.searchParams.get("b") === "qq") {
        response.writeHead(200, { "content-type": imageType }).end(avatarFor(qq));
        return;
      }
      unexpected.push(`${method} malformed QQ avatar request`);
      response.writeHead(400).end();
      return;
    }

    if (request.headers["x-emby-token"] !== "local-fixture-only") {
      unexpected.push(`${method} ${path}: unauthorized`);
      response.writeHead(401).end();
      return;
    }
    if (path === "/Users" && method === "GET") {
      replyJson(response, [...users.values()].map(userDto));
      return;
    }
    if (path === "/Users/New" && method === "POST") {
      const { Name: email } = JSON.parse(await requestText(request)) as { Name?: string };
      if (!email || [...users.values()].some((user) => user.email === email)) {
        response.writeHead(400).end();
        return;
      }
      const id = `registration-user-${nextUser++}`;
      const user = { id, email, policy: { IsAdministrator: false, IsDisabled: false }, avatar: null };
      users.set(id, user);
      replyJson(response, userDto(user));
      return;
    }

    const [, id, action] = /^\/Users\/([^/]+)(?:\/(Password|Policy|Images\/Primary))?$/.exec(path) ?? [];
    const user = id && users.get(decodeURIComponent(id));
    if (!user) {
      unexpected.push(`${method} ${path}: user not found`);
      response.writeHead(404).end();
      return;
    }
    if (!action && method === "GET") {
      replyJson(response, userDto(user));
    } else if (action === "Password" && method === "POST") {
      const body = JSON.parse(await requestText(request)) as { NewPw?: string };
      response.writeHead(body.NewPw ? 204 : 400).end();
    } else if (action === "Policy" && method === "POST") {
      user.policy = JSON.parse(await requestText(request)) as Record<string, unknown>;
      response.writeHead(204).end();
    } else if (action === "Images/Primary" && method === "POST") {
      const body = await requestText(request);
      const bytes = Buffer.from(body, "base64");
      const knownAvatar = bytes.equals(oddAvatar) || bytes.equals(evenAvatar);
      if (!knownAvatar || request.headers["content-type"] !== imageType || bytes.toString("base64") !== body) {
        unexpected.push(`${method} ${path}: invalid avatar payload`);
        response.writeHead(400).end();
        return;
      }
      avatarUploads.push({ userId: user.id, bytes, accepted: !failAvatar });
      if (failAvatar) {
        response.writeHead(503).end();
        return;
      }
      user.avatar = { tag: `qq-${nextTag++}`, bytes };
      response.writeHead(204).end();
    } else if (action === "Images/Primary" && method === "GET" && user.avatar?.tag === url.searchParams.get("tag")) {
      response.writeHead(200, { "content-type": imageType }).end(user.avatar.bytes);
    } else {
      unexpected.push(`${method} ${path}`);
      response.writeHead(404).end();
    }
  }

  return {
    avatarUploads,
    unexpected,
    embyUser(email: string) {
      const user = [...users.values()].find((candidate) => candidate.email === email);
      return user && { id: user.id, tag: user.avatar?.tag ?? null };
    },
    setCustomAvatar(id: string) {
      const user = users.get(id);
      if (!user) throw new Error("fixture_user_not_found");
      user.avatar = { tag: `custom-${nextTag++}`, bytes: customAvatar };
    },
    setAvatarUploadFailure(value: boolean) {
      failAvatar = value;
    },
    start: () =>
      startEmbyFixture({
        handle(request, response, url, path) {
          if (
            path !== "/qq-avatar/g" &&
            path !== "/Users" &&
            !/^\/Users\/(?:New|registration-user-\d+)(?:\/|$)/.test(path)
          )
            return false;
          void handle(request, response, url, path).catch(() => {
            unexpected.push(`${request.method} ${path}: fixture handler error`);
            response.writeHead(400).end();
          });
          return true;
        },
      }),
  };
}

export async function startMemberRegistrationFixture() {
  const smtp = await startRegistrationSmtpSink();
  const upstream = memberUpstream();
  try {
    const application = await startIsolatedServer({
      startUpstream: upstream.start,
      smtpPort: smtp.port,
      qqAvatarFixture: true,
    });
    return {
      baseURL: application.baseURL,
      restart: application.restart,
      blockedRequests: application.blockedRequests,
      unexpected: upstream.unexpected,
      unexpectedEmbyRequests: application.fixture.unexpected,
      logs: application.logs,
      qqBaseURL: `${application.fixture.baseURL}/qq-avatar`,
      avatarFor,
      avatarUploads: upstream.avatarUploads,
      embyUser: upstream.embyUser,
      setCustomAvatar: upstream.setCustomAvatar,
      setAvatarUploadFailure: upstream.setAvatarUploadFailure,
      codeFor: smtp.codeFor,
      messages: smtp.messages,
      setSmtpFailure: smtp.setSmtpFailure,
      async close() {
        try {
          await application.close();
        } finally {
          await smtp.close();
        }
      },
    };
  } catch (error) {
    await smtp.close();
    throw error;
  }
}
