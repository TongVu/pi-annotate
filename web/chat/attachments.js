export function mountAttachmentUi(window, setTooltip) {
  const { document, FileReader } = window;
  const $ = (id) => document.getElementById(id);
  const previewTypes = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
  const MAX_ATTACHMENTS = 10;
  const FILE_LIMIT = 5 * 1024 * 1024;
  const ATTACHMENTS_LIMIT = 10 * 1024 * 1024;
  const imagePreview = $("image-preview");
  const previewImage = $("preview-image");

  $("close-preview").addEventListener("click", () => imagePreview.close());
  imagePreview.addEventListener("close", () => {
    if (!imagePreview.open) previewImage.removeAttribute("src");
  });

  function showImagePreview(name, src) {
    $("preview-title").textContent = name;
    previewImage.alt = name;
    previewImage.src = src;
    imagePreview.showModal();
  }

  function renderAttachmentList(list, files, removeFile, { download = false } = {}) {
    list.hidden = !files.length;
    list.replaceChildren();
    for (const [index, file] of files.entries()) {
      const item = document.createElement("li");
      const name = document.createElement("span");
      name.textContent = file.name;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "secondary";
      remove.setAttribute("aria-label", `Remove ${file.name}`);
      if (removeFile) remove.addEventListener("click", () => removeFile(index));
      if (previewTypes.has(file.mimeType)) {
        if (removeFile) item.className = "image-attachment";
        remove.classList.add("attachment-remove");
        remove.textContent = "×";
        setTooltip(remove, `Remove ${file.name}`);
        const src = `data:${file.mimeType};base64,${file.data}`;
        const thumb = document.createElement("img");
        thumb.src = src;
        thumb.alt = "";
        const open = document.createElement("button");
        open.type = "button";
        open.className = "secondary attachment-preview";
        open.setAttribute("aria-label", `Preview ${file.name}`);
        open.append(thumb, name);
        open.addEventListener("click", () => showImagePreview(file.name, src));
        item.append(open);
      } else if (download) {
        remove.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18M9 6V3h6v3m4 0-1 15H6L5 6m5 4v7m4-7v7"/></svg>';
        setTooltip(remove, `Remove ${file.name}`);
        const link = document.createElement("a");
        link.download = file.name;
        link.href = `data:application/octet-stream;base64,${file.data}`;
        link.setAttribute("aria-label", `Download ${file.name}`);
        link.append(name);
        item.append(link);
      } else {
        item.append(name);
        if (removeFile) {
          item.className = "file-attachment";
          remove.classList.add("file-attachment-remove");
          remove.textContent = "×";
          setTooltip(remove, `Remove ${file.name}`);
        }
      }
      if (removeFile) item.append(remove);
      list.append(item);
    }
  }

  function readAttachment(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve({
        name: file.name || "Pasted file",
        mimeType: file.type,
        data: reader.result.slice(reader.result.indexOf(",") + 1),
      });
      reader.onerror = reader.onabort = () => reject(new Error(`Could not read ${file.name || "the file"}.`));
      reader.readAsDataURL(file);
    });
  }

  function checkAttachmentLimits(files, existing) {
    if (existing.length + files.length > MAX_ATTACHMENTS || files.some((file) => file.size > FILE_LIMIT)) {
      throw new Error(`Attach up to ${MAX_ATTACHMENTS} files, each 5 MiB or smaller.`);
    }
    const total = files.reduce((size, file) => size + file.size, 0) + existing.reduce((size, { data }) =>
      size + data.length * 3 / 4 - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0), 0);
    if (total > ATTACHMENTS_LIMIT) throw new Error("Attachments must be 10 MiB or less in total.");
  }

  return {
    showImagePreview, renderAttachmentList, readAttachment, checkAttachmentLimits,
    isPreviewImage: (type) => previewTypes.has(type),
  };
}
