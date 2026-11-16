import type { AppDatabase } from "@emby-task-center/database/client";
import { createVirtualLibraryMarketService } from "./market-service";
import { createPersonalLibraryOrderService } from "./personal-library-order";
import { personalLibraryOrderCatalog, personalOrderUpstream } from "./personal-library-order-catalog";

/** Read before creation, then atomically prepend with the library insert. No upstream writes. */
export async function prepareCreatedLibraryOrder(database: AppDatabase, embyUserId?: string | null) {
  if (!embyUserId) return undefined;
  const upstream = personalOrderUpstream(database);
  try {
    new URL(upstream);
  } catch {
    return undefined;
  }
  const orders = createPersonalLibraryOrderService(database);
  let initial = orders.read(upstream, embyUserId);
  if (!initial?.length) {
    try {
      initial = (await personalLibraryOrderCatalog(database, embyUserId)).order;
    } catch {
      // A source outage must not prevent creating a local, empty library.
      initial = createVirtualLibraryMarketService(database).resolveAccess(embyUserId)?.visibleLibraryIds ?? [];
    }
  }
  return (id: string) => {
    orders.prepend(upstream, embyUserId, id, initial);
  };
}
