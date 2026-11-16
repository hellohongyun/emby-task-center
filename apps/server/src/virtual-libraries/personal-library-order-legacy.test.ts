import { describe, expect, it } from "vitest";
import { legacyLibrarySequence } from "./personal-library-order-legacy";

describe("recognizable historical library order", () => {
  it("recovers an upstream-injected Guid position from the complete saved anchor when upstream strips it", () => {
    const native = { Id: "123", Guid: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", Extra: { keep: true } };
    const injected = { Id: "ttd", Guid: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", Dynamic: true };
    const library = { Id: "local" };
    const anchor = {
      id: "local",
      previous: [],
      next: [injected.Guid.replaceAll("-", ""), native.Guid.replaceAll("-", "")],
    };
    const sorted = legacyLibrarySequence([native, injected], [library], ["local", native.Guid], [anchor], []);
    expect(sorted).toEqual([library, injected, native]);
    expect(sorted![1]).toBe(injected);
    expect(sorted![2]).toBe(native);
  });
  it("recovers previous neighbors and prepends a newly created owned library without resurrecting an inaccessible ID", () => {
    const source = [{ Id: "native" }, { Id: "dynamic" }, { Id: "unknown" }];
    const additions = [{ Id: "local" }, { Id: "new" }];
    const anchor = { id: "local", previous: ["dynamic", "native"], next: ["revoked"] };
    expect(
      legacyLibrarySequence(source, additions, ["native", "local"], [anchor], ["local", "new"])?.map((item) => item.Id),
    ).toEqual(["new", "native", "dynamic", "local", "unknown"]);
  });
});
