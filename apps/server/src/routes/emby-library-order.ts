import { randomUUID } from "node:crypto";
import type { Express, Response } from "express";
import { z } from "zod";
import type { EmbyClient } from "../integrations/emby-client";
import type { EmbyLibraryOrderSession } from "../integrations/emby-library-order-client";
import { matchesLibraryOrder, planLibraryOrder, readLibraryOrder } from "../integrations/emby-library-order-plan";

const path = "/api/emby/library-order";
const previewSchema = z.strictObject({ sourceUserId: z.string().min(1).max(128) });
const applySchema = z.strictObject({ previewToken: z.uuid() });
const previewLifetimeMs = 5 * 60 * 1000;
const previewLimit = 12;

type Account = { id: string; name: string };
type Snapshot = NonNullable<Awaited<ReturnType<typeof readLibraryOrder>>>;
type Plan = ReturnType<typeof planLibraryOrder>;
type PreviewRow = Account & {
  status: "change" | "unchanged" | "skipped" | "failed";
  before: string[];
  after: string[];
  reason?: string;
};
type ApplyRow = Account & { status: "updated" | "unchanged" | "skipped" | "failed"; reason?: string };
type Target = { row: PreviewRow; snapshot?: string; plan?: Plan };
type Preview = { expires: number; connection: object; sourceId: string; snapshot: string; targets: Target[] };

function fail(response: Response, status: number, error: string) {
  response.status(status).json({ error });
}

async function inBatches<T, R>(items: T[], process: (item: T) => Promise<R>): Promise<R[]> {
  const result: R[] = [];
  for (let offset = 0; offset < items.length; offset += 4) {
    result.push(...(await Promise.all(items.slice(offset, offset + 4).map(process))));
  }
  return result;
}

async function previewTarget(session: EmbyLibraryOrderSession, source: Snapshot, account: Account): Promise<Target> {
  const empty = { ...account, before: [], after: [] };
  try {
    const target = await readLibraryOrder(session, account.id, false);
    if (!target) return { row: { ...empty, status: "skipped", reason: "library_order_role_unknown" } };
    const plan = planLibraryOrder(source, target);
    return {
      row: { ...account, status: plan.update ? "change" : "unchanged", before: plan.before, after: plan.after },
      snapshot: target.fingerprint,
      plan,
    };
  } catch {
    return { row: { ...empty, status: "failed", reason: "library_order_read_failed" } };
  }
}

async function applyTarget(
  session: EmbyLibraryOrderSession,
  { row, snapshot, plan }: Target,
  isCurrent: () => boolean,
): Promise<ApplyRow> {
  const { id, name } = row;
  if (row.status !== "change") return { id, name, status: row.status, reason: row.reason };
  if (!plan?.update) return { id, name, status: "skipped" };
  try {
    const current = await readLibraryOrder(session, id, false);
    if (!current || current.fingerprint !== snapshot) {
      return { id, name, status: "skipped", reason: "library_order_user_changed" };
    }
  } catch {
    return { id, name, status: "failed", reason: "library_order_read_failed" };
  }
  if (!isCurrent()) return { id, name, status: "skipped", reason: "library_order_connection_changed" };
  try {
    await session.updateOrder(id, plan.update);
  } catch {
    return { id, name, status: "failed", reason: "library_order_write_failed" };
  }
  try {
    if (matchesLibraryOrder(await readLibraryOrder(session, id, false), plan)) return { id, name, status: "updated" };
  } catch {
    // The write may already have succeeded. A new preview is safer than retrying.
  }
  return { id, name, status: "failed", reason: "library_order_verify_failed" };
}

export function registerEmbyLibraryOrderRoutes(app: Express, emby: EmbyClient | undefined): void {
  const open = () => emby?.openLibraryOrderSession?.();
  const previews = new Map<string, Preview>();
  let applying = false;

  app.use(path, (_request, response, next) => {
    response.set("Cache-Control", "no-store");
    next();
  });

  app.get(path, async (_request, response) => {
    const session = open();
    if (!session) return fail(response, 503, "library_order_not_configured");
    try {
      const admins = (await session.listUsers())
        .filter((user) => user.Policy?.IsAdministrator === true)
        .map((user) => ({ id: user.Id, name: user.Name }));
      response.json({ admins });
    } catch {
      fail(response, 502, "library_order_read_failed");
    }
  });

  app.post(`${path}/preview`, async (request, response) => {
    const parsed = previewSchema.safeParse(request.body);
    if (!parsed.success) return fail(response, 400, "invalid_request");
    const session = open();
    if (!session) return fail(response, 503, "library_order_not_configured");
    try {
      const users = await session.listUsers();
      const source = users.find(
        (user) => user.Id === parsed.data.sourceUserId && user.Policy?.IsAdministrator === true,
      );
      const order = source && (await readLibraryOrder(session, source.Id, true));
      if (!source || !order) return fail(response, 400, "library_order_invalid_source");
      const accounts = users
        .filter((user) => user.Policy?.IsAdministrator !== true)
        .map((user) => ({ id: user.Id, name: user.Name }));
      const targets = await inBatches(accounts, (account) => previewTarget(session, order, account));
      if (open()?.identity !== session.identity) return fail(response, 409, "library_order_connection_changed");
      const now = Date.now();
      for (const [token, preview] of previews) if (preview.expires <= now) previews.delete(token);
      if (previews.size >= previewLimit) previews.delete(previews.keys().next().value!);
      const previewToken = randomUUID();
      previews.set(previewToken, {
        expires: now + previewLifetimeMs,
        connection: session.identity,
        sourceId: source.Id,
        snapshot: order.fingerprint,
        targets,
      });
      response.json({
        previewToken,
        source: { id: source.Id, name: source.Name },
        libraries: order.templateOrder.map((view) => view.name),
        users: targets.map((target) => target.row),
      });
    } catch {
      fail(response, 502, "library_order_read_failed");
    }
  });

  app.post(`${path}/apply`, async (request, response) => {
    const parsed = applySchema.safeParse(request.body);
    if (!parsed.success) return fail(response, 400, "invalid_request");
    if (applying) return fail(response, 409, "library_order_busy");
    const { previewToken } = parsed.data;
    const preview = previews.get(previewToken);
    previews.delete(previewToken);
    if (!preview || preview.expires <= Date.now()) return fail(response, 409, "library_order_preview_expired");
    const session = open();
    const isCurrent = () => open()?.identity === preview.connection;
    if (!session || session.identity !== preview.connection)
      return fail(response, 409, "library_order_connection_changed");
    applying = true;
    try {
      const source = await readLibraryOrder(session, preview.sourceId, true);
      if (!source || source.fingerprint !== preview.snapshot)
        return fail(response, 409, "library_order_source_changed");
      if (!isCurrent()) return fail(response, 409, "library_order_connection_changed");
      const users = await inBatches(preview.targets, (target) => applyTarget(session, target, isCurrent));
      response.json({ users });
    } catch {
      fail(response, 502, "library_order_read_failed");
    } finally {
      applying = false;
    }
  });
}
