export function mountAnnotationDraft(window, { sender, attachmentUi, status, setTooltip, isViewingLive, renderMarkdown }) {
  const { document, Node } = window;
  const $ = (id) => document.getElementById(id);
  const { renderAttachmentList, readAttachments, isImageFile } = attachmentUi;
  const responseElement = $("response");
  const dialog = $("comment-dialog");
  const selectionAction = $("annotate-selection");
  const comment = $("comment");
  const form = $("comment-form");
  const save = $("save-annotation");
  const send = $("send");
  let annotations = [];
  const previews = new WeakMap();
  let annotationImagesSupported = false;
  let annotationFiles = [];
  let readingAnnotationFiles = false;
  let selectedPassage;
  let pending;
  let editing = -1;

  function updateControls() {
    send.disabled = !annotations.length || !sender.canSend({ annotations });
    const locked = sender.sending || readingAnnotationFiles;
    $("comment-attach").disabled = save.disabled = locked;
    for (const button of $("comment-attachments").querySelectorAll("button")) button.disabled = locked;
    for (const button of $("annotations").querySelectorAll(".annotation-action")) button.disabled = sender.sending;
  }

  function commentFileStatus(message, error = false) {
    const element = $("comment-file-status");
    element.textContent = message;
    element.classList.toggle("error", error);
  }

  function setAnnotationFiles(files) {
    annotationFiles = files;
    renderAttachmentList($("comment-attachments"), annotationFiles, (index) => {
      setAnnotationFiles(annotationFiles.filter((_, i) => i !== index));
    });
    updateControls();
  }

  async function attachAnnotationImages(files) {
    if (!annotationImagesSupported || !pending || !dialog.open || !files.length || sender.sending || readingAnnotationFiles) return;
    const draft = pending;
    readingAnnotationFiles = true;
    updateControls();
    try {
      if (files.some((file) => !isImageFile(file))) throw new Error("Choose PNG, JPEG, GIF, WebP, or SVG images.");
      const otherImages = annotations.flatMap((annotation, index) => index === editing ? [] : annotation.images ?? []);
      const images = await readAttachments(files, [...otherImages, ...annotationFiles]);
      if (draft !== pending || !dialog.open) return;
      setAnnotationFiles([...annotationFiles, ...images]);
      commentFileStatus("");
    } catch (error) {
      if (draft === pending && dialog.open) commentFileStatus(error.message, true);
    } finally {
      if (draft === pending) {
        readingAnnotationFiles = false;
        updateControls();
      }
    }
  }

  function setAnnotations(next) {
    sender.invalidateRetry("annotations");
    annotations = next;
    renderAnnotations();
  }

  function renderAnnotations() {
    $("count").textContent = String(annotations.length);
    send.setAttribute("aria-label", `Send ${annotations.length} question${annotations.length === 1 ? "" : "s"}`);
    $("empty").hidden = annotations.length > 0;
    $("annotations").replaceChildren();
    for (const [index, annotation] of annotations.entries()) {
      const item = document.createElement("li");
      item.className = "annotation-item";
      const quote = document.createElement("blockquote");
      quote.textContent = annotation.quote;
      const text = document.createElement("div");
      text.className = "annotation-comment";
      const source = document.createElement("p");
      source.className = "annotation-comment-source";
      source.textContent = annotation.comment;
      text.append(source);
      if (!previews.has(annotation)) {
        previews.set(annotation, renderMarkdown(annotation.comment).catch(() => {
          previews.delete(annotation);
        }));
      }
      void previews.get(annotation).then((preview) => {
        if (text.isConnected && typeof preview?.html === "string" && preview.html) text.innerHTML = preview.html;
      });
      const actions = document.createElement("div");
      actions.className = "annotation-actions";
      for (const action of [
        { label: "Edit annotation", path: "M16 4l4 4M4 20l4-.8L19 8a2.8 2.8 0 0 0-4-4L4 15z" },
        { label: "Remove annotation", path: "M3 6h18M8 6V4h8v2m3 0-.9 14H5.9L5 6m4 4v6m6-6v6" },
      ]) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "secondary annotation-action";
        setTooltip(button, action.label);
        button.setAttribute("aria-label", action.label);
        button.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${action.path}"/></svg>`;
        button.addEventListener("click", () => {
          if (action.label === "Edit annotation") {
            editing = index;
            showComment(annotation);
          } else {
            setAnnotations(annotations.filter((_, i) => i !== index));
          }
        });
        actions.append(button);
      }
      item.append(quote, text);
      if (annotation.images?.length) {
        const images = document.createElement("ul");
        images.className = "attachment-list";
        images.setAttribute("aria-label", "Attached annotation images");
        renderAttachmentList(images, annotation.images);
        item.append(images);
      }
      item.append(actions);
      $("annotations").append(item);
    }
    updateControls();
  }

  function showComment(selection) {
    pending = selection;
    $("selected-quote").textContent = selection.quote;
    comment.value = editing >= 0 ? selection.comment : "";
    readingAnnotationFiles = false;
    setAnnotationFiles(selection.images ?? []);
    commentFileStatus("");
    dialog.showModal();
    comment.focus();
  }

  function hideSelectionAction() {
    selectionAction.hidden = true;
    selectedPassage = undefined;
  }

  function showSelectionAction() {
    if (sender.sending || dialog.open || !isViewingLive()) return hideSelectionAction();
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) return hideSelectionAction();
    const range = selection.getRangeAt(0);
    const startElement = range.startContainer.nodeType === Node.ELEMENT_NODE ? range.startContainer : range.startContainer.parentElement;
    const passage = startElement?.closest("[data-response-id]");
    if (!passage || !responseElement.contains(passage) || !passage.contains(range.endContainer)) return hideSelectionAction();
    const before = range.cloneRange();
    before.selectNodeContents(passage);
    before.setEnd(range.startContainer, range.startOffset);
    const text = range.toString();
    const quote = text.trim();
    if (!quote) return hideSelectionAction();
    const start = before.toString().length + text.length - text.trimStart().length;
    selectedPassage = { start, end: start + quote.length, quote, responseId: passage.dataset.responseId };
    selectionAction.hidden = false;
    const rect = range.getBoundingClientRect();
    const { offsetWidth: width, offsetHeight: height } = selectionAction;
    const gap = 8;
    const above = rect.top - height - gap;
    selectionAction.style.left = `${Math.max(gap, Math.min(rect.left, window.innerWidth - width - gap))}px`;
    selectionAction.style.top = `${Math.max(gap, Math.min(above >= gap ? above : rect.bottom + gap, window.innerHeight - height - gap))}px`;
  }

  // Leave native selection and copy alone. Clicking the action uses the captured quote.
  responseElement.addEventListener("mouseup", (event) => {
    if (event.button === 0) showSelectionAction();
  });
  document.addEventListener("keyup", (event) => {
    if (event.key === "Shift") showSelectionAction();
    else if (event.key === "Escape") hideSelectionAction();
  });
  document.addEventListener("selectionchange", () => {
    if (!selectionAction.hidden && document.activeElement !== selectionAction) showSelectionAction();
  });
  document.addEventListener("pointerdown", (event) => {
    if (event.button === 0 && !selectionAction.contains(event.target)) hideSelectionAction();
  });
  responseElement.addEventListener("scroll", hideSelectionAction, { passive: true });
  window.addEventListener("resize", hideSelectionAction);
  selectionAction.addEventListener("mousedown", (event) => event.preventDefault());
  selectionAction.addEventListener("click", () => {
    const passage = selectedPassage;
    hideSelectionAction();
    if (!passage || sender.sending || dialog.open || !isViewingLive()) return;
    if (annotations.length >= 50) {
      status("Maximum 50 annotations per batch.", true);
      return;
    }
    editing = -1;
    showComment(passage);
  });
  $("comment-close").addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => {
    if (dialog.open) return;
    pending = undefined;
    comment.value = "";
    editing = -1;
    readingAnnotationFiles = false;
    setAnnotationFiles([]);
    window.getSelection()?.removeAllRanges();
  });
  const commentFile = $("comment-file");
  $("comment-attach").addEventListener("click", () => commentFile.click());
  commentFile.addEventListener("change", () => {
    const files = Array.from(commentFile.files);
    commentFile.value = "";
    void attachAnnotationImages(files);
  });
  comment.addEventListener("paste", (event) => {
    if (!annotationImagesSupported) return;
    const images = Array.from(event.clipboardData?.files ?? []).filter((file) => file.type.startsWith("image/") || isImageFile(file));
    if (!images.length) return;
    event.preventDefault();
    void attachAnnotationImages(images);
  });
  comment.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey || event.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    if (!event.repeat && !save.disabled) form.requestSubmit(save);
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!pending || !comment.value.trim() || readingAnnotationFiles || sender.sending) return;
    const annotation = { ...pending, comment: comment.value.trim() };
    if (annotationFiles.length) annotation.images = annotationFiles;
    else delete annotation.images;
    const next = editing >= 0 ? annotations.map((item, i) => i === editing ? annotation : item) : [...annotations, annotation];
    dialog.close();
    setAnnotations(next);
    status("Question saved in Your annotations. Send when ready.");
  });

  send.addEventListener("click", () => {
    if (annotations.length) void sender.send({ annotations }, () => setAnnotations([]));
  });

  return {
    start(imagesSupported) {
      annotationImagesSupported = imagesSupported;
      $("comment-images").hidden = $("comment-attach").hidden = !imagesSupported;
      $("empty").textContent = "Highlight text in a Pi reply to ask about it.";
      send.classList.add("chat-question-send");
      setTooltip(send, "Send questions");
      send.setAttribute("aria-label", "Send 0 questions");
      send.replaceChildren();
      send.innerHTML = '<span class="send-icon" aria-hidden="true">🚀</span><span id="count" class="send-count">0</span>';
      $("annotation-heading").append(send);
    },
    updateControls,
    hideSelectionAction,
    isDialogOpen: () => dialog.open,
    hasDraft: () => Boolean(annotations.length || comment.value.trim() || annotationFiles.length || readingAnnotationFiles),
  };
}
