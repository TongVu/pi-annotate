import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, readFile, readdir, rename, rm, rmdir, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const retention = 30 * 24 * 60 * 60 * 1000;
const entryName = /^(\d{13})-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
export const canArchiveSessions = process.platform === "linux" || process.platform === "darwin";

type ArchiveSource = { path: string; cwd: string; name?: string; firstMessage?: string };
const archiveLabel = ({ path, name, firstMessage }: ArchiveSource) =>
  name?.trim() || firstMessage?.replace(/\s+/g, " ").trim().slice(0, 100) || basename(path, ".jsonl");

export async function archiveSession(root: string, session: ArchiveSource) {
  const { path, cwd } = session;
  if (!isAbsolute(path) || !path.endsWith(".jsonl") || !(await lstat(path)).isFile()) {
    throw new Error("This session does not have a regular saved transcript.");
  }
  await mkdir(root, { recursive: true, mode: 0o700 });
  const entry = join(root, `${Date.now()}-${randomUUID()}`);
  await mkdir(entry, { mode: 0o700 });
  try {
    await writeFile(join(entry, "original-path.txt"), path, { mode: 0o600 });
    await writeFile(join(entry, "summary.json"), JSON.stringify({ cwd, name: archiveLabel(session) }), { mode: 0o600 });
    // Never fall back to deleting the source if the move cannot be completed.
    await rename(path, join(entry, basename(path)));
  } catch (error) {
    await rm(entry, { recursive: true, force: true }).catch(() => {});
    if ((error as NodeJS.ErrnoException).code === "EXDEV") {
      throw new Error("The session and archive are on different volumes. The session was not moved.");
    }
    throw error;
  }
}

export async function moveToTrash(path: string): Promise<void> {
  const options = { timeout: 30_000, windowsHide: true };
  if (process.platform === "linux") {
    await run("gio", ["trash", "--", path], options);
  } else if (process.platform === "darwin") {
    // Foundation uses the OS Trash without asking Finder for Automation access.
    await run("/usr/bin/osascript", ["-l", "JavaScript", "-e", `
      ObjC.import('Foundation');
      function run(argv) {
        const url = $.NSURL.fileURLWithPath(argv[0]);
        if (!$.NSFileManager.defaultManager.trashItemAtURLResultingItemURLError(url, Ref(), Ref())) {
          throw new Error('Could not move archive to Trash');
        }
      }
    `, path], options);
  } else {
    throw new Error("OS Trash is not supported on this platform.");
  }
}

async function archiveEntries(root: string) {
  const entries = await readdir(root, { withFileTypes: true }).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  return entries.flatMap((entry) => {
    const match = entry.isDirectory() && entryName.exec(entry.name);
    return match ? [{ id: entry.name, directory: join(root, entry.name), archivedAt: Number(match[1]) }] : [];
  });
}

async function archivedTranscript(directory: string) {
  const original = await readFile(join(directory, "original-path.txt"), "utf8");
  if (!isAbsolute(original) || !original.endsWith(".jsonl")) return;
  const path = join(directory, basename(original));
  if ((await lstat(path)).isFile()) return { original, path };
}

export async function restoreArchivedSession(root: string, id: string) {
  if (!entryName.test(id)) return false;
  const directory = join(root, id);
  try {
    if (!(await lstat(directory)).isDirectory()) return false;
    const transcript = await archivedTranscript(directory);
    if (!transcript) return false;
    const { path, original } = transcript;
    await mkdir(dirname(original), { recursive: true, mode: 0o700 });
    // Unlike rename(), link() creates the destination atomically without replacing it.
    await link(path, original);
    await unlink(path).catch((error) => {
      // The Trash sweep may already have moved this directory; the restored file is safe.
      if (error.code !== "ENOENT") throw error;
    });
    await Promise.all(["original-path.txt", "summary.json"].map((file) => rm(join(directory, file), { force: true }).catch(() => {})));
    await rmdir(directory).catch(() => {});
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function listArchivedSessions(root: string) {
  const entries = await archiveEntries(root);
  const sessions = await Promise.all(entries.map(async ({ id, directory, archivedAt }) => {
    try {
      // A manually restored transcript is no longer archived even if its metadata remains.
      const transcript = await archivedTranscript(directory);
      if (!transcript) return;
      const { path } = transcript;
      try {
        const { name, cwd } = JSON.parse(await readFile(join(directory, "summary.json"), "utf8"));
        if (typeof name === "string" && typeof cwd === "string") return { id, name, cwd, archivedAt };
      } catch { /* Older archives did not store a summary. */ }
      const session = await import("@earendil-works/pi-coding-agent")
        .then(({ SessionManager }) => SessionManager.listAll(directory))
        .then((sessions) => sessions.find((item) => item.path === path))
        .catch(() => undefined);
      return { id, name: session ? archiveLabel(session) : basename(path, ".jsonl"), cwd: session?.cwd ?? "", archivedAt };
    } catch { /* A concurrent restore or Trash sweep can move the files. */ }
  }));
  return sessions.filter((session) => session !== undefined).sort((a, b) => b.archivedAt - a.archivedAt);
}

export async function trashExpiredArchives(root: string, now = Date.now(), trash = moveToTrash) {
  for (const { directory, archivedAt } of await archiveEntries(root)) {
    if (now - archivedAt >= retention) {
      // Leave failures in the archive so a later sweep can retry them.
      await trash(directory).catch(() => {});
    }
  }
}
