import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createChatNoteStore, CHAT_NOTE_LIMIT } from "../src/chat-notes.ts";

test("chat notes survive store recreation and remain scoped to session IDs", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pi-chat-notes-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const first = createChatNoteStore(directory);
  assert.equal(await first.read("session-a"), "");
  await first.write("session-a", "# Reusable note\n\n**Keep this**");

  const reopened = createChatNoteStore(directory);
  assert.equal(await reopened.read("session-a"), "# Reusable note\n\n**Keep this**");
  assert.equal(await reopened.read("session-b"), "");
  await reopened.write("session-a", "");
  assert.equal(await createChatNoteStore(directory).read("session-a"), "");
  await assert.rejects(() => reopened.write("session-a", "x".repeat(CHAT_NOTE_LIMIT + 1)), /32,000 characters/);
  await assert.rejects(() => reopened.read(""), /session ID is unavailable/i);
});
