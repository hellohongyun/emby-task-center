import {
  isVirtualLibraryItemCompatible,
  type VirtualLibraryCollectionType,
  type VirtualLibraryItem,
} from "@emby-task-center/contracts/virtual-library";

export function libraryTypeLabel(type: VirtualLibraryCollectionType): string {
  return type === "movies" ? "电影" : type === "tvshows" ? "剧集" : "混合";
}

export function itemTypeLabel(type: string): string {
  const labels: Record<string, string> = { movie: "电影", series: "剧集", season: "季", episode: "分集" };
  return labels[type.toLowerCase()] ?? (type || "未知");
}

export function isSelectableWork(type: string): boolean {
  return ["movie", "series"].includes(type.toLowerCase());
}

export function sourceSelectionHint(type: VirtualLibraryCollectionType): string {
  if (type === "movies") return "电影库只允许加入电影；需要加入整部剧时，请改为混合库。";
  if (type === "tvshows") return "剧集库只允许加入整部剧；需要加入电影时，请改为混合库。";
  return "混合库可加入电影和整部剧。";
}

export function incompatibleItems(type: VirtualLibraryCollectionType, items: VirtualLibraryItem[]) {
  return items.filter((item) => !isVirtualLibraryItemCompatible(type, item.type));
}

export function incompatibleMessage(type: VirtualLibraryCollectionType, items: VirtualLibraryItem[]): string {
  return `有 ${items.length} 项内容与当前${libraryTypeLabel(type)}库类型不兼容：${items.map((item) => `《${item.name}》`).join("、")}。客户端可能无法显示这些内容，请编辑媒体库并改为“混合”。`;
}

export function selectionError(type: VirtualLibraryCollectionType, item: VirtualLibraryItem): string {
  if (!isSelectableWork(item.type)) return "请选择电影或整部剧，不单独添加季、分集或其他内容。";
  return `《${item.name}》（${itemTypeLabel(item.type)}）与当前${libraryTypeLabel(type)}库类型不兼容。${sourceSelectionHint(type)}`;
}
