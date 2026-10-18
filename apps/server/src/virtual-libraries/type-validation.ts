import {
  isVirtualLibraryItemCompatible,
  virtualLibraryTypeHint,
  type VirtualLibraryCollectionType,
  type VirtualLibraryItem,
} from "@emby-task-center/contracts/virtual-library";

export class VirtualLibraryTypeMismatchError extends Error {
  constructor(collectionType: VirtualLibraryCollectionType, items: VirtualLibraryItem[]) {
    super(
      `以下条目与虚拟库类型不匹配：${items.map((item) => `《${item.name}》`).join("、")}。${virtualLibraryTypeHint(collectionType)}`,
    );
  }
}

export function validateVirtualLibraryItems(
  collectionType: VirtualLibraryCollectionType,
  items: VirtualLibraryItem[],
): void {
  const incompatible = items.filter((item) => !isVirtualLibraryItemCompatible(collectionType, item.type));
  if (incompatible.length) throw new VirtualLibraryTypeMismatchError(collectionType, incompatible);
}
