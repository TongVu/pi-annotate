import { mountExplorer } from "./explorer.js";
import { mountTranscript } from "./transcript.js";

export async function mountChatPage(window, { token, tooltipFactory, loadNotes = () => import("./notes.js") }) {
  const { document, FileReader, crypto, Node, Option } = window;
  const $ = (id) => document.getElementById(id);
  const responseElement = $("response");
  const dialog = $("comment-dialog");
  const selectionAction = $("annotate-selection");
  const comment = $("comment");
  const send = $("send");
  let annotations = [];
  let annotationImagesSupported = false;
  let annotationFiles = [];
  let readingAnnotationFiles = false;
  const chatInput = $("chat-input");
  const chatFile = $("chat-file");
  const contextButton = $("chat-context");
  const contextDetails = $("chat-context-details");
  const modelToggle = $("chat-model-toggle");
  const modelPanel = $("chat-model-panel");
  const modelSelect = $("chat-model");
  const effortSelect = $("chat-effort");
  const compactButton = $("chat-compact");
  const compactDialog = $("compact-chat-dialog");
  const confirmCompact = $("confirm-chat-compact");
  const chatToolsToggle = $("chat-tools-toggle");
  const imagePreview = $("image-preview");
  const previewImage = $("preview-image");
  const sessionTitlePill = $("session-title-pill");
  const sessionTitleText = $("session-title-text");
  const renameSessionDialog = $("rename-session-dialog");
  const renameSessionInput = $("rename-session-input");
  const saveSessionName = $("save-session-name");
  const previewTypes = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
  const MAX_ATTACHMENTS = 10;
  const FILE_LIMIT = 5 * 1024 * 1024;
  const ATTACHMENTS_LIMIT = 10 * 1024 * 1024;
  let attachments = [];
  let readingFiles = false;
  let cursor = null;
  const appTitle = "Pi Chat";
  let liveTitle = appTitle;
  let chatTitleStatus = "⚪";
  let liveSessionName;
  let busy = false;
  let compactAvailable = false;
  let compacting = false;
  let modelSettings;
  let modelLoading = false;
  let modelChanging = false;
  let failed = false;
  let connected = true;
  let acceptedSends = 0;
  let lastAttempt;
  let selectedPassage;
  let pending;
  let sending = false;
  let editing = -1;

  function status(message, error = false) {
    $("status").textContent = message;
    $("status").classList.toggle("error", error);
  }

  function updateLiveDocumentTitle() {
    // Keep the session name first: the tab strip can hide prefixes shared by multiple chats.
    document.title = `${liveTitle} · ${chatTitleStatus}`;
  }

  function updateSessionTitle(name) {
    liveSessionName = typeof name === "string" && name.trim() ? name.trim() : undefined;
    liveTitle = liveSessionName || appTitle;
    sessionTitleText.textContent = liveSessionName || "Untitled chat";
    sessionTitleText.setAttribute("aria-label", `Rename ${sessionTitleText.textContent}`);
    setTooltip(sessionTitleText, `${sessionTitleText.textContent}\nClick to rename`);
    if (!explorer.isSaved()) updateLiveDocumentTitle();
    explorer.setLiveSessionName(liveSessionName);
  }

  async function api(path, body, { keepalive = false } = {}) {
    const res = await window.fetch(path, {
      method: body === undefined ? "GET" : "POST",
      keepalive,
      headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      // The document's no-referrer policy can make a same-origin POST's Origin opaque.
      ...(body === undefined ? {} : { body: JSON.stringify(body), referrerPolicy: "same-origin" }),
    });
    const data = await res.json();
    if (!res.ok) throw Object.assign(new Error(data.error || "Could not connect to Pi."), { status: res.status });
    return data;
  }

  function isRetry(body) {
    // Both drafts replace their arrays on edits; retries can compare references without serializing images.
    return lastAttempt && lastAttempt.attachments === body.attachments &&
      lastAttempt.annotations === body.annotations && lastAttempt.text === body.text;
  }

  function canSend(body) {
    return !explorer.isSaved() && !sending && !compacting && !modelChanging && connected && (!busy || isRetry(body));
  }

  function composerBody() {
    return { text: chatInput.value.trim(), ...(attachments.length ? { attachments } : {}) };
  }

  function updateButtons() {
    send.disabled = !annotations.length || !canSend({ annotations });
    const body = composerBody();
    $("chat-send").disabled = (!body.text && !body.attachments) || readingFiles || !canSend(body);
    compactButton.disabled = confirmCompact.disabled = !compactAvailable || !connected || busy || sending || compacting || modelChanging || explorer.isSaved();
    updateModelControls();
    $("chat-attach").disabled = sending || readingFiles;
    for (const button of $("chat-attachments").querySelectorAll("button")) button.disabled = sending || readingFiles;
    $("comment-attach").disabled = sending || readingAnnotationFiles;
    $("save-annotation").disabled = sending || readingAnnotationFiles;
    for (const button of $("comment-attachments").querySelectorAll("button")) button.disabled = sending || readingAnnotationFiles;
    chatInput.readOnly = sending;
  }

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

  function renderAttachmentList(list, files, removeFile) {
    list.hidden = !files.length;
    list.replaceChildren();
    for (const [index, file] of files.entries()) {
      const item = document.createElement("li");
      const name = document.createElement("span");
      name.textContent = file.name;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "secondary";
      remove.textContent = "Remove";
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
      } else {
        item.append(name);
      }
      if (removeFile) item.append(remove);
      list.append(item);
    }
  }

  function setAttachments(next) {
    // Don't retain removed files after a failed send.
    if (lastAttempt?.attachments) lastAttempt = undefined;
    attachments = next;
    renderAttachmentList($("chat-attachments"), attachments, (index) => {
      setAttachments(attachments.filter((_, i) => i !== index));
      status("File removed from your draft.");
    });
    updateButtons();
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

  async function attachFiles(files) {
    if (!files.length || sending || readingFiles) return;
    readingFiles = true;
    updateButtons();
    try {
      checkAttachmentLimits(files, attachments);
      setAttachments([...attachments, ...await Promise.all(files.map(readAttachment))]);
      status(`${files.length === 1 ? "File" : `${files.length} files`} attached. Press Enter or click Send when ready.`);
    } catch (error) {
      status(error.message, true);
    } finally {
      readingFiles = false;
      updateButtons();
    }
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
    updateButtons();
  }

  async function attachAnnotationImages(files) {
    if (!annotationImagesSupported || !pending || !dialog.open || !files.length || sending || readingAnnotationFiles) return;
    const draft = pending;
    readingAnnotationFiles = true;
    updateButtons();
    try {
      if (files.some((file) => !previewTypes.has(file.type))) throw new Error("Choose PNG, JPEG, GIF, or WebP images.");
      const otherImages = annotations.flatMap((annotation, index) => index === editing ? [] : annotation.images ?? []);
      checkAttachmentLimits(files, [...otherImages, ...annotationFiles]);
      const images = await Promise.all(files.map(readAttachment));
      if (draft !== pending || !dialog.open) return;
      setAnnotationFiles([...annotationFiles, ...images]);
      commentFileStatus("");
    } catch (error) {
      if (draft === pending && dialog.open) commentFileStatus(error.message, true);
    } finally {
      if (draft === pending) {
        readingAnnotationFiles = false;
        updateButtons();
      }
    }
  }

  function setAnnotations(next) {
    if (lastAttempt?.annotations) lastAttempt = undefined;
    annotations = next;
    renderAnnotations();
  }

  function renderAnnotations() {
    $("count").textContent = String(annotations.length);
    send.setAttribute("aria-label", `Send ${annotations.length} question${annotations.length === 1 ? "" : "s"}`);
    updateButtons();
    $("empty").hidden = annotations.length > 0;
    $("annotations").replaceChildren();
    for (const [index, annotation] of annotations.entries()) {
      const item = document.createElement("li");
      item.className = "annotation-item";
      const quote = document.createElement("blockquote");
      quote.textContent = annotation.quote;
      const text = document.createElement("p");
      text.textContent = annotation.comment;
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
        button.disabled = sending;
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
    if (sending || dialog.open || explorer.isSaved()) return hideSelectionAction();
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
    if (!passage || sending || dialog.open || explorer.isSaved()) return;
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
    const images = Array.from(event.clipboardData?.files ?? []).filter((file) => file.type.startsWith("image/"));
    if (!images.length) return;
    event.preventDefault();
    void attachAnnotationImages(images);
  });
  $("comment-form").addEventListener("submit", (event) => {
    event.preventDefault();
    if (!pending || !comment.value.trim() || readingAnnotationFiles || sending) return;
    const annotation = { ...pending, comment: comment.value.trim() };
    if (annotationFiles.length) annotation.images = annotationFiles;
    else delete annotation.images;
    const next = editing >= 0 ? annotations.map((item, i) => i === editing ? annotation : item) : [...annotations, annotation];
    dialog.close();
    setAnnotations(next);
    status("Question saved in Your annotations. Send when ready.");
  });

  async function sendChat(body) {
    if (!canSend(body)) return;
    // An unchanged retry uses the same ID if Pi accepted it but the HTTP response was lost.
    if (!isRetry(body)) lastAttempt = { ...body, id: crypto.randomUUID() };
    sending = true;
    updateChatState();
    renderAnnotations();
    status("Sending to Pi…");
    try {
      await api("/api/chat", { ...body, requestId: lastAttempt.id });
      lastAttempt = undefined;
      if (body.annotations) annotations = [];
      else {
        chatInput.value = "";
        setAttachments([]);
      }
      busy = true; // The next fresh poll reconciles this with Pi, even for a very fast reply.
      acceptedSends++;
      status("Sent to Pi.");
    } catch (error) {
      status(error.message || "Could not confirm the send. Your draft is still here.", true);
    } finally {
      sending = false;
      updateChatState();
      renderAnnotations();
    }
  }

  for (const [buttonId, label] of [["chat-expand", "message composer"]]) {
    const button = $(buttonId);
    button.addEventListener("click", () => {
      const expanded = button.getAttribute("aria-expanded") !== "true";
      const action = expanded ? "Collapse" : "Expand";
      const text = `${action} ${label}`;
      button.setAttribute("aria-expanded", String(expanded));
      button.setAttribute("aria-label", text);
      setTooltip(button, text);
    });
  }

  chatToolsToggle.addEventListener("click", () => {
    const expanded = chatToolsToggle.getAttribute("aria-expanded") === "true";
    document.querySelector("main").classList.toggle("chat-tools-collapsed", expanded);
    chatToolsToggle.setAttribute("aria-expanded", String(!expanded));
    const label = `${expanded ? "Expand" : "Collapse"} notes and annotations`;
    chatToolsToggle.setAttribute("aria-label", label);
    setTooltip(chatToolsToggle, label);
  });

  chatInput.addEventListener("input", updateButtons);
  chatInput.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey || event.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    if (!event.repeat && !$("chat-send").disabled) $("chat-form").requestSubmit();
  });
  chatInput.addEventListener("paste", (event) => {
    const files = Array.from(event.clipboardData?.files ?? []);
    if (!files.length || sending) return;
    event.preventDefault();
    void attachFiles(files);
  });
  $("chat-attach").addEventListener("click", () => chatFile.click());
  chatFile.addEventListener("change", () => {
    const files = Array.from(chatFile.files);
    chatFile.value = "";
    void attachFiles(files);
  });
  $("chat-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const body = composerBody();
    if (!readingFiles && (body.text || body.attachments)) void sendChat(body);
  });
  send.addEventListener("click", async () => {
    if (!annotations.length || !canSend({ annotations })) return;
    await sendChat({ annotations });
  });
  function showContextDetails(open) {
    contextDetails.hidden = !open;
    contextButton.setAttribute("aria-expanded", String(open));
  }

  function updateContextUsage(usage) {
    const { tokens, contextWindow, percent } = usage ?? {};
    const known = Number.isFinite(tokens) && Number.isFinite(percent);
    const percentage = known ? `${percent.toLocaleString(undefined, { maximumFractionDigits: 1 })}%` : "";
    const label = known ? `Context usage: ${percentage}` : "Context usage";
    setTooltip(contextButton, label);
    contextButton.setAttribute("aria-label", label);
    $("chat-context-ring").setAttribute("stroke-dasharray", `${known ? Math.min(100, Math.max(0, percent)) : 0} 100`);
    $("chat-context-usage").textContent = known
      ? `Estimated ${tokens.toLocaleString()} of ${contextWindow.toLocaleString()} tokens used (${percentage}).`
      : contextWindow ? `Model limit: ${contextWindow.toLocaleString()} tokens. Usage is unavailable until the next reply.`
      : "Context usage is unavailable.";
  }

  function showModelPanel(open) {
    modelPanel.hidden = !open;
    modelToggle.setAttribute("aria-expanded", String(open));
  }

  function updateModelControls() {
    const locked = !connected || busy || sending || compacting || modelChanging || modelLoading;
    modelSelect.disabled = locked || !modelSettings?.models.length;
    effortSelect.disabled = locked || (modelSettings?.efforts.length ?? 0) < 2;
    const message = modelLoading ? "Loading Pi’s settings…" : modelChanging ? "Changing settings…"
      : !connected ? "Disconnected from Pi." : locked ? "Wait for Pi to finish before changing settings." : "";
    const hint = $("chat-model-status");
    if (hint.textContent !== message) hint.textContent = message;
  }

  function renderModelSettings() {
    const { model, models, effort, efforts } = modelSettings;
    modelSelect.replaceChildren(...models.map(({ key, label }) => new Option(label, key)));
    if (!models.some(({ key }) => key === model?.key)) {
      const current = new Option(model?.label ?? "No model selected", model?.key ?? "");
      current.disabled = true;
      modelSelect.prepend(current);
    }
    modelSelect.value = model?.key ?? "";
    effortSelect.replaceChildren(...efforts.map((level) => new Option(level === "xhigh" ? "Extra high" : level[0].toUpperCase() + level.slice(1), level)));
    effortSelect.value = effort;
  }

  modelToggle.addEventListener("click", async () => {
    if (!modelPanel.hidden) return showModelPanel(false);
    showContextDetails(false);
    showModelPanel(true);
    if (modelLoading || modelChanging) return;
    modelLoading = true;
    $("chat-model-error").textContent = "";
    updateModelControls();
    try {
      modelSettings = await api("/api/session/model");
      renderModelSettings();
    } catch (error) {
      modelSettings = undefined;
      modelSelect.replaceChildren();
      effortSelect.replaceChildren();
      $("chat-model-error").textContent = error.message;
    } finally {
      modelLoading = false;
      updateModelControls();
    }
  });
  for (const [field, key] of [[modelSelect, "model"], [effortSelect, "effort"]]) {
    field.addEventListener("change", async () => {
      if (field.disabled || !field.value) return;
      modelChanging = true;
      $("chat-model-error").textContent = "";
      updateButtons();
      try {
        modelSettings = await api("/api/session/model", { [key]: field.value });
      } catch (error) {
        $("chat-model-error").textContent = error.message;
      } finally {
        modelChanging = false;
        renderModelSettings();
        updateButtons();
      }
    });
  }

  contextButton.addEventListener("click", () => {
    showModelPanel(false);
    showContextDetails(contextDetails.hidden);
  });
  document.addEventListener("pointerdown", (event) => {
    if (!contextDetails.hidden && !contextDetails.contains(event.target) && !contextButton.contains(event.target)) showContextDetails(false);
    if (!modelPanel.hidden && !modelPanel.contains(event.target) && !modelToggle.contains(event.target)) showModelPanel(false);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    if (!contextDetails.hidden) showContextDetails(false);
    if (!modelPanel.hidden) {
      showModelPanel(false);
      modelToggle.focus();
    }
  });
  compactButton.addEventListener("click", () => {
    showContextDetails(false);
    compactDialog.showModal();
  });
  $("cancel-chat-compact").addEventListener("click", () => compactDialog.close());
  confirmCompact.addEventListener("click", async () => {
    if (!compactDialog.open || confirmCompact.disabled) return;
    compactDialog.close();
    compacting = true;
    status("Compacting chat…");
    updateChatState();
    updateButtons();
    try {
      await api("/api/session/compact", {});
      status("Chat compacted.");
    } catch (error) {
      status(error.message || "Could not compact this chat.", true);
    } finally {
      compacting = false;
      updateChatState();
      updateButtons();
    }
  });

  const chatStates = {
    working: "Pi is working…",
    ready: "Pi is ready for the next task.",
    stopped: "Pi stopped. Check the terminal for details.",
    disconnected: "Disconnected. If it persists, run /chat again in Pi.",
  };

  let faviconLogo;
  async function loadFaviconLogo() {
    try {
      const response = await window.fetch("/logo.png");
      if (!response.ok) return;
      const bytes = new Uint8Array(await response.arrayBuffer());
      faviconLogo = `data:image/png;base64,${window.btoa(String.fromCharCode(...bytes))}`;
    } catch { /* Fall back to the static favicon if the logo cannot be loaded. */ }
  }

  function updateFaviconStatus(state) {
    if (!faviconLogo) return;
    const colors = { ready: "#2f9b69", working: "#dc4141", stopped: "#d99b25", disconnected: "#858b91" };
    const statusColor = colors[state] ?? colors.disconnected;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><image href="${faviconLogo}" width="32" height="32"/><circle cx="26" cy="26" r="5" fill="${statusColor}" stroke="white" stroke-width="2"/></svg>`;
    const favicon = $("app-favicon");
    favicon.type = "image/svg+xml";
    favicon.href = `data:image/svg+xml,${encodeURIComponent(svg)}`;
  }

  function updateChatState() {
    const state = !connected ? "disconnected" : sending || busy || compacting ? "working" : failed ? "stopped" : "ready";
    const indicator = $("chat-state");
    if (indicator.dataset.state === state) return;
    indicator.dataset.state = state;
    setTooltip(indicator, chatStates[state]);
    indicator.querySelector(".chat-state-label").textContent = chatStates[state];
    chatTitleStatus = ({ ready: "✓ Ready", working: "🏗️", stopped: "🚫", disconnected: "🔌" })[state] ?? "🔌";
    updateFaviconStatus(state);
    if (!explorer.isSaved()) updateLiveDocumentTitle();
  }

  // An older running Pi server may serve this file without the shared prefix.
  const { set: setTooltip, hide: hideMessagePreview } = tooltipFactory
    ? tooltipFactory({ sideTargets: "#turns, #chat-explorer" })
    : { set: (target, text) => { target.title = text; }, hide: () => {} };

  function updateChat(data) {
    if (data.mode !== "chat" || !Array.isArray(data.messages)) throw new Error("Chat data is unavailable. Reopen from Pi.");
    const sessionName = data.sessionName?.trim();
    updateSessionTitle(sessionName);
    transcript.appendLive(data.messages, { initial: !cursor });
    cursor = data.cursor;
    busy = data.busy;
    failed = data.failed;
    compactAvailable = data.canCompact === true;
    connected = true;
    updateContextUsage(data.contextUsage);
    updateChatState();
    updateButtons();
  }

  const focusTerminalButton = $("focus-terminal");
  focusTerminalButton.addEventListener("click", async () => {
    hideMessagePreview();
    focusTerminalButton.disabled = true;
    status("Switching to Terminal…");
    try {
      await api("/api/session/focus-terminal", {});
      status("");
    } catch (error) {
      status(error.status === 404 ? "Switch to Terminal needs the updated Pi extension. Run /reload, then reopen /chat." : error.message, true);
    } finally {
      focusTerminalButton.disabled = false;
    }
  });
  sessionTitleText.addEventListener("click", () => {
    if (explorer.isSaved()) return;
    hideMessagePreview();
    renameSessionInput.value = liveSessionName ?? "";
    $("rename-session-status").textContent = "";
    $("rename-session-status").classList.remove("error");
    renameSessionDialog.showModal();
    renameSessionInput.focus();
    renameSessionInput.select();
  });
  $("cancel-rename-session").addEventListener("click", () => renameSessionDialog.close());
  $("rename-session-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const name = renameSessionInput.value.trim();
    if (!name || name.length > 100) return;
    saveSessionName.disabled = true;
    try {
      const result = await api("/api/session/name", { name });
      updateSessionTitle(result.sessionName);
      renameSessionDialog.close();
      status("Chat renamed.");
    } catch (error) {
      const message = [404, 501].includes(error.status)
        ? "Renaming needs the updated Pi extension. Finish unsent drafts, run /reload, then reopen /chat."
        : error.message || "Could not rename this chat.";
      $("rename-session-status").textContent = message;
      $("rename-session-status").classList.add("error");
      status(message, true);
    } finally {
      saveSessionName.disabled = false;
    }
  });

  const dashboardButton = $("open-dashboard");
  dashboardButton.addEventListener("click", async () => {
    hideMessagePreview();
    dashboardButton.disabled = true;
    try {
      await api("/api/dashboard/open", {});
    } catch (error) {
      status(error.status === 404 ? "The dashboard button needs the updated Pi extension. Run /reload, then reopen /chat." : error.message, true);
    } finally {
      dashboardButton.disabled = false;
    }
  });
  const transcript = mountTranscript(window, {
    fetchImage: (query) => window.fetch(`/api/image?${query}`, { headers: { Authorization: `Bearer ${token}` } }),
    isViewingLive: () => !explorer.isSaved(),
    isCommentOpen: () => dialog.open,
    setTooltip, showImagePreview, status,
  });
  const explorer = mountExplorer(window, {
    api, status, setTooltip, hideMessagePreview,
    isConnected: () => connected,
    transcript,
    onViewChange() {
      hideSelectionAction();
      updateButtons();
    },
    onBackToLive() {
      updateLiveDocumentTitle();
      chatInput.focus({ preventScroll: true });
    },
  });

  function startChat(data, mountChatNotes) {
    // Older servers silently ignore the new attachments field on messages with a caption.
    if (data.protocol !== 2) throw new Error("Pi's chat server is outdated. Run /reload, then /chat in Pi.");
    annotationImagesSupported = data.annotationImages === true;
    $("comment-images").hidden = !annotationImagesSupported;
    $("comment-attach").hidden = !annotationImagesSupported;
    document.body.classList.add("chat-page");
    sessionTitlePill.hidden = false;
    const notes = mountChatNotes?.(window, { sessionId: data.sessionId, api, setTooltip });
    if (!notes) {
      // A listener started before this asset was added may still serve the entry script from disk.
      const note = $("chat-note");
      note.querySelector(".chat-note-actions").hidden = $("chat-note-box").hidden = true;
      $("chat-note-status").textContent = "Markdown notes could not load. Run /reload in Pi, then reopen /chat.";
      note.hidden = false;
    }
    $("page-intro").hidden = true;
    $("chat-state").after($("status"));
    $("conversation").setAttribute("aria-label", "Conversation");
    $("conversation-label").hidden = true;
    for (const id of ["chat-rail", "turns", "chat-form", "chat-state"]) $(id).hidden = false;
    $("empty").textContent = "Highlight text in a Pi reply to ask about it.";
    send.classList.add("chat-question-send");
    setTooltip(send, "Send questions");
    send.setAttribute("aria-label", "Send 0 questions");
    send.replaceChildren();
    send.innerHTML = '<span class="send-icon" aria-hidden="true">🚀</span><span id="count" class="send-count">0</span>';
    $("annotation-heading").append(send);
    window.addEventListener("pagehide", () => {
      // A closing tab can't wait for a reply. If the request is dropped, the idle timer reaps it.
      const markdown = notes?.markdownForClose();
      const body = markdown === undefined ? {} : { markdown };
      void api("/api/close", body, { keepalive: true }).catch(() => {});
    }, { once: true });
    updateChat(data);
    status("");
    async function poll() {
      try {
        const wasConnected = connected;
        const sendsAtPollStart = acceptedSends;
        const data = await api(cursor === null ? "/api/response" : `/api/response?after=${encodeURIComponent(cursor)}`);
        // A poll started before send acknowledgement may still report the previous idle state.
        if (sendsAtPollStart === acceptedSends) updateChat(data);
        if (!wasConnected) explorer.refreshConnection();
        explorer.pollActivity();
      } catch (error) {
        const wasConnected = connected;
        connected = false;
        updateContextUsage();
        if (wasConnected) explorer.refreshConnection();
        updateChatState();
        updateButtons();
        if ([401, 410].includes(error.status)) return;
      }
      window.setTimeout(poll, connected ? 1000 : 3000);
    }
    window.setTimeout(poll, 1000);
  }

  window.addEventListener("beforeunload", (event) => {
    if (annotations.length || comment.value.trim() || annotationFiles.length || readingAnnotationFiles || chatInput.value.trim() || attachments.length || readingFiles) {
      event.preventDefault();
      event.returnValue = "";
    }
  });
  try {
    const [data, notes] = await Promise.all([api("/api/response"), loadNotes().catch(() => undefined), loadFaviconLogo()]);
    if (data.mode !== "chat") throw new Error("Pi's chat server is outdated. Run /reload, then /chat in Pi.");
    startChat(data, notes?.mountChatNotes);
  } catch (error) {
    status(error.message || "Could not load response.", true);
  }
}
