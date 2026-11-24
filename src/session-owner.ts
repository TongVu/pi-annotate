import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

type OwnerResult = "attached" | "already-open" | "unavailable";
type Identity = { id: string; cwd: string; name?: string };
type OwnedSession = Identity & { working?: true };
const prefix = (id: string) => createHash("sha256").update(id).digest("hex");

function processAlive(pid: number) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

/** The Unix socket is confined to a private temp directory; browsers cannot access it. */
export async function registerSessionOwner(registry: string, session: Identity, attach: () => Promise<OwnerResult>) {
  await mkdir(registry, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(tmpdir(), "pi-a-"));
  const socketPath = join(directory, "chat");
  const marker = join(registry, `${prefix(session.id)}-${randomUUID()}.json`);
  const sockets = new Set<Socket>();
  let opening: Promise<OwnerResult> | undefined;
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    socket.setTimeout(10_000, () => socket.destroy());
    opening ??= Promise.resolve().then(attach).catch(() => "unavailable" as const).finally(() => { opening = undefined; });
    void opening.then((result) => socket.end(result));
  });
  const record = { ...session, pid: process.pid, socketPath, startedAt: Date.now() };
  const publish = async (working: boolean) => {
    await writeFile(`${marker}.tmp`, JSON.stringify({ ...record, working }), { mode: 0o600 });
    await rename(`${marker}.tmp`, marker);
  };
  let closed = false;
  // Finish queued writes before cleanup so an update can't recreate a closed owner.
  let writing = Promise.resolve();
  const setWorking = (working: boolean) => {
    if (!closed) writing = writing.then(() => publish(working)).catch(() => {});
    return writing;
  };
  const close = async () => {
    closed = true;
    for (const socket of sockets) socket.destroy();
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    await writing;
    await Promise.all([rm(marker, { force: true }), rm(`${marker}.tmp`, { force: true }), rm(directory, { recursive: true, force: true })]).catch(() => {});
  };
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    server.unref();
    await publish(false);
    return { close, setWorking };
  } catch (error) {
    await close();
    throw error;
  }
}

function askOwner(path: string): Promise<OwnerResult> {
  return new Promise((resolve) => {
    const socket = createConnection(path);
    let output = "";
    socket.setEncoding("utf8");
    socket.setTimeout(9000, () => socket.destroy());
    socket.on("data", (data) => {
      output += data;
      if (output.length > 32) socket.destroy();
    });
    socket.on("error", () => resolve("unavailable"));
    socket.on("end", () => resolve(output === "attached" || output === "already-open" ? output : "unavailable"));
    socket.on("close", () => resolve("unavailable"));
  });
}

export async function listOwnedSessions(registry: string): Promise<OwnedSession[]> {
  const names = await readdir(registry).catch(() => []);
  const sessions = new Map<string, OwnedSession>();
  for (const name of names) {
    if (!/^[a-f0-9]{64}-[a-f0-9-]{36}\.json$/.test(name)) continue;
    const path = join(registry, name);
    try {
      const { pid, id, cwd, name: label, working } = JSON.parse(await readFile(path, "utf8"));
      if (!processAlive(pid)) await rm(path, { force: true });
      else if (typeof id === "string" && typeof cwd === "string" && name.startsWith(prefix(id))) {
        sessions.set(id, { id, cwd, name: typeof label === "string" ? label : undefined,
          working: working === true || sessions.get(id)?.working ? true : undefined });
      }
    } catch { /* The owner may have just shut down. */ }
  }
  return [...sessions.values()];
}

export async function requestOwnedChat(registry: string, id: string): Promise<OwnerResult | "missing" | "suspended"> {
  const filenamePrefix = `${prefix(id)}-`;
  const owners = [];
  try {
    for (const name of await readdir(registry)) {
      if (!name.startsWith(filenamePrefix) || !name.endsWith(".json")) continue;
      const path = join(registry, name);
      try {
        const owner = JSON.parse(await readFile(path, "utf8"));
        if (!processAlive(owner.pid)) {
          await rm(path, { force: true });
          continue;
        }
        if (typeof owner.socketPath !== "string" || !isAbsolute(owner.socketPath)) return "unavailable";
        owners.push(owner);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") return "unavailable";
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return "unavailable";
  }
  // A suspended job keeps its listening socket. Even connecting to it can queue a
  // browser launch for later, so check before sending and never retry after a timeout.
  owners.sort((a, b) => a.startedAt - b.startedAt);
  for (const owner of owners) {
    if (process.platform === "linux") {
      const status = await readFile(`/proc/${owner.pid}/status`, "utf8").catch(() => "");
      if (/^State:\s+[Tt]\b/m.test(status)) continue;
    }
    return askOwner(owner.socketPath);
  }
  return owners.length ? "suspended" : "missing";
}
