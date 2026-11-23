import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { isChatTab } from "./focus-browser.ts";

type Identity = { id: string; cwd: string; name?: string };
type Activity = { status: "working" | "ready" | "error"; tab: string };
type LiveChat = Identity & Partial<Activity>;

function isRunning(pid: number) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

export async function listLiveChats(dir: string): Promise<LiveChat[]> {
  const sessions = new Map<string, LiveChat & { expiresAt: number }>();
  try {
    for (const filename of await readdir(dir)) {
      if (!/^[a-f0-9-]{36}\.json$/.test(filename)) continue;
      const path = join(dir, filename);
      try {
        const record = JSON.parse(await readFile(path, "utf8"));
        if (typeof record?.id !== "string" || typeof record.cwd !== "string" || !Number.isFinite(record.expiresAt)) continue;
        if (!isRunning(record.pid)) {
          // A stopped process cannot refresh this uniquely named marker.
          await rm(path, { force: true });
          continue;
        }
        if (record.expiresAt <= Date.now() || (sessions.get(record.id)?.expiresAt ?? 0) >= record.expiresAt) continue;
        const { id, cwd, expiresAt } = record;
        const name = typeof record.name === "string" ? record.name : undefined;
        const status = ["working", "ready", "error"].includes(record.status) ? record.status : undefined;
        const tab = isChatTab(record.tab) ? record.tab : undefined;
        sessions.set(id, { id, cwd, name, status, tab, expiresAt });
      } catch { /* Another chat may have closed while we were reading. */ }
    }
  } catch { /* A missing or inaccessible registry means no peers. */ }
  return [...sessions.values()].map(({ expiresAt, ...session }) => session).sort((a, b) => a.id.localeCompare(b.id));
}

/** Best-effort discovery. The tab locator is not a chat access token. */
export function createChatPresence(directory: () => string | Promise<string>, identity: () => Identity) {
  const filename = `${randomUUID()}.json`;
  let directoryPromise: Promise<string> | undefined;
  const getDirectory = () => directoryPromise ??= Promise.resolve().then(directory);
  let marker: string | undefined;
  let write: Promise<void> | undefined;
  let nextTouch = 0;
  let lastActivity = "";
  let closed = false;
  return {
    async touch(ttlMs: number, activity?: Activity, heartbeat = true) {
      if (closed) return;
      if (write) return write;
      const record = { ...identity(), ...activity };
      const key = JSON.stringify(record);
      if (key === lastActivity && (!heartbeat || Date.now() < nextTouch)) return;
      lastActivity = key;
      nextTouch = Date.now() + Math.min(10_000, ttlMs / 3);
      write = (async () => {
        const dir = await getDirectory();
        await mkdir(dir, { recursive: true, mode: 0o700 });
        marker = join(dir, filename);
        const tmp = `${marker}.tmp`;
        try {
          await writeFile(tmp, JSON.stringify({ ...record, pid: process.pid, expiresAt: Date.now() + ttlMs }), { mode: 0o600 });
          await rename(tmp, marker);
        } catch (error) {
          await rm(tmp, { force: true }).catch(() => {});
          throw error;
        }
      })().catch(() => { /* Presence failures must not interrupt chat. */ }).finally(() => { write = undefined; });
      return write;
    },
    async list(): Promise<Identity[]> {
      const ownId = identity().id;
      const chats = await getDirectory().then(listLiveChats).catch(() => []);
      return chats.filter(({ id }) => id !== ownId).map(({ id, cwd, name }) => ({ id, cwd, name }));
    },
    async close() {
      closed = true;
      await write;
      if (marker) await rm(marker, { force: true }).catch(() => {});
    },
  };
}
