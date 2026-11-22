import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const CHAT_NOTE_LIMIT = 32_000;

export function createChatNoteStore(directory: string) {
  const writes = new Map<string, Promise<void>>();
  const fileFor = (sessionId: string) => {
    if (typeof sessionId !== "string" || !sessionId) throw new Error("Chat session ID is unavailable.");
    const key = createHash("sha256").update(sessionId).digest("hex");
    return join(directory, `${key}.md`);
  };

  return {
    async read(sessionId: string) {
      const file = fileFor(sessionId);
      await writes.get(file)?.catch(() => {});
      try { return await readFile(file, "utf8"); }
      catch (error) {
        if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return "";
        throw error;
      }
    },
    async write(sessionId: string, markdown: string) {
      if (typeof markdown !== "string" || markdown.length > CHAT_NOTE_LIMIT) {
        throw new Error(`Markdown notes must be ${CHAT_NOTE_LIMIT.toLocaleString()} characters or less.`);
      }
      const file = fileFor(sessionId);
      const previous = writes.get(file) ?? Promise.resolve();
      const pending = previous.catch(() => {}).then(async () => {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const temporary = `${file}.${randomUUID()}.tmp`;
        try {
          await writeFile(temporary, markdown, { encoding: "utf8", mode: 0o600, flag: "wx" });
          await rename(temporary, file);
        } catch (error) {
          await rm(temporary, { force: true }).catch(() => {});
          throw error;
        }
      });
      writes.set(file, pending);
      try { await pending; }
      finally { if (writes.get(file) === pending) writes.delete(file); }
    },
  };
}
