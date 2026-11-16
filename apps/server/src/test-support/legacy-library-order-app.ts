import express from "express";
import type { createApp } from "../app";
import { createSessionManager } from "../auth/session";
import { registerAuthRoutes } from "../routes/auth";
import { registerEmbyLibraryOrderRoutes } from "../routes/emby-library-order";

/** Historical module coverage only. The production application no longer registers these routes. */
export function createLegacyLibraryOrderTestApp(options: Parameters<typeof createApp>[0]) {
  const app = express();
  app.use(express.json());
  const sessions = createSessionManager(options.auth);
  registerAuthRoutes(app, sessions);
  app.use("/api", sessions.requireSession);
  registerEmbyLibraryOrderRoutes(app, options.integrationServices?.emby, options.database, options.virtualLibraryProxy);
  return app;
}
