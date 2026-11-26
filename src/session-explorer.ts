import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { SessionEntry, SessionInfo } from "@earendil-works/pi-coding-agent";
import { visibleChatMessage } from "./annotations.ts";

const subchatOriginType = "pi-chat.subchat-origin";

export function isBranchableReply(entry) {
  if (entry?.type !== "message" || entry.message.role !== "assistant") return false;
  const { content, stopReason } = entry.message;
  // Starting after an assistant tool call would leave it without its tool result.
  return !["toolUse", "error", "aborted"].includes(stopReason) &&
    !(Array.isArray(content) && content.some((block) => block.type === "toolCall")) && Boolean(visibleChatMessage(entry));
}

export function subchatOrigin(branch: SessionEntry[], sessionId: string) {
  // Native forks can inherit custom entries. Only show the marker on its own child session.
  const marker = branch.findLast((entry) => entry.type === "custom" && entry.customType === subchatOriginType && entry.data?.sessionId === sessionId);
  if (marker?.type === "custom") return { replyId: marker.data.replyId, parentName: marker.data.parentName };
}

export async function createSubchat(source: () => { id: string; cwd: string; path: string; dir: string; name?: string } | undefined, replyId: string, name: string) {
  const { SessionManager } = await import("@earendil-works/pi-coding-agent");
  const parent = source();
  if (!parent) throw new Error("The parent chat changed. Reopen /chat and choose the reply again.");
  // Branch an independent manager: createBranchedSession changes the manager it is called on.
  const child = SessionManager.open(parent.path, parent.dir || undefined, parent.cwd);
  if (child.getSessionId() !== parent.id || !isBranchableReply(child.getEntry(replyId))) {
    throw new Error("That reply is no longer available in the saved parent chat.");
  }
  const path = child.createBranchedSession(replyId);
  if (!path) throw new Error("Could not save the subchat.");
  const id = child.getSessionId();
  child.appendSessionInfo(name);
  child.appendCustomEntry(subchatOriginType, { sessionId: id, replyId, parentName: parent.name || "Parent chat" });
  return { id, cwd: parent.cwd, path };
}

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
