import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { trashExpiredArchives } from "../src/session-archive.ts";

test("archives reach Trash 30 days after archival, with failures retained for retry", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-chat-retention-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const archive = join(dir, "archive");
  const trash = join(dir, "trash");
  const now = Date.now();
  const cutoff = now - 30 * 24 * 60 * 60 * 1000;
  const expired = `${cutoff}-${randomUUID()}`;
  const retry = `${cutoff - 1}-${randomUUID()}`;
  const recent = `${cutoff + 1}-${randomUUID()}`;
  const symlinkName = `${cutoff}-${randomUUID()}`;
  const fileName = `${cutoff}-${randomUUID()}`;
  await mkdir(trash);
  for (const name of [expired, retry, recent, "unrelated"]) await mkdir(join(archive, name), { recursive: true });
  if (process.platform !== "win32") await symlink(trash, join(archive, symlinkName), "dir");
  await writeFile(join(archive, fileName), "not an archive directory");
  const attempts = [];
  await trashExpiredArchives(archive, now, async (path) => {
    attempts.push(path);
    if (path === join(archive, retry)) throw new Error("Trash unavailable");
    await rename(path, join(trash, expired));
  });
  assert.deepEqual(new Set(attempts), new Set([join(archive, expired), join(archive, retry)]));
  assert.deepEqual(await readdir(trash), [expired]);
  const remaining = [retry, recent, "unrelated", fileName];
  if (process.platform !== "win32") remaining.push(symlinkName);
  assert.deepEqual(new Set(await readdir(archive)), new Set(remaining));
  await trashExpiredArchives(archive, now, (path) => rename(path, join(trash, retry)));
  assert.deepEqual(new Set(await readdir(trash)), new Set([expired, retry]));
});
