import { render, screen } from "@testing-library/vue";
import { afterEach, describe, expect, it, vi } from "vitest";

import PublicHomeView from "./PublicHomeView.vue";

afterEach(() => vi.unstubAllGlobals());

describe("home's independent recent inventory", () => {
  it.each(["pending", "failed"])("shows recent items when trending is %s", async (state) => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        if (url.includes("/trending"))
          return state === "pending" ? new Promise(() => {}) : Promise.reject(new Error("offline"));
        return Promise.resolve(
          new Response(
            JSON.stringify({
              items: [
                {
                  id: "recent-1",
                  title: "最近入库电影",
                  mediaType: "movie",
                  year: 2026,
                  posterUrl: null,
                  tmdbId: 1,
                  watchUrl: "/watch",
                },
              ],
            }),
          ),
        );
      }),
    );
    render(PublicHomeView);
    expect(await screen.findByText("最近入库电影")).toBeVisible();
    expect(screen.getByRole("heading", { name: "最近入库" })).toBeVisible();
  });
});
