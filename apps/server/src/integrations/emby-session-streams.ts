import type { EmbyClient, EmbyMediaStream, EmbySession } from "./emby-client";

type Streams = { container: string | null; mediaStreams: EmbyMediaStream[] } | null;
interface State {
  identity: object;
  cache: Map<string, { at: number; value: Streams }>;
  pending: Map<string, Promise<Streams>>;
  active: number;
  queue: Array<() => void>;
}
const TTL = 10 * 60_000;
const FAILURE_TTL = 30_000;
const LIMIT = 4;
const MAX_CACHE = 1_000;
const DETAIL_WAIT_MS = 2_000;
let states = new WeakMap<EmbyClient, State>();

export function clearSessionStreamCache(): void {
  states = new WeakMap();
}

function identity(client: EmbyClient): object {
  return client.mediaStreamsCacheIdentity ?? client;
}

function stateFor(client: EmbyClient): State {
  const current = identity(client);
  let state = states.get(client);
  if (!state || state.identity !== current) {
    state = { identity: current, cache: new Map(), pending: new Map(), active: 0, queue: [] };
    states.set(client, state);
  }
  return state;
}

async function load(client: EmbyClient, state: State, id: string): Promise<Streams> {
  const cached = state.cache.get(id);
  if (cached && Date.now() - cached.at < (cached.value ? TTL : FAILURE_TTL)) return cached.value;
  const pending = state.pending.get(id);
  if (pending) return pending;
  const work = (async () => {
    if (state.active >= LIMIT) await new Promise<void>((resolve) => state.queue.push(resolve));
    else state.active += 1;
    try {
      // Queued work for a previous connection must never run against new credentials.
      if (identity(client) !== state.identity) return null;
      let value: Streams;
      try {
        value = (await client.itemMediaStreams!(id)) ?? null;
      } catch {
        value = null;
      }
      state.cache.delete(id);
      state.cache.set(id, { at: Date.now(), value });
      while (state.cache.size > MAX_CACHE) state.cache.delete(state.cache.keys().next().value!);
      return value;
    } finally {
      const next = state.queue.shift();
      if (next) next();
      else state.active -= 1;
    }
  })();
  state.pending.set(id, work);
  try {
    return await work;
  } finally {
    state.pending.delete(id);
  }
}

export async function enrichSessionStreams(client: EmbyClient, sessions: EmbySession[]): Promise<void> {
  if (!client.itemMediaStreams) return;
  const state = stateFor(client);
  const details = Promise.all(
    sessions.map(async (session) => {
      const item = session.NowPlayingItem;
      if (!item?.Id || item.MediaStreams?.length || item.MediaSources?.length) return;
      const value = await load(client, state, item.Id);
      if (!value || identity(client) !== state.identity) return;
      item.MediaStreams = value.mediaStreams;
      item.Container = item.Container ?? value.container;
    }),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Return basic sessions promptly; pending reads keep their single-flight slot and warm the cache.
    await Promise.race([
      details,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, DETAIL_WAIT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
