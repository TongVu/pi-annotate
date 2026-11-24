import { userImageBlocks, visibleChatMessage } from "./annotations.ts";
import { imageMimeType } from "./chat-attachments.ts";
import { renderMarkdown } from "./markdown.ts";

export function renderChatEntry(entry) {
  const message = visibleChatMessage(entry);
  return message && { ...message, ...renderMarkdown(message.text) };
}

export function readChatImage(branch, id, index) {
  if (!id || !/^\d+$/.test(index ?? "")) return;
  const image = userImageBlocks(branch.find((entry) => entry.id === id))[Number(index)];
  if (!image || typeof image.data !== "string") return;
  const bytes = Buffer.from(image.data, "base64");
  if (imageMimeType(bytes) === image.mimeType) return { bytes, mimeType: image.mimeType };
}
