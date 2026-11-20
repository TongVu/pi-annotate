export const MAX_ANNOTATIONS = 50;
export const MAX_COMMENT = 8000;

function messageText(content) {
  if (typeof content === "string") return content;
  // Exclude thinking, tool calls and image data.
  return content.filter((block) => block.type === "text").map((block) => block.text).join("\n\n");
}

export function latestAssistantResponse(entries) {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type !== "message" || entry.message.role !== "assistant") continue;
    const text = messageText(entry.message.content);
    if (text.trim()) return { id: entry.id, text };
  }
  return undefined;
}

export function visibleChatMessage(entry) {
  if (entry.type !== "message") return undefined;
  const { role, content } = entry.message;
  if (role !== "user" && role !== "assistant") return undefined;
  let text = messageText(content);
  if (role === "assistant" && !text.trim()) return undefined;
  if (role === "user" && Array.isArray(content) && content.some((block) => block.type === "image")) {
    text = text.trim() ? `${text}\n\n[Image attached]` : "[Image attached]";
  }
  return { id: entry.id, role, text: text.trim() ? text : "[No text in this message]" };
}

export function validateAnnotations(value, response) {
  if (!Array.isArray(value) || !value.length || value.length > MAX_ANNOTATIONS) {
    throw new Error(`Add between 1 and ${MAX_ANNOTATIONS} annotations.`);
  }
  return value.map((item) => {
    if (!item || !Number.isInteger(item.start) || !Number.isInteger(item.end) ||
        item.start < 0 || item.end <= item.start || item.end > response.length ||
        typeof item.quote !== "string" || !item.quote.trim() ||
        response.slice(item.start, item.end) !== item.quote ||
        typeof item.comment !== "string" || !item.comment.trim() ||
        item.comment.length > MAX_COMMENT) {
      throw new Error("Invalid annotation. Select a passage and enter a comment.");
    }
    return { start: item.start, end: item.end, quote: item.quote, comment: item.comment.trim() };
  });
}

export function formatAnnotations(responseId, annotations) {
  return `Questions about assistant response ${responseId}:\n\n` + annotations.map((item, i) =>
    `### ${i + 1}\n${item.quote.split("\n").map((line) => `> ${line}`).join("\n")}\n\n${item.comment}`,
  ).join("\n\n");
}

export function formatChatAnnotations(value, getResponseText) {
  if (!Array.isArray(value) || !value.length || value.length > MAX_ANNOTATIONS) {
    throw new Error(`Add between 1 and ${MAX_ANNOTATIONS} annotations.`);
  }
  const groups = [];
  for (const item of value) {
    const text = typeof item?.responseId === "string" && getResponseText(item.responseId);
    if (typeof text !== "string") throw new Error("This reply is no longer on the active branch.");
    const [validated] = validateAnnotations([item], text);
    if (groups.at(-1)?.id !== item.responseId) groups.push({ id: item.responseId, items: [] });
    groups.at(-1).items.push(validated);
  }
  return groups.map(({ id, items }) => formatAnnotations(id, items)).join("\n\n");
}

export function appendToDraft(draft, annotations) {
  return draft ? `${draft}${draft.endsWith("\n\n") ? "" : "\n\n"}${annotations}` : annotations;
}
