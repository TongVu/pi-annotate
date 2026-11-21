import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

type Identity = { id: string; cwd: string; name?: string };

function isRunning(pid: number) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

/** Best-effort discovery only. Never store a server URL, port, or access token. */
export function createChatPresence(directory: () => string | Promise<string>, identity: () => Identity) {
  const filename = `${randomUUID()}.json`;
  let directoryPromise: Promise<string> | undefined;
  const getDirectory = () => directoryPromise ??= Promise.resolve().then(directory);
  let marker: string | undefined;
  let write: Promise<void> | undefined;
  let nextTouch = 0;
  let closed = false;
  return {
    async touch(ttlMs: number) {
      if (closed) return;
      if (write) return write;
      if (Date.now() < nextTouch) return;
      nextTouch = Date.now() + Math.min(10_000, ttlMs / 3);
      write = (async () => {
        const dir = await getDirectory();
        await mkdir(dir, { recursive: true, mode: 0o700 });
        marker = join(dir, filename);
        const tmp = `${marker}.tmp`;
        try {
          await writeFile(tmp, JSON.stringify({ ...identity(), pid: process.pid, expiresAt: Date.now() + ttlMs }), { mode: 0o600 });
          await rename(tmp, marker);
        } catch (error) {
          await rm(tmp, { force: true }).catch(() => {});
          throw error;
        }
      })().catch(() => { /* Presence failures must not interrupt chat. */ }).finally(() => { write = undefined; });
      return write;
    },
    async list(): Promise<Identity[]> {
      const sessions = new Map<string, Identity>();
      try {
        const dir = await getDirectory();
        const ownId = identity().id;
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
            if (record.id !== ownId && record.expiresAt > Date.now()) {
              sessions.set(record.id, { id: record.id, cwd: record.cwd, name: typeof record.name === "string" ? record.name : undefined });
            }
          } catch { /* Another chat may have closed while we were reading. */ }
        }
      } catch { /* A missing or inaccessible registry means no peers. */ }
      return [...sessions.values()].sort((a, b) => a.id.localeCompare(b.id));
    },
    async close() {
      closed = true;
      await write;
      if (marker) await rm(marker, { force: true }).catch(() => {});
    },
  };
}
