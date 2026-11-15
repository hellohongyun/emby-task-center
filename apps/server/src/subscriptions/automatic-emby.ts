import type { AppDatabase } from "@emby-task-center/database/client";
import type { EmbyClient } from "../integrations/emby-client";
import { isDevelopmentMode } from "../settings/development-mode";

const writes = new Set<PropertyKey>([
  "createUser",
  "setUserPassword",
  "updateUserPolicy",
  "deleteUser",
  "endSession",
  "stopPlayback",
  "removeDevice",
  "deleteItem",
  "refreshLibrary",
]);

/** Only automatic callers use this wrapper; explicit administrator operations keep their own client. */
export function automaticEmby(database: AppDatabase, emby: EmbyClient): EmbyClient {
  return new Proxy(emby, {
    get(target, key) {
      const value = Reflect.get(target, key);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        if (isDevelopmentMode(database)) throw new Error("development_mode_enabled");
        const result = Reflect.apply(value, target, args);
        if (!writes.has(key) && result instanceof Promise) {
          return result.then((reply: unknown) => {
            if (isDevelopmentMode(database)) throw new Error("development_mode_enabled");
            return reply;
          });
        }
        return result;
      };
    },
  });
}
