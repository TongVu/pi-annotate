import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { attachmentBlocks } from "./chat-attachments.ts";

type NoteAttachment = { name: string; mimeType: string; data: string };

export const CHAT_NOTE_LIMIT = 32_000;

export function createChatNoteStore(directory: string) {
  const writes = new Map<string, Promise<void>>();
  const fileFor = (sessionId: string, extension: string) => {
    if (typeof sessionId !== "string" || !sessionId) throw new Error("Chat session ID is unavailable.");
    const key = createHash("sha256").update(sessionId).digest("hex");
    return join(directory, `${key}.${extension}`);
  };

  async function read(file: string, fallback: string) {
    await writes.get(file)?.catch(() => {});
    try { return await readFile(file, "utf8"); }
    catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return fallback;
      throw error;
    }
  }

  async function write(file: string, contents: string) {
    const previous = writes.get(file) ?? Promise.resolve();
    const pending = previous.catch(() => {}).then(async () => {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
        await rename(temporary, file);
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => {});
        throw error;
      }
    });
    writes.set(file, pending);
    try { await pending; }
    finally { if (writes.get(file) === pending) writes.delete(file); }
  }

  return {
    async read(sessionId: string) {
      return read(fileFor(sessionId, "md"), "");
    },
    async write(sessionId: string, markdown: string) {
      if (typeof markdown !== "string" || markdown.length > CHAT_NOTE_LIMIT) {
        throw new Error(`Markdown notes must be ${CHAT_NOTE_LIMIT.toLocaleString()} characters or less.`);
      }
      await write(fileFor(sessionId, "md"), markdown);
    },
    async readAttachments(sessionId: string): Promise<NoteAttachment[]> {
      return JSON.parse(await read(fileFor(sessionId, "attachments.json"), "[]"));
    },
    async writeAttachments(sessionId: string, files: NoteAttachment[]) {
      const blocks = Array.isArray(files) && files.length === 0 ? [] : attachmentBlocks(files);
      const attachments = files.map(({ name, mimeType, data }, index) => ({
        name, mimeType: blocks[index].mimeType ?? mimeType, data,
      }));
      await write(fileFor(sessionId, "attachments.json"), JSON.stringify(attachments));
    },
  };
}
