import { fireEvent, render, screen, waitFor } from "@testing-library/vue";
import { describe, expect, it, vi } from "vitest";
import EmbyUsersView from "./EmbyUsersView.vue";

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("EmbyUsersView", () => {
  it("lists users and active sessions, and creates a user", async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn().mockImplementation(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url instanceof Request ? url.url : url);
      calls.push(`${init?.method ?? "GET"} ${u}`);
      if (u.includes("/api/emby/users") && (init?.method ?? "GET") === "GET") {
        return json(200, {
          users: [
            {
              id: "1",
              name: "alice",
              isAdmin: true,
              isHidden: false,
              isDisabled: false,
              playbackEnabled: true,
              enabledDevices: null,
              maxStreamingBitrate: null,
              lastLoginDate: null,
              lastActivityDate: "2026-08-01T00:00:00Z",
              activeSessions: 2,
            },
          ],
        });
      }
      if (u.includes("/api/emby/users") && init?.method === "POST") {
        return json(201, { id: "2", name: "bob" });
      }
      if (u.includes("/api/emby/sessions")) {
        return json(200, {
          sessions: [
            {
              id: "s1",
              userId: "1",
              userName: "alice",
              deviceName: "TV",
              client: "Emby",
              applicationVersion: null,
              remoteAddress: "10.0.0.9:51000",
              lastActivityDate: null,
              item: {
                id: "m1",
                title: "黑客帝国",
                episodeTitle: null,
                type: "Movie",
                seasonNumber: null,
                episodeNumber: null,
                displayTitle: "黑客帝国",
                episodeLabel: null,
              },
              nowPlaying: "黑客帝国",
              nowPlayingType: "Movie",
              runTimeTicks: 8_160_000_000,
              positionTicks: 0,
              positionText: "0:00",
              runTimeText: "13:36",
              progressPercent: 0,
              isPaused: false,
              playMethod: "DirectPlay",
              playMethodLabel: "直接播放",
              container: "MKV",
              bitrate: 6_000_000,
              bitrateText: "6 mbps",
              mediaSourceName: null,
              videoLabel: "1080P H.264",
              videoDirect: true,
              audioLabel: "Chinese AAC stereo",
              audioDirect: true,
              audioStreams: ["Chinese AAC stereo"],
              subtitleLabel: null,
              transcoding: null,
              isPlaying: true,
            },
          ],
        });
      }
      return json(404, {});
    });
    vi.stubGlobal("fetch", fetchMock);

    render(EmbyUsersView, { props: { requireAuth: vi.fn() } });
    await waitFor(() => expect(screen.getAllByText("alice").length).toBeGreaterThan(0));
    expect(screen.getByText(/黑客帝国/)).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();

    await fireEvent.update(screen.getByPlaceholderText("例如：xiaoming"), "bob");
    await fireEvent.update(screen.getByPlaceholderText("可选（不填则无密码）"), "password123");
    await fireEvent.click(screen.getByRole("button", { name: /创建/ }));
    await waitFor(() => expect(calls.some((c) => c.startsWith("POST /api/emby/users"))).toBe(true));
    vi.unstubAllGlobals();
  });
});
