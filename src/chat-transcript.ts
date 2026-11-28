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
    return { id: entry.id, role: "team-report", markdown: entry.content, ...renderMarkdown(entry.content) };
  }
  if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "pi_chat_delegate" && !entry.message.isError) {
    const draft = entry.message.details?.delegation;
    if (typeof draft?.brief === "string" && Array.isArray(draft.attachments) && draft.attachments.every((name) => typeof name === "string")) {
      const started = draft.started === true;
      const files = draft.attachments.length ? draft.attachments.join("\n") : "None";
      const text = `${draft.brief}\n\nAttachments:\n${files}${started ? "" : "\n\nReply ‘Start team’ to send this brief and these attachments."}`;
      return { id: entry.id, role: "team-delegation", started, text };
    }
  }
  const message = visibleChatMessage(entry);
  if (!message) return;
  const rendered = renderMarkdown(message.text);
  return message.role === "assistant"
    ? { ...message, ...rendered, markdown: message.text }
    : { ...message, ...rendered };
}

export function readChatImage(branch, id, index) {
  if (!id || !/^\d+$/.test(index ?? "")) return;
  const image = userImageBlocks(branch.find((entry) => entry.id === id))[Number(index)];
  if (!image || typeof image.data !== "string") return;
  const bytes = Buffer.from(image.data, "base64");
  if (imageMimeType(bytes) === image.mimeType) return { bytes, mimeType: image.mimeType };
}
