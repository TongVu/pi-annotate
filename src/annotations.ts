export const MAX_ANNOTATIONS = 50;
export const MAX_COMMENT = 8000;

function messageText(content) {
  if (typeof content === "string") return content;
  // Exclude thinking, tool calls and image data.
  return content.filter((block) => block.type === "text").map((block) => block.text).join("\n\n");
}

export function userImageBlocks(entry) {
  if (entry?.type !== "message" || entry.message.role !== "user" || !Array.isArray(entry.message.content)) return [];
  return entry.message.content.filter((block) => block.type === "image" &&
    ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(block.mimeType));
}

export function visibleChatMessage(entry) {
  if (entry.type !== "message") return undefined;
  const { role, content } = entry.message;
  if (role !== "user" && role !== "assistant") return undefined;
  let text = messageText(content);
  if (role === "assistant" && !text.trim()) return undefined;
  const imageCount = userImageBlocks(entry).length;
  if (imageCount) return { id: entry.id, role, text, imageCount };
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

const annotationHeading = (responseId) => `Questions about assistant response ${responseId}:\n\n`;
const formatQuestion = (item, index) =>
  `### ${index + 1}\n${item.quote.split("\n").map((line) => `> ${line}`).join("\n")}\n\n${item.comment}`;

export function formatAnnotations(responseId, annotations) {
  return annotationHeading(responseId) + annotations.map(formatQuestion).join("\n\n");
}

export function formatChatAnnotations(value, getResponseText, imagesAt) {
  if (!Array.isArray(value) || !value.length || value.length > MAX_ANNOTATIONS) {
    throw new Error(`Add between 1 and ${MAX_ANNOTATIONS} annotations.`);
  }
  const groups = [];
  for (const [index, item] of value.entries()) {
    const text = typeof item?.responseId === "string" && getResponseText(item.responseId);
    if (typeof text !== "string") throw new Error("This reply is no longer on the active branch.");
    const [validated] = validateAnnotations([item], text);
    if (groups.at(-1)?.id !== item.responseId) groups.push({ id: item.responseId, items: [] });
    groups.at(-1).items.push({ ...validated, images: imagesAt?.(index) ?? [] });
  }
  if (!imagesAt) return groups.map(({ id, items }) => formatAnnotations(id, items)).join("\n\n");
  // Pi's host API places all images after the text. Number them so each question still identifies its own images.
  const images = [];
  const text = groups.map(({ id, items }) => annotationHeading(id) + items.map((item, i) => {
    const question = formatQuestion(item, i);
    if (!item.images.length) return question;
    const labels = item.images.map((_, index) => `Image ${images.length + index + 1}`);
    images.push(...item.images);
    return `${question}\n\nAttached: ${labels.join(", ")}.`;
  }).join("\n\n")).join("\n\n");
  return [{ type: "text", text }, ...images];
}
