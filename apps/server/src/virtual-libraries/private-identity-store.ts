import { eq, like } from "drizzle-orm";
import type { AppDatabase } from "@emby-task-center/database/client";
import { appSettings } from "@emby-task-center/database/schema";

const prefix = "virtualLibraryIdentity.";
const lifetime = 90 * 24 * 60 * 60 * 1_000;
export interface PrivateIdentityProof {
  userId: string;
  updatedAt: number;
}
export interface PrivateIdentityPersistence {
  read(hash: string): PrivateIdentityProof | undefined;
  write(hash: string, proof: PrivateIdentityProof): void;
}

export function freshPrivateIdentity(proof: PrivateIdentityProof | undefined) {
  return (
    proof &&
    typeof proof.userId === "string" &&
    proof.userId &&
    Number.isFinite(proof.updatedAt) &&
    proof.updatedAt <= Date.now() &&
    Date.now() - proof.updatedAt < lifetime
  );
}

/** Internal proofs only: never stores the access token or exposes them as settings. */
export function createPrivateIdentityStore(database: AppDatabase): PrivateIdentityPersistence {
  return {
    read(hash) {
      const row = database
        .select()
        .from(appSettings)
        .where(eq(appSettings.key, prefix + hash))
        .get();
      try {
        const proof = row?.value ? (JSON.parse(row.value) as PrivateIdentityProof) : undefined;
        return freshPrivateIdentity(proof) ? proof : undefined;
      } catch {
        return undefined;
      }
    },
    write(hash, proof) {
      // Bound growth without deleting another subsystem's data or existing proofs.
      const rows = database
        .select({ key: appSettings.key })
        .from(appSettings)
        .where(like(appSettings.key, prefix + "%"))
        .all();
      if (rows.length >= 10_000 && !rows.some((row) => row.key === prefix + hash)) return;
      const value = JSON.stringify(proof);
      const updatedAt = new Date().toISOString();
      database
        .insert(appSettings)
        .values({ key: prefix + hash, value, updatedAt, updatedBy: "generated" })
        .onConflictDoUpdate({ target: appSettings.key, set: { value, updatedAt } })
        .run();
    },
  };
}
