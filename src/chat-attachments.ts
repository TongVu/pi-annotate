import { MAX_ANNOTATIONS } from "./annotations.ts";

const BODY_LIMIT = 512 * 1024;
const MAX_ATTACHMENTS = 10;
const FILE_LIMIT = 5 * 1024 * 1024;
const ATTACHMENTS_LIMIT = 10 * 1024 * 1024;
const TEXT_FILES_LIMIT = 128 * 1024;
const FILE_BASE64_LIMIT = Math.ceil(FILE_LIMIT / 3) * 4;
export const CHAT_BODY_LIMIT = BODY_LIMIT + Math.ceil(ATTACHMENTS_LIMIT / 3) * 4 + MAX_ATTACHMENTS * 4;
const utf8 = new TextDecoder("utf-8", { fatal: true });

export function imageMimeType(bytes) {
  const header = bytes.toString("latin1", 0, 12);
  if (header.startsWith("\x89PNG\r\n\x1a\n")) return "image/png";
  if (header.startsWith("\xff\xd8\xff")) return "image/jpeg";
  if (/^GIF8[79]a/.test(header)) return "image/gif";
  if (header.startsWith("RIFF") && header.slice(8) === "WEBP") return "image/webp";
  return undefined;
}

export function attachmentBlocks(files, imagesOnly = false) {
  if (!Array.isArray(files) || !files.length || files.length > MAX_ATTACHMENTS) {
    throw new Error(`Attach between 1 and ${MAX_ATTACHMENTS} files.`);
  }
  let total = 0;
  let textTotal = 0;
  return files.map((file) => {
    const { name, mimeType, data } = file ?? {};
    if (typeof name !== "string" || !name.trim() || name.length > 255 || /[\x00-\x1f/\\]/.test(name) ||
        typeof mimeType !== "string" || mimeType.length > 100 || typeof data !== "string" || data.length > FILE_BASE64_LIMIT) {
      throw new Error("Invalid attachment or file over 5 MiB.");
    }
    const bytes = Buffer.from(data, "base64");
    if (bytes.length > FILE_LIMIT || bytes.toString("base64") !== data) throw new Error("Invalid file data or file over 5 MiB.");
    total += bytes.length;
    if (total > ATTACHMENTS_LIMIT) throw new Error("Attachments must be 10 MiB or less in total.");
    const imageType = imageMimeType(bytes);
    if (mimeType.startsWith("image/") && mimeType !== imageType) {
      throw new Error(`${name}: expected a valid PNG, JPEG, GIF, or WebP image.`);
    }
    if (imageType) return { type: "image", mimeType: imageType, data };
    if (imagesOnly) throw new Error(`${name}: annotations accept only PNG, JPEG, GIF, or WebP images.`);
    textTotal += bytes.length;
    if (textTotal > TEXT_FILES_LIMIT) throw new Error("Text attachments must be 128 KiB or less in total.");
    let text;
    try { text = utf8.decode(bytes); } catch { /* unsupported binary or encoding */ }
    if (text === undefined || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text) || mimeType === "application/pdf" || text.startsWith("%PDF-")) {
      throw new Error(`${name}: only UTF-8 text files and PNG, JPEG, GIF, or WebP images are supported.`);
    }
    return { type: "text", text: `--- Attached file: ${JSON.stringify(name)} ---\n${text}\n--- End attached file ---` };
  });
}

export function annotationImagesAt(annotations) {
  if (!Array.isArray(annotations) || annotations.length > MAX_ANNOTATIONS) return;
  const files = [];
  const ranges = new Map();
  for (const [index, item] of annotations.entries()) {
    if (item?.images === undefined) continue;
    if (!Array.isArray(item.images) || !item.images.length || files.length + item.images.length > MAX_ATTACHMENTS) {
      throw new Error(`Attach between 1 and ${MAX_ATTACHMENTS} images across the annotation batch.`);
    }
    const start = files.length;
    files.push(...item.images);
    ranges.set(index, [start, files.length]);
  }
  if (!files.length) return;
  const blocks = attachmentBlocks(files, true);
  return (index) => ranges.has(index) ? blocks.slice(...ranges.get(index)) : [];
}
