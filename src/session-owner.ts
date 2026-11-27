import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

type OwnerResult = "attached" | "already-open" | "unavailable";
type Identity = { id: string; cwd: string; name?: string };
type StopTarget = { key: string; pid: number; socketPath: string };
type OwnedSession = Identity & { working?: true; stopTarget?: StopTarget };
const actionTimeout = 9000;
const prefix = (id: string) => createHash("sha256").update(id).digest("hex");

function processAlive(pid: number) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

/** The Unix socket is confined to a private temp directory; browsers cannot access it. */
export async function registerSessionOwner(registry: string, session: Identity, attach: () => Promise<OwnerResult>, stop?: () => boolean) {
  await mkdir(registry, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(tmpdir(), "pi-a-"));
  const socketPath = join(directory, "chat");
  const marker = join(registry, `${prefix(session.id)}-${randomUUID()}.json`);
  const sockets = new Set<Socket>();
  let opening: Promise<OwnerResult> | undefined;
  let stopping = false;
  const listenFor = (handle: (socket: Socket) => void) => createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    socket.setTimeout(10_000, () => socket.destroy());
    handle(socket);
  });
  const server = listenFor((socket) => {
    if (stopping) { socket.end("unavailable"); return; }
    opening ??= Promise.resolve().then(attach).catch(() => "unavailable" as const).finally(() => { opening = undefined; });
    void opening.then((result) => socket.end(result));
  });
  // Use a separate socket so an older dashboard's connect-to-reopen request still works.
  const stopServer = stop && listenFor((socket) => {
    socket.once("data", (data) => {
      const deadline = Number(data.toString());
      const now = Date.now();
      if (opening || !Number.isSafeInteger(deadline) || deadline <= now || deadline > now + actionTimeout) {
        socket.end("unavailable");
        return;
      }
      try { stopping ||= stop(); } catch { /* The session may be closing. */ }
      socket.end(stopping ? "stopping" : "unavailable");
    });
  });
  const record = { ...session, pid: process.pid, socketPath, startedAt: Date.now(), canStop: !!stopServer };
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
    await Promise.all([server, stopServer].map((listener) => listener?.listening
      ? new Promise<void>((resolve) => listener.close(() => resolve())) : undefined));
    await writing;
    await Promise.all([rm(marker, { force: true }), rm(`${marker}.tmp`, { force: true }), rm(directory, { recursive: true, force: true })]).catch(() => {});
  };
  try {
    const listen = (listener: typeof server, path: string) => new Promise<void>((resolve, reject) => {
      listener.once("error", reject);
      listener.listen(path, resolve);
      listener.unref();
    });
    await listen(server, socketPath);
    if (stopServer) await listen(stopServer, join(directory, "stop"));
    await publish(false);
    return { close, setWorking };
  } catch (error) {
    await close();
    throw error;
  }
}

function askOwner(path: string, deadline?: number): Promise<string> {
  return new Promise((resolve) => {
    const socket = createConnection(path);
    let output = "";
    socket.setEncoding("utf8");
    socket.setTimeout(actionTimeout, () => socket.destroy());
    if (deadline !== undefined) socket.on("connect", () => socket.write(String(deadline)));
    socket.on("data", (data) => {
      output += data;
      if (output.length > 32) socket.destroy();
    });
    socket.on("error", () => resolve("unavailable"));
    socket.on("end", () => resolve(output));
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
      const { pid, id, cwd, name: label, working, canStop, socketPath } = JSON.parse(await readFile(path, "utf8"));
      if (!processAlive(pid)) await rm(path, { force: true });
      else if (typeof id === "string" && typeof cwd === "string" && name.startsWith(prefix(id))) {
        const previous = sessions.get(id);
        sessions.set(id, { id, cwd, name: typeof label === "string" ? label : undefined,
          working: working === true || previous?.working ? true : undefined,
          stopTarget: !previous && canStop === true && typeof socketPath === "string" && isAbsolute(socketPath)
            ? { key: name.slice(65, -5), pid, socketPath: join(dirname(socketPath), "stop") } : undefined });
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
    if (await isSuspended(owner.pid)) continue;
    const result = await askOwner(owner.socketPath);
    return result === "attached" || result === "already-open" ? result : "unavailable";
  }
  return owners.length ? "suspended" : "missing";
}

async function isSuspended(pid: number) {
  if (process.platform !== "linux") return false;
  const status = await readFile(`/proc/${pid}/status`, "utf8").catch(() => "");
  return /^State:\s+[Tt]\b/m.test(status);
}

export async function requestOwnerStop(target: StopTarget) {
  if (await isSuspended(target.pid)) return "suspended";
  return await askOwner(target.socketPath, Date.now() + actionTimeout) === "stopping" ? "stopping" : "unavailable";
}
