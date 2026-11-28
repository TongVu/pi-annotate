import { userImageBlocks, visibleChatMessage } from "./annotations.ts";
import { imageMimeType } from "./chat-attachments.ts";
import { renderMarkdown } from "./markdown.ts";

export const teamReportType = "pi-chat-team-report";
export const teamHandoffType = "pi-chat-team-handoff";

export function renderChatEntry(entry) {
  if (entry.type === "custom_message" && entry.customType === teamHandoffType) {
    const round = entry.details?.round;
    if (!Number.isSafeInteger(round) || round < 1) return;
    return { id: entry.id, role: "team-handoff", ...renderMarkdown(`Round ${round} received. Main chat will review the result and report back here.`) };
  }
  if (entry.type === "custom_message" && entry.customType === teamReportType && entry.display && typeof entry.content === "string") {
    return { id: entry.id, role: "team-report", ...renderMarkdown(entry.content) };
  }
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
