import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { SessionInfo } from "@earendil-works/pi-coding-agent";

export async function listPiSessions(currentDir: string) {
  const { SessionManager, getAgentDir } = await import("@earendil-works/pi-coding-agent");
  const inDefaultRoot = currentDir && dirname(resolve(currentDir)) === resolve(join(getAgentDir(), "sessions"));
  const [sessions, custom] = await Promise.all([
    SessionManager.listAll(),
    currentDir && !inDefaultRoot ? SessionManager.listAll(currentDir) : [],
  ]);
  return [...sessions, ...custom].sort((a, b) => b.modified.getTime() - a.modified.getTime());
}

export async function readPiSession({ path, id, cwd }: Pick<SessionInfo, "path" | "id" | "cwd">) {
  const { SessionManager, parseSessionEntries } = await import("@earendil-works/pi-coding-agent");
  const entries = parseSessionEntries(await readFile(path, "utf8"));
  const header = entries[0];
  if (header?.type !== "session" || header.id !== id) throw new Error("Saved session is unavailable.");
  // Read into memory; opening the disk-backed manager could migrate and rewrite the original file.
  return SessionManager.inMemory(cwd, undefined, entries).getBranch();
}
