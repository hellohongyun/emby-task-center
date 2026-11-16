import type { Express, Request } from "express";
import type { AppDatabase } from "@emby-task-center/database/client";
import type { PublicSession } from "../subscriptions/public-session";
import { getSubmissionUserByEmail } from "../subscriptions/membership";
import { memberAccessError } from "../subscriptions/member-access";
import { createVirtualLibraryStore } from "../virtual-libraries/store";
import { createVirtualLibrarySource } from "../virtual-libraries/source";
import { registerVirtualLibraryRoutes } from "./virtual-libraries";
import { prepareCreatedLibraryOrder } from "../virtual-libraries/library-create-order";

export function registerPublicVirtualLibraryRoutes(
  app: Express,
  options: {
    database: AppDatabase;
    publicSession: PublicSession;
    sourceForUser?: (userId: string) => ReturnType<typeof createVirtualLibrarySource>;
  },
): void {
  const base = "/api/public/virtual-libraries";
  const memberFor = (request: Request) => {
    const { email } = options.publicSession.read(request.headers.cookie);
    return email ? getSubmissionUserByEmail(options.database, email) : null;
  };
  app.use(base, (request, response, next) => {
    const member = memberFor(request);
    if (!member) return void response.status(401).json({ error: "unauthorized" });
    const error = memberAccessError(options.database, member.email, true);
    if (error) return void response.status(403).json({ error });
    if (!member.embyUserId)
      return void response
        .status(403)
        .json({ error: "emby_account_required", message: "请先绑定 Emby 账号，再创建私人媒体库。" });
    next();
  });
  registerVirtualLibraryRoutes(app, {
    database: options.database,
    base,
    prepareCreate: (request) => prepareCreatedLibraryOrder(options.database, memberFor(request)!.embyUserId),
    storeForRequest: (request) =>
      createVirtualLibraryStore(options.database, { ownerMemberId: memberFor(request)!.id }),
    sourceForRequest: (request) => {
      const userId = memberFor(request)!.embyUserId!;
      return options.sourceForUser?.(userId) ?? createVirtualLibrarySource(options.database, fetch, userId);
    },
  });
}
