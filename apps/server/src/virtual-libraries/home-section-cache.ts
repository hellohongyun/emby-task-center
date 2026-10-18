interface SectionDescriptor {
  Id: string;
  SectionType: string;
}

interface CacheEntry {
  expiresAt: number;
  sections: SectionDescriptor[];
}

/** Classification hints only; callers must still authenticate every items request. */
export function createHomeSectionCache(clock: () => number = Date.now) {
  const entries = new Map<string, CacheEntry>();
  const key = (scope: string, user: string) => JSON.stringify([scope, user]);
  function read(scope: string, user: string): unknown | undefined {
    const cacheKey = key(scope, user);
    const entry = entries.get(cacheKey);
    if (!entry) return undefined;
    if (entry.expiresAt <= clock()) {
      entries.delete(cacheKey);
      return undefined;
    }
    return entry.sections.map((section) => ({ ...section }));
  }
  function write(scope: string, user: string, body: unknown): void {
    if (!Array.isArray(body)) return;
    const sections: SectionDescriptor[] = body.flatMap((section: unknown) => {
      if (!section || typeof section !== "object") return [];
      const value = section as Record<string, unknown>;
      return typeof value.Id === "string" && typeof value.SectionType === "string"
        ? [{ Id: value.Id, SectionType: value.SectionType }]
        : [];
    });
    const now = clock();
    for (const [cacheKey, entry] of entries) {
      if (entry.expiresAt <= now) entries.delete(cacheKey);
    }
    const cacheKey = key(scope, user);
    entries.delete(cacheKey);
    entries.set(cacheKey, { expiresAt: now + 60_000, sections });
    while (entries.size > 200) entries.delete(entries.keys().next().value!);
  }
  return { read, write };
}
