import { parameter, setParameter, type Item } from "./query-helpers";

const aliases: Record<string, string> = {
  sortname: "SortName",
  name: "Name",
  datecreated: "DateCreated",
  dateplayed: "DatePlayed",
  productionyear: "ProductionYear",
  communityrating: "CommunityRating",
  criticrating: "CriticRating",
  playcount: "PlayCount",
  runtime: "RunTimeTicks",
  premieredate: "PremiereDate",
  isfolder: "IsFolder",
  albumartist: "AlbumArtist",
  artist: "Artists",
  album: "Album",
  indexnumber: "IndexNumber",
};

export function sortingFields(url: URL) {
  const fields = (parameter(url, "SortBy") ?? "")
    .split(",")
    .filter(Boolean)
    .map((key) => aliases[key.toLowerCase()] ?? key);
  setParameter(
    url,
    "Fields",
    [...new Set([...(parameter(url, "Fields") ?? "").split(","), ...fields])].filter(Boolean).join(","),
  );
}

function field(item: Item, key: string): unknown {
  const name = aliases[key.toLowerCase()] ?? key;
  const userData = item.UserData as Record<string, unknown> | undefined;
  const actual = Object.keys(item).find((entry) => entry.toLowerCase() === name.toLowerCase());
  let value =
    name === "DatePlayed" || name === "PlayCount"
      ? userData?.[name === "DatePlayed" ? "LastPlayedDate" : name]
      : actual
        ? item[actual]
        : undefined;
  if (name === "SortName") value ??= item.Name;
  if (/date/i.test(name) && typeof value === "string") value = Date.parse(value) || 0;
  if (Array.isArray(value)) value = value.join(",");
  return value;
}
function compare(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a == null) return -1;
  if (b == null) return 1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "boolean" && typeof b === "boolean") return Number(a) - Number(b);
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
}
export function sortItems(items: Item[], url: URL, positions: Map<string, number>): Item[] {
  const keys = (parameter(url, "SortBy") ?? "").split(",").filter(Boolean);
  const orders = (parameter(url, "SortOrder") ?? "Ascending").split(",");
  const foldersFirst = parameter(url, "FoldersFirst")?.toLowerCase() === "true";
  const random = new Map(items.map((item) => [item, Math.random()]));
  return items.sort((a, b) => {
    if (foldersFirst && Boolean(a.IsFolder) !== Boolean(b.IsFolder)) return a.IsFolder ? -1 : 1;
    for (let index = 0; index < keys.length; index++) {
      const key = keys[index];
      const compared =
        key.toLowerCase() === "random" ? random.get(a)! - random.get(b)! : compare(field(a, key), field(b, key));
      if (compared) return /descending/i.test(orders[index] ?? orders[0]) ? -compared : compared;
    }
    return (positions.get(a.Id!) ?? Number.MAX_SAFE_INTEGER) - (positions.get(b.Id!) ?? Number.MAX_SAFE_INTEGER);
  });
}

export function idBatches(ids: string[], source: URL): string[][] {
  const groups: string[][] = [];
  let batch: string[] = [];
  let length = source.toString().length;
  for (const id of ids) {
    const size = encodeURIComponent(id).length + 3;
    if (batch.length && (batch.length >= 100 || length + size > 6_000)) {
      groups.push(batch);
      batch = [];
      length = source.toString().length;
    }
    batch.push(id);
    length += size;
  }
  if (batch.length) groups.push(batch);
  return groups;
}
