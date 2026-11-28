export function mountAttachmentUi(window, setTooltip) {
  const { document, FileReader } = window;
  const $ = (id) => document.getElementById(id);
  const previewTypes = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
  const svgType = "image/svg+xml";
  const isSvg = (file) => file.type === svgType || /\.svg$/i.test(file.name);
  const MAX_SVG_EDGE = 2048;
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

  async function rasterizeSvg({ name, data }) {
    try {
      // SVG loaded as an image cannot run scripts or fetch external resources.
      const image = new window.Image();
      image.src = `data:${svgType};base64,${data}`;
      await image.decode();
      const { naturalWidth: width, naturalHeight: height } = image;
      if (!width || !height) throw new Error("Empty image");
      const scale = Math.min(1, MAX_SVG_EDGE / Math.max(width, height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));
      canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
      const png = canvas.toDataURL("image/png");
      if (!png.startsWith("data:image/png;base64,")) throw new Error("PNG encoding failed");
      return { name, mimeType: "image/png", data: png.split(",")[1] };
    } catch {
      throw new Error(`Could not render ${name} as an SVG image.`);
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

  function attachmentSize(file) {
    if (typeof file.size === "number") return file.size;
    const { data } = file;
    return data.length * 3 / 4 - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);
  }

  function checkAttachmentLimits(files) {
    const sizes = files.map(attachmentSize);
    if (files.length > MAX_ATTACHMENTS) {
      throw new Error(`Attach up to ${MAX_ATTACHMENTS} files.`);
    }
    const oversized = sizes.findIndex((size) => size > FILE_LIMIT);
    if (oversized !== -1) {
      throw new Error(`${files[oversized].name || "This file"} exceeds the 5 MiB per-file limit.`);
    }
    if (sizes.reduce((total, size) => total + size, 0) > ATTACHMENTS_LIMIT) {
      throw new Error("Attachments must be 10 MiB or less in total.");
    }
  }

  async function readAttachments(files, existing) {
    checkAttachmentLimits([...existing, ...files]);
    const attachments = await Promise.all(files.map(async (file) => {
      const attachment = await readAttachment(file);
      return isSvg(file) ? rasterizeSvg(attachment) : attachment;
    }));
    checkAttachmentLimits([...existing, ...attachments]);
    return attachments;
  }

  return {
    showImagePreview, renderAttachmentList, readAttachments,
    isImageFile: (file) => previewTypes.has(file.type) || isSvg(file),
  };
}
