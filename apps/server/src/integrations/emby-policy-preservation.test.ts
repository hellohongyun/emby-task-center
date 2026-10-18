import { describe, expect, it, vi } from "vitest";
import type { EmbyClient, EmbyUser, EmbyUserPolicy } from "./emby-client";
import { createEmbyUserService } from "./emby-user-service";

function setup(users: () => Promise<EmbyUser[]>) {
  const updateUserPolicy = vi.fn(async () => undefined);
  const client = {
    configured: true,
    listUsers: users,
    createUser: vi.fn(),
    setUserPassword: vi.fn(),
    updateUserPolicy,
    deleteUser: vi.fn(),
  } as unknown as EmbyClient;
  return { service: createEmbyUserService(client), updateUserPolicy };
}

describe("Emby policy read before replacement", () => {
  for (const operation of ["disable", "limits"] as const) {
    const apply = (service: ReturnType<typeof createEmbyUserService>) =>
      operation === "disable"
        ? service.setDisabled("member", true)
        : service.applyPolicy("member", { SimultaneousStreamLimit: 2 });

    it(`${operation}: refuses writes when upstream policy reading fails`, async () => {
      const { service, updateUserPolicy } = setup(async () => {
        throw new Error("emby_http_401");
      });
      await expect(apply(service)).rejects.toMatchObject({ status: 502 });
      expect(updateUserPolicy).not.toHaveBeenCalled();
    });

    it(`${operation}: refuses writes for absent users or missing policies`, async () => {
      for (const users of [[], [{ Id: "member", Name: "Member", Policy: null }]]) {
        const { service, updateUserPolicy } = setup(async () => users);
        await expect(apply(service)).rejects.toMatchObject({ status: users.length ? 502 : 404 });
        expect(updateUserPolicy).not.toHaveBeenCalled();
      }
    });

    it(`${operation}: preserves disabled state, limits and unknown policy fields`, async () => {
      const policy: EmbyUserPolicy = {
        IsDisabled: true,
        SimultaneousStreamLimit: 5,
        EnableAllFolders: false,
        EnabledFolders: ["private"],
      };
      const { service, updateUserPolicy } = setup(async () => [{ Id: "member", Name: "Member", Policy: policy }]);
      await apply(service);
      expect(updateUserPolicy).toHaveBeenCalledWith("member", {
        ...policy,
        ...(operation === "disable" ? { IsDisabled: true } : { SimultaneousStreamLimit: 2 }),
      });
      expect(policy.SimultaneousStreamLimit).toBe(5);
    });
  }
});
