import type { Item } from "./query-helpers";

function identity(value: unknown): string {
  if (typeof value !== "string") return "";
  return /^(?:[a-f\d]{32}|[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12})$/i.test(value)
    ? value.replaceAll("-", "").toLowerCase()
    : value;
}

function keys(item: Item) {
  return [identity(item.Id), identity(item.Guid)].filter(Boolean);
}

/** Insert only owned entries; upstream objects and their relative order are authoritative. */
export function anchorOwnedViews(original: Item[], additions: Item[], order: string[]) {
  const positions = new Map(order.map((id, index) => [id, index]));
  const rank = (item: Item) =>
    keys(item)
      .map((key) => positions.get(key))
      .find((value) => value !== undefined);
  const sorted = [...additions].sort((a, b) => (rank(a) ?? order.length) - (rank(b) ?? order.length));
  const buckets = Array.from({ length: original.length + 1 }, () => [] as Item[]);
  for (const item of sorted) {
    const position = rank(item);
    let slot = original.length;
    if (position !== undefined) {
      // Locate the next configured upstream anchor without sorting upstream entries.
      for (const key of order.slice(position + 1)) {
        const next = original.findIndex((entry) => keys(entry).includes(key));
        if (next >= 0) {
          slot = next;
          break;
        }
      }
      if (slot === original.length) {
        for (const key of order.slice(0, position).reverse()) {
          const previous = original.findIndex((entry) => keys(entry).includes(key));
          if (previous >= 0) {
            slot = previous + 1;
            break;
          }
        }
      }
    }
    buckets[slot].push(item);
  }
  return original.flatMap((item, index) => [...buckets[index], item]).concat(buckets[original.length]);
}
