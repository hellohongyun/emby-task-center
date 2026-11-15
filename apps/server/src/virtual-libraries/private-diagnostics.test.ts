import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createPrivateDiagnosticReporter,
  privateClient,
  privateDiagnosticMessage,
  privateDiscoveryRoute,
} from "./private-diagnostics";

afterEach(() => vi.useRealTimers());
describe("safe private-library diagnostics", () => {
  it.each(["SenPlayer", "Yamby", "Hills", "VidHub", "Emby Web"] as const)(
    "recognizes declared %s without returning headers",
    (client) => {
      const result = privateClient({
        "x-emby-authorization": `Emby Client="${client}", Token="private-secret", UserId="private-account"`,
      });
      expect(result).toBe(client);
      expect(privateDiagnosticMessage({ client: result, route: "login", reason: "recorded" })).not.toMatch(
        /private-secret|private-account/,
      );
    },
  );
  it("groups discovery failures while recording each login outcome", () => {
    vi.useFakeTimers();
    const report = vi.fn();
    const emit = createPrivateDiagnosticReporter(report);
    const entry = { client: "Hills" as const, route: "views" as const, reason: "login_proof_missing" };
    emit(entry);
    emit(entry);
    expect(report).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60_000);
    emit(entry);
    emit({ ...entry, route: "login", reason: "recorded" });
    emit({ ...entry, route: "login", reason: "recorded" });
    expect(report).toHaveBeenCalledTimes(4);
  });
  it("does not emit paths or let logger errors affect the request", () => {
    expect(privateDiscoveryRoute(new URL("http://proxy/Users/private-id/Views?api_key=secret"))).toBe("views");
    expect(privateDiscoveryRoute(new URL("http://proxy/Videos/real-id/stream"))).toBeUndefined();
    const emit = createPrivateDiagnosticReporter(() => {
      throw new Error("logger unavailable");
    });
    expect(() => emit({ client: "other", route: "login", reason: "invalid_json" })).not.toThrow();
  });
});
