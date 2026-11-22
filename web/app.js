const token = location.hash.slice(1);
// Do not leave the capability in history/address bar. It remains in this page's memory only.
history.replaceState(null, "", location.pathname);
const $ = (id) => document.getElementById(id);
const responseElement = $("response");
const turnRail = $("turns");
const turns = [];
let currentDot;
const dialog = $("comment-dialog");
const comment = $("comment");
const send = $("send");
let annotations = [];
let annotationImagesSupported = false;
let annotationFiles = [];
let readingAnnotationFiles = false;
const chatInput = $("chat-input");
const chatFile = $("chat-file");
const chatNote = $("chat-note");
const chatNoteDialog = $("chat-note-dialog");
const chatNoteInput = $("chat-note-input");
const chatNotePreview = $("chat-note-preview");
const chatNotePreviewToggle = $("chat-note-preview-toggle");
const chatNoteCopy = $("chat-note-copy");
const chatNoteExpand = $("chat-note-expand");
let chatSessionId;
let chatNoteReady = false;
let chatNoteSaveTimer;
let chatNoteSaveQueue = Promise.resolve();
let chatNotePreviewing = false;
let chatNoteHome;
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
let chatStatusEmoji = "⚪";
let liveSessionName;
let catalog;
let catalogProblem = "";
let openingSavedChat;
let activeSessions = [];
let nextActivityCheck = 0;
let activityInFlight = false;
let savedSessionId;
let savedSelection = 0;
let liveScroll;
let busy = false;
let connected = true;
let lastAttempt;
let pending;
let sending = false;
let editing = -1;

function status(message, error = false) {
  $("status").textContent = message;
  $("status").classList.toggle("error", error);
}

function chatNoteStatus(message, error = false) {
  const element = $("chat-note-status");
  element.textContent = message;
  element.classList.toggle("error", error);
}

function updateChatNoteControls() {
  chatNoteCopy.disabled = !chatNoteReady || !chatNoteInput.value.trim();
}

function loadChatNote(sessionId) {
  chatSessionId = typeof sessionId === "string" && sessionId ? sessionId : undefined;
  chatNoteReady = false;
  chatNoteInput.value = "";
  chatNotePreview.replaceChildren();
  chatNoteInput.hidden = false;
  chatNotePreview.hidden = true;
  chatNotePreviewing = false;
  chatNote.dataset.previewing = "false";
  chatNoteExpand.hidden = false;
  chatNoteExpand.setAttribute("aria-expanded", "false");
  chatNoteExpand.setAttribute("aria-label", "Expand Markdown note");
  chatNoteExpand.title = "Expand Markdown note";
  chatNotePreviewToggle.setAttribute("aria-label", "Preview note");
  chatNotePreviewToggle.title = "Preview Markdown note";
  chatNotePreviewToggle.setAttribute("aria-pressed", "false");
  chatNoteStatus("");
  if (!chatSessionId) {
    chatNoteReady = true;
    chatNoteStatus("Session ID unavailable. Run /reload in Pi, then reopen /chat to save this note.", true);
    updateChatNoteControls();
    return;
  }
  chatNoteInput.disabled = true;
  chatNoteExpand.disabled = true;
  chatNotePreviewToggle.disabled = true;
  chatNoteStatus("Loading this chat’s saved note…");
  let legacyNote = null;
  const legacyKey = `pi-annotate:markdown-note:v1:${chatSessionId}`;
  try { legacyNote = localStorage.getItem(legacyKey); } catch { /* The server store remains authoritative. */ }
  void (async () => {
    try {
      const saved = await api("/api/note");
      if (typeof saved.markdown !== "string") throw new Error("Invalid saved note response.");
      let markdown = saved.markdown;
      if (!markdown && legacyNote) {
        await api("/api/note", { markdown: legacyNote });
        markdown = legacyNote;
      }
      chatNoteInput.value = markdown;
      try { localStorage.removeItem(legacyKey); } catch { /* Migration can be retried next time. */ }
      chatNoteStatus("");
    } catch (error) {
      chatNoteInput.value = legacyNote ?? "";
      chatNoteStatus(error.message || "Could not load this chat’s saved note.", true);
    } finally {
      chatNoteReady = true;
      chatNoteInput.disabled = false;
      chatNoteExpand.disabled = false;
      chatNotePreviewToggle.disabled = false;
      updateChatNoteControls();
    }
  })();
}

function updateLiveDocumentTitle() {
  document.title = `${chatStatusEmoji} ${liveTitle}`;
}

function updateSessionTitle(name) {
  liveSessionName = typeof name === "string" && name.trim() ? name.trim() : undefined;
  liveTitle = liveSessionName || appTitle;
  sessionTitleText.textContent = liveSessionName || "Untitled chat";
  $("rename-session").setAttribute("aria-label", liveSessionName ? `Rename ${liveSessionName}` : "Name this chat");
  if (!savedSessionId) updateLiveDocumentTitle();
  if (catalog && catalog.current.name !== liveSessionName) {
    catalog.current.name = liveSessionName;
    renderSessionList();
  }
}

async function api(path, body, { keepalive = false } = {}) {
  const res = await fetch(path, {
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
  return !savedSessionId && !sending && connected && (!busy || isRetry(body));
}

function composerBody() {
  return { text: chatInput.value.trim(), ...(attachments.length ? { attachments } : {}) };
}

function updateButtons() {
  send.disabled = !annotations.length || !canSend({ annotations });
  const body = composerBody();
  $("chat-send").disabled = (!body.text && !body.attachments) || readingFiles || !canSend(body);
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
      remove.title = `Remove ${file.name}`;
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
      button.title = action.label;
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

function selectPassage() {
  if (sending || dialog.open) return;
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) return;
  const range = selection.getRangeAt(0);
  const startElement = range.startContainer.nodeType === Node.ELEMENT_NODE ? range.startContainer : range.startContainer.parentElement;
  const passage = startElement?.closest("[data-response-id]");
  if (!passage || !responseElement.contains(passage) || !passage.contains(range.startContainer) || !passage.contains(range.endContainer)) return;
  const before = range.cloneRange();
  before.selectNodeContents(passage);
  before.setEnd(range.startContainer, range.startOffset);
  let start = before.toString().length;
  let quote = range.toString();
  const leading = quote.length - quote.trimStart().length;
  start += leading;
  quote = quote.trim();
  if (!quote) return;
  if (annotations.length >= 50) {
    status("Maximum 50 annotations per batch.", true);
    return;
  }
  editing = -1;
  showComment({ start, end: start + quote.length, quote, responseId: passage.dataset.responseId });
}

// Native browser selection, not a clipboard read. Keyboard selection is supported too.
responseElement.addEventListener("mouseup", selectPassage);
responseElement.addEventListener("keyup", (event) => {
  if (event.key === "Shift") selectPassage();
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
  status("Question saved in the right panel. Send when ready.");
});

async function sendChat(body) {
  if (!canSend(body)) return;
  // An unchanged retry uses the same ID if Pi accepted it but the HTTP response was lost.
  if (!isRetry(body)) lastAttempt = { ...body, id: crypto.randomUUID() };
  sending = true;
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
    busy = true; // The next poll reconciles this with Pi, even for a very fast reply.
    if (connected) setChatState("working");
    status("Sent to Pi.");
  } catch (error) {
    status(error.message || "Could not confirm the send. Your draft is still here.", true);
  } finally {
    sending = false;
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
    button.title = text;
  });
}

function restoreChatNoteFromDialog() {
  if (!chatNoteHome) return;
  const { parent, nextSibling } = chatNoteHome;
  parent.insertBefore(chatNote, nextSibling?.parentNode === parent ? nextSibling : null);
  chatNoteHome = undefined;
  chatNoteExpand.setAttribute("aria-expanded", "false");
  chatNoteExpand.setAttribute("aria-label", "Expand Markdown note");
  chatNoteExpand.title = "Expand Markdown note";
}

chatNoteExpand.addEventListener("click", () => {
  if (chatNoteDialog.open) {
    chatNoteDialog.close();
    return;
  }
  chatNoteHome = { parent: chatNote.parentNode, nextSibling: chatNote.nextSibling };
  chatNoteDialog.append(chatNote);
  chatNoteExpand.setAttribute("aria-expanded", "true");
  chatNoteExpand.setAttribute("aria-label", "Collapse Markdown note");
  chatNoteExpand.title = "Collapse Markdown note";
  try { chatNoteDialog.showModal(); }
  catch {
    restoreChatNoteFromDialog();
    chatNoteStatus("Could not expand the Markdown note.", true);
  }
});
chatNoteDialog.addEventListener("close", restoreChatNoteFromDialog);
chatNoteDialog.addEventListener("click", (event) => {
  if (event.target === chatNoteDialog) chatNoteDialog.close();
});

function saveChatNote(keepalive = false) {
  clearTimeout(chatNoteSaveTimer);
  if (!chatSessionId || !chatNoteReady) return Promise.resolve();
  const markdown = chatNoteInput.value;
  const save = chatNoteSaveQueue.catch(() => {}).then(() => api("/api/note", { markdown }, { keepalive }));
  chatNoteSaveQueue = save;
  return save.then(() => {
    if (!keepalive && markdown === chatNoteInput.value) chatNoteStatus("Saved for this chat.");
  }, (error) => {
    if (markdown === chatNoteInput.value) chatNoteStatus(error.message || "Could not save this chat’s note.", true);
  });
}

chatNoteInput.addEventListener("input", () => {
  updateChatNoteControls();
  chatNoteStatus("");
  if (!chatSessionId) {
    chatNoteStatus("Session ID unavailable. Run /reload in Pi, then reopen /chat to save this note.", true);
    return;
  }
  if (!chatNoteReady) return;
  clearTimeout(chatNoteSaveTimer);
  chatNoteSaveTimer = setTimeout(() => { void saveChatNote(); }, 350);
});
chatNoteInput.addEventListener("blur", () => { void saveChatNote(); });
chatNotePreviewToggle.addEventListener("click", async () => {
  if (chatNotePreviewing) {
    chatNoteInput.hidden = false;
    chatNotePreview.hidden = true;
    chatNote.dataset.previewing = "false";
    chatNotePreviewing = false;
    chatNotePreviewToggle.setAttribute("aria-label", "Preview note");
    chatNotePreviewToggle.title = "Preview Markdown note";
    chatNotePreviewToggle.setAttribute("aria-pressed", "false");
    chatNoteInput.focus();
    return;
  }
  chatNotePreviewToggle.disabled = true;
  chatNoteStatus("");
  try {
    const { html } = await api("/api/markdown", { markdown: chatNoteInput.value });
    chatNotePreview.innerHTML = html || "<p>Nothing to preview yet.</p>";
    chatNoteInput.hidden = true;
    chatNotePreview.hidden = false;
    chatNote.dataset.previewing = "true";
    chatNotePreviewing = true;
    chatNotePreviewToggle.setAttribute("aria-label", "Edit note");
    chatNotePreviewToggle.title = "Edit Markdown note";
    chatNotePreviewToggle.setAttribute("aria-pressed", "true");
  } catch (error) {
    chatNoteStatus(error.message || "Could not preview this note.", true);
  } finally {
    chatNotePreviewToggle.disabled = false;
  }
});
chatNoteCopy.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(chatNoteInput.value);
    chatNoteStatus("Copied Markdown to clipboard.");
  } catch {
    chatNoteStatus("Clipboard access failed. Select and copy the note text instead.", true);
  }
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
function markCurrentDot(dot) {
  if (currentDot === dot) return;
  currentDot?.removeAttribute("aria-current");
  currentDot = dot;
  dot.setAttribute("aria-current", "location");
  const rail = turnRail.getBoundingClientRect();
  const position = dot.getBoundingClientRect();
  if (position.top < rail.top) turnRail.scrollTop += position.top - rail.top;
  else if (position.bottom > rail.bottom) turnRail.scrollTop += position.bottom - rail.bottom;
}

function updateCurrentTurn() {
  if (!turns.length) return;
  const atEnd = responseElement.scrollHeight - responseElement.scrollTop - responseElement.clientHeight <= 2;
  const readingLine = responseElement.getBoundingClientRect().top + 24;
  const current = atEnd ? turns.at(-1) : turns.findLast(({ turn }) => turn.getBoundingClientRect().top <= readingLine) ?? turns[0];
  markCurrentDot(current.dot);
}

const imageLoaders = new WeakMap();
function observeImages(root) {
  return typeof IntersectionObserver === "function" ? new IntersectionObserver((entries, observer) => {
    for (const { target, isIntersecting } of entries) {
      if (!isIntersecting) continue;
      observer.unobserve(target);
      if (target.isConnected) void imageLoaders.get(target)().catch(() => {}); // The preview button can retry.
    }
  }, { root, rootMargin: "120px" }) : null;
}
const transcriptImageObserver = observeImages(responseElement);
const savedResponse = $("saved-response");
const savedImageObserver = observeImages(savedResponse);

function appendTranscriptImages(turn, { id, imageCount }, session) {
  if (!imageCount) return;
  const images = document.createElement("div");
  images.className = "transcript-images";
  for (let index = 0; index < imageCount; index++) {
    const name = `Image ${index + 1}`; // Pi's stored image blocks have no filename.
    const open = document.createElement("button");
    open.type = "button";
    open.className = "secondary attachment-preview";
    open.setAttribute("aria-label", `Preview ${name}`);
    const thumbnail = document.createElement("img");
    thumbnail.alt = "";
    open.append(thumbnail, name);
    const query = new URLSearchParams({ id, index });
    if (session) query.set("session", session);
    const observer = session ? savedImageObserver : transcriptImageObserver;
    let pendingImage;
    const load = () => pendingImage ??= (async () => {
      const result = await fetch(`/api/image?${query}`, { headers: { Authorization: `Bearer ${token}` } });
      if (!result.ok) throw new Error("Could not load this image from Pi.");
      const blob = await result.blob();
      if (!open.isConnected) throw new Error("Image is no longer in view.");
      const src = URL.createObjectURL(blob);
      thumbnail.src = src;
      return src;
    })().catch((error) => { pendingImage = undefined; throw error; });
    imageLoaders.set(open, load);
    open.addEventListener("click", async () => {
      try {
        const src = await load();
        if (open.isConnected && (session || !savedSessionId)) showImagePreview(name, src);
      } catch { if (open.isConnected) status("Could not load this image from Pi.", true); }
    });
    images.append(open);
    if (observer) observer.observe(open);
    else void load().catch(() => {});
  }
  turn.append(images);
}

const chatStates = {
  working: "Pi is working…",
  ready: "Pi is ready for the next task.",
  stopped: "Pi stopped. Check the terminal for details.",
  disconnected: "Disconnected. If it persists, run /chat again in Pi.",
};

function updateFaviconStatus(state) {
  const colors = { ready: "#2f9b69", working: "#dc4141", stopped: "#d99b25", disconnected: "#858b91" };
  const statusColor = colors[state] ?? colors.disconnected;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><defs><linearGradient id="g" x2="1" y2="1"><stop stop-color="#4169f5"/><stop offset="1" stop-color="#16c3b4"/></linearGradient></defs><rect width="32" height="32" rx="7" fill="url(#g)"/><g fill="none" stroke="white" stroke-width="2.2" stroke-linecap="round"><path d="m8 11 8-5 8 5v10l-8 5-8-5zM8 11l8 5 8-5M16 16v10m-8-5 8-5 8 5"/></g><g fill="white"><circle cx="8" cy="11" r="3"/><circle cx="16" cy="6" r="3"/><circle cx="24" cy="11" r="3"/><circle cx="8" cy="21" r="3"/><circle cx="16" cy="16" r="3"/><circle cx="24" cy="21" r="3"/><circle cx="16" cy="26" r="3"/></g><circle cx="26" cy="26" r="5" fill="${statusColor}" stroke="white" stroke-width="2"/></svg>`;
  const favicon = $("app-favicon");
  favicon.type = "image/svg+xml";
  favicon.href = `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function setChatState(state) {
  const indicator = $("chat-state");
  if (indicator.dataset.state === state) return;
  indicator.dataset.state = state;
  indicator.title = chatStates[state];
  indicator.querySelector(".chat-state-label").textContent = chatStates[state];
  chatStatusEmoji = ({ ready: "👾", working: "🏗️", stopped: "🚫", disconnected: "🔌" })[state] ?? "🔌";
  updateFaviconStatus(state);
  if (!savedSessionId) updateLiveDocumentTitle();
}

function renderTurn(message, session) {
  const turn = document.createElement("section");
  const assistant = message.role === "assistant";
  turn.className = `chat-turn ${assistant ? "assistant-turn" : "user-turn"}`;
  const content = document.createElement("div");
  if (assistant) {
    const label = document.createElement("h2");
    label.textContent = "Pi";
    turn.append(label);
    // Same restricted Markdown renderer and DOM-text check as the live transcript.
    content.innerHTML = message.html;
    if (content.textContent !== message.text) content.textContent = "This reply could not be rendered safely. See Pi in the terminal.";
    else if (!session) content.dataset.responseId = message.id;
  } else {
    turn.setAttribute("aria-label", "Your message");
    content.textContent = message.text;
  }
  if (message.text || assistant) turn.append(content);
  if (!assistant) appendTranscriptImages(turn, message, session);
  return turn;
}

const nearChatEnd = () => responseElement.scrollHeight - responseElement.scrollTop - responseElement.clientHeight < 80;
let messagePreview;
let previewedTarget;
function hideMessagePreview() {
  previewedTarget?.removeAttribute("aria-describedby");
  previewedTarget = undefined;
  messagePreview?.remove();
  messagePreview = undefined;
}
function bindMessageTooltip(target, text) {
  target.removeAttribute("title");
  target.dataset.tooltip = text;
  target.addEventListener("mouseenter", () => showMessagePreview(target, text));
  target.addEventListener("mouseleave", hideMessagePreview);
  target.addEventListener("focus", () => showMessagePreview(target, text));
  target.addEventListener("blur", hideMessagePreview);
}

document.querySelectorAll('#chat-explorer [title], #explorer-toggle[title]').forEach((target) => bindMessageTooltip(target, target.title));

function showMessagePreview(dot, text) {
  hideMessagePreview();
  messagePreview = document.createElement("div");
  messagePreview.id = "message-preview";
  messagePreview.className = "message-preview";
  messagePreview.setAttribute("role", "tooltip");
  messagePreview.textContent = text;
  document.body.append(messagePreview);
  previewedTarget = dot;
  dot.setAttribute("aria-describedby", messagePreview.id);
  const rect = dot.getBoundingClientRect();
  const bounds = messagePreview.getBoundingClientRect();
  const gap = 8;
  const placeRight = rect.right + gap + bounds.width <= window.innerWidth - gap;
  messagePreview.classList.toggle("message-preview-left", !placeRight);
  const left = placeRight ? rect.right + gap : Math.max(gap, rect.left - bounds.width - gap);
  const top = Math.max(gap, Math.min(rect.top + rect.height / 2 - bounds.height / 2, window.innerHeight - bounds.height - gap));
  messagePreview.style.left = `${left}px`;
  messagePreview.style.top = `${top}px`;
}

turnRail.addEventListener("scroll", hideMessagePreview, { passive: true });
window.addEventListener("resize", hideMessagePreview);

function updateChat(data) {
  if (data.mode !== "chat" || !Array.isArray(data.messages)) throw new Error("Chat data is unavailable. Reopen from Pi.");
  const sessionName = data.sessionName?.trim();
  updateSessionTitle(sessionName);
  const follow = !cursor || nearChatEnd();
  const fragment = document.createDocumentFragment();
  const dots = document.createDocumentFragment();
  for (const message of data.messages) {
    const turn = renderTurn(message);
    if (message.role === "user") {
      const preview = message.text.trim().replace(/\s+/g, " ") || "Image attachment";
      const dot = document.createElement("button");
      dot.type = "button";
      dot.setAttribute("aria-label", `Jump to your message: ${preview}`);
      dot.addEventListener("mouseenter", () => showMessagePreview(dot, preview));
      dot.addEventListener("mouseleave", hideMessagePreview);
      dot.addEventListener("focus", () => showMessagePreview(dot, preview));
      dot.addEventListener("blur", hideMessagePreview);
      dot.addEventListener("click", () => {
        responseElement.scrollTop += turn.getBoundingClientRect().top - responseElement.getBoundingClientRect().top;
        markCurrentDot(dot);
      });
      turns.push({ turn, dot });
      dots.append(dot);
    }
    fragment.append(turn);
  }
  responseElement.append(fragment);
  turnRail.append(dots);
  if (data.messages.length && !savedSessionId) {
    if (follow && !dialog.open && window.getSelection()?.isCollapsed !== false) {
      responseElement.scrollTop = responseElement.scrollHeight;
    }
    updateCurrentTurn();
  }
  cursor = data.cursor;
  busy = data.busy;
  connected = true;
  setChatState(busy ? "working" : data.failed ? "stopped" : "ready");
  updateButtons();
}

const explorer = $("chat-explorer");
const explorerToggle = $("explorer-toggle");
const sessionFilter = $("session-filter");
const refreshSessions = $("refresh-sessions");
const openSavedButton = $("open-saved-chat");
const projectControls = $("project-view-controls");
const projectView = () => ({ mode: "normal", collapsed: new Set(), overrides: new Set() });
const browseProjects = projectView();
let searchProjects = projectView();
const currentProjectView = () => sessionFilter.value.trim() ? searchProjects : browseProjects;

async function copyResumeCommand(id) {
  const command = api(`/api/session/resume?${new URLSearchParams({ id })}`).then((data) => data.command);
  try {
    if (navigator.clipboard?.write && typeof ClipboardItem === "function") {
      // Safari needs the clipboard write itself to start within the click, before the fetch resolves.
      const text = command.then((value) => new Blob([value], { type: "text/plain" }));
      void text.catch(() => {});
      await navigator.clipboard.write([new ClipboardItem({ "text/plain": text })]);
    } else {
      await navigator.clipboard.writeText(await command);
    }
    status("Resume command copied.");
  } catch {
    try {
      const field = $("resume-command");
      field.value = await command;
      $("resume-command-dialog").showModal();
      field.focus();
      field.select();
    } catch (error) {
      status(error.message || "Could not get this session’s resume command.", true);
    }
  }
}

$("close-resume-command").addEventListener("click", () => $("resume-command-dialog").close());
$("rename-session").addEventListener("click", () => {
  if (savedSessionId) return;
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

function updateSavedLaunchButton() {
  const saved = catalog?.sessions.find(({ id }) => id === savedSessionId);
  const alreadyOpen = activeSessions.some(({ id }) => id === savedSessionId);
  const opening = Boolean(saved && openingSavedChat === saved.id);
  openSavedButton.hidden = !catalog?.canOpen || !saved?.cwd;
  openSavedButton.disabled = !connected || alreadyOpen || opening;
  openSavedButton.textContent = alreadyOpen ? "Open in another tab" : opening ? "Starting Pi…" : "Resume in browser";
}

async function cloneChatSession(id, button) {
  if (button.disabled) return;
  button.disabled = true;
  try {
    await api("/api/session/clone", { id });
    status("Cloned chat in a new Pi session.");
  } catch (error) {
    status(error.message || "Could not clone this chat session.", true);
  } finally {
    button.disabled = false;
  }
}

async function openSavedInBrowser() {
  const id = savedSessionId;
  if (!id || openSavedButton.hidden || openSavedButton.disabled) return;
  openingSavedChat = id;
  updateSavedLaunchButton();
  try {
    const { attached } = await api("/api/session/open", { id });
    status(attached ? "Opened a tab for the running Pi session." : "Pi is opening the chat in a new tab. Check Terminal if it asks for approval.");
  } catch (error) {
    status(error.name === "TypeError" ? "Could not reach Pi. Reopen /chat from Terminal." : error.message || "Could not open the saved chat.", true);
    if (error.status === 404) void loadSessions();
  } finally {
    if (openingSavedChat === id) openingSavedChat = undefined;
    updateSavedLaunchButton();
    void refreshActivity(true);
  }
}

function renderSessionList() {
  hideMessagePreview();
  const list = $("session-list");
  list.replaceChildren();
  const { mode, collapsed, overrides } = currentProjectView();
  for (const button of projectControls.querySelectorAll("button[data-mode]")) {
    button.setAttribute("aria-pressed", String(button.dataset.mode === mode));
  }
  updateSavedLaunchButton();
  if (!catalog) return;
  const terms = sessionFilter.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const defaultOpen = mode !== "collapse";
  const exceptions = mode === "normal" ? collapsed : overrides;
  const groups = new Map();
  const nodes = new Map();
  const visible = [];
  const current = { ...catalog.current, name: catalog.current.name || "Current chat" };
  const peers = new Map(activeSessions.map((session) => [session.id, session]));
  const savedIds = new Set(catalog.sessions.map(({ id }) => id));
  const unsavedPeers = activeSessions.filter(({ id }) => id !== current.id && !savedIds.has(id));
  for (const session of [current, ...catalog.sessions, ...unsavedPeers]) {
    const { id, cwd } = session;
    const own = id === current.id;
    const peer = !own && peers.get(id);
    const name = peer?.name || session.name || "Untitled live chat";
    if (!terms.every((term) => `${name} ${cwd}`.toLowerCase().includes(term))) continue;
    let group = groups.get(cwd);
    if (!group) {
      const element = document.createElement("details");
      element.className = "session-group";
      element.open = defaultOpen !== exceptions.has(cwd);
      element.addEventListener("toggle", () => {
        if (!element.isConnected) return;
        if (element.open === defaultOpen) exceptions.delete(cwd);
        else exceptions.add(cwd);
      });
      const heading = document.createElement("summary");
      heading.textContent = cwd.split(/[\\/]/).filter(Boolean).at(-1) || cwd || "Unknown directory";
      bindMessageTooltip(heading, cwd);
      element.append(heading);
      list.append(element);
      group = { element, roots: [] };
      groups.set(cwd, group);
    }
    const active = own ? connected : Boolean(peer);
    const row = document.createElement("div");
    row.className = "session-row";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "secondary session-open";
    if (own) button.dataset.currentChat = "true";
    if (savedSessionId ? id === savedSessionId : own) button.setAttribute("aria-current", "true");
    const title = document.createElement("span");
    title.className = "session-name";
    title.textContent = name;
    button.append(title);
    button.addEventListener("mouseenter", () => showMessagePreview(button, name));
    button.addEventListener("mouseleave", hideMessagePreview);
    button.addEventListener("focus", () => showMessagePreview(button, name));
    button.addEventListener("blur", hideMessagePreview);
    button.addEventListener("click", () => {
      if (own) showLiveChat();
      else if (savedIds.has(id)) void showSavedChat({ id, cwd, name });
      else status("This chat is live in another tab and has no saved transcript yet.");
    });
    row.append(button);
    if (active) {
      const actions = document.createElement("span");
      actions.className = "session-live-actions";
      const indicator = document.createElement("span");
      indicator.className = "session-indicator live";
      indicator.setAttribute("role", "img");
      indicator.setAttribute("aria-label", own ? "Live session" : "Live in another tab");
      bindMessageTooltip(indicator, indicator.getAttribute("aria-label"));
      actions.append(indicator);
      if (session.canClone) {
        const clone = document.createElement("button");
        clone.type = "button";
        clone.className = "secondary session-clone";
        clone.textContent = "🧬";
        clone.setAttribute("aria-label", `Clone chat session ${name}`);
        bindMessageTooltip(clone, `Clone chat session ${name}`);
        clone.addEventListener("click", () => void cloneChatSession(id, clone));
        actions.append(clone);
      }
      row.append(actions);
    }
    if (!own && !active && cwd) {
      const copy = document.createElement("button");
      copy.type = "button";
      copy.className = "secondary session-copy";
      copy.setAttribute("aria-label", `Copy resume command for ${name}`);
      bindMessageTooltip(copy, "Copy resume command");
      const copyIcon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      copyIcon.setAttribute("viewBox", "0 0 24 24");
      copyIcon.setAttribute("width", "16");
      copyIcon.setAttribute("height", "16");
      copyIcon.setAttribute("fill", "none");
      copyIcon.setAttribute("stroke", "currentColor");
      copyIcon.setAttribute("stroke-width", "1.8");
      copyIcon.setAttribute("stroke-linecap", "round");
      copyIcon.setAttribute("stroke-linejoin", "round");
      copyIcon.setAttribute("aria-hidden", "true");
      const copyShape = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      copyShape.setAttribute("x", "8");
      copyShape.setAttribute("y", "8");
      copyShape.setAttribute("width", "13");
      copyShape.setAttribute("height", "13");
      copyShape.setAttribute("rx", "2");
      const copyOutline = document.createElementNS("http://www.w3.org/2000/svg", "path");
      copyOutline.setAttribute("d", "M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3");
      copyIcon.append(copyShape, copyOutline);
      copy.append(copyIcon);
      copy.addEventListener("click", () => void copyResumeCommand(id));
      row.append(copy);
    }
    const node = { id, parentId: session.parentId, group, row, children: [] };
    nodes.set(id, node);
    visible.push(node);
  }
  for (const node of visible) {
    const parent = node.parentId && nodes.get(node.parentId);
    if (parent && parent.group === node.group) parent.children.push(node);
    else node.group.roots.push(node);
  }
  const appendNode = (container, node) => {
    container.append(node.row);
    if (!node.children.length) return;
    const children = document.createElement("div");
    children.className = "session-tree-children";
    node.children.forEach((child) => appendNode(children, child));
    container.append(children);
  };
  for (const group of groups.values()) group.roots.forEach((node) => appendNode(group.element, node));
  if (!refreshSessions.disabled) $("explorer-status").textContent = catalogProblem || (groups.size ? "" : "No matching chats.");
}

async function refreshActivity(force = false) {
  if (activityInFlight || (!force && Date.now() < nextActivityCheck)) return;
  activityInFlight = true;
  nextActivityCheck = Date.now() + 5000;
  try {
    const { sessions } = await api("/api/activity");
    if (JSON.stringify(sessions) !== JSON.stringify(activeSessions)) {
      activeSessions = sessions;
      renderSessionList();
    }
  } catch { /* The session catalog remains available without live presence. */ }
  finally { activityInFlight = false; }
}

async function loadSessions() {
  if (refreshSessions.disabled) return;
  refreshSessions.disabled = true;
  $("explorer-status").textContent = "Loading saved chats…";
  try {
    try {
      catalog = await api("/api/sessions");
    } catch (error) {
      if (error.name !== "TypeError") throw error;
      catalog = await api("/api/sessions"); // Retry a dropped Safari connection once.
    }
    catalogProblem = "";
    if (savedSessionId && !catalog.sessions.some(({ id }) => id === savedSessionId)) {
      savedSelection++;
      clearSavedTranscript();
      $("saved-status").textContent = "This saved chat was removed. Select another chat or return to the live chat.";
    }
  } catch (error) {
    catalogProblem = error.name === "TypeError" || [401, 410].includes(error.status)
      ? "Could not reach Pi. Run /chat in Terminal and open the new tab."
      : error.message || "Could not refresh saved chats.";
  } finally {
    refreshSessions.disabled = false;
    $("explorer-status").textContent = catalogProblem;
    renderSessionList();
  }
}

function revealCurrentChat() {
  const current = $("session-list").querySelector('[data-current-chat="true"]');
  if (!current) return;
  for (let group = current.closest("details"); group; group = group.parentElement.closest("details")) group.open = true;
  current.scrollIntoView?.({ block: "nearest" });
}

function showCurrentChatInExplorer() {
  sessionFilter.value = "";
  searchProjects = projectView();
  browseProjects.mode = "collapse";
  browseProjects.collapsed.clear();
  browseProjects.overrides.clear();
  if (catalog?.current.cwd !== undefined) browseProjects.overrides.add(catalog.current.cwd);
  renderSessionList();
  revealCurrentChat();
}

function setExplorerOpen(open) {
  explorer.hidden = !open;
  explorerToggle.setAttribute("aria-expanded", String(open));
  document.body.classList.toggle("explorer-open", open);
  if (open) {
    sessionFilter.focus();
    if (!catalog) void loadSessions();
    void refreshActivity(true);
  }
}

function clearSavedTranscript() {
  savedImageObserver?.disconnect();
  for (const image of savedResponse.querySelectorAll("img[src^='blob:']")) URL.revokeObjectURL(image.src);
  savedResponse.replaceChildren();
}

function setSavedView(saved) {
  $("saved-conversation").hidden = !saved;
  for (const id of ["conversation", "turns", "right-panel"]) $(id).hidden = saved;
  if (window.matchMedia?.("(max-width: 760px)").matches) setExplorerOpen(false);
  renderSessionList();
  updateButtons();
}

function showLiveChat() {
  savedSelection++;
  savedSessionId = undefined;
  clearSavedTranscript();
  updateLiveDocumentTitle();
  setSavedView(false);
  if (liveScroll) {
    responseElement.scrollTop = liveScroll.follow ? responseElement.scrollHeight : liveScroll.top;
    liveScroll = undefined;
  }
  updateCurrentTurn();
  chatInput.focus({ preventScroll: true });
}

async function showSavedChat({ id, name, cwd }) {
  const selection = ++savedSelection;
  if (!savedSessionId) liveScroll = { follow: nearChatEnd(), top: responseElement.scrollTop };
  savedSessionId = id;
  clearSavedTranscript();
  document.title = name;
  $("saved-title").textContent = name;
  $("saved-directory").textContent = cwd ? `Read-only · ${cwd}` : "Read-only · Unknown directory";
  $("saved-status").textContent = "Loading conversation…";
  setSavedView(true);
  savedResponse.focus({ preventScroll: true });
  try {
    const { messages } = await api(`/api/session?${new URLSearchParams({ id })}`);
    if (selection !== savedSelection) return;
    const transcript = document.createDocumentFragment();
    for (const message of messages) transcript.append(renderTurn(message, id));
    savedResponse.append(transcript);
    savedResponse.scrollTop = savedResponse.scrollHeight;
    $("saved-status").textContent = !messages.length ? "No visible messages in this saved chat."
      : openSavedButton.hidden ? "To send a message, resume this chat in Pi from its original directory." : "";
  } catch (error) {
    if (selection === savedSelection) $("saved-status").textContent = error.message || "Could not read this chat.";
  }
}

explorerToggle.addEventListener("click", () => setExplorerOpen(explorer.hidden));
explorer.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  setExplorerOpen(false);
  explorerToggle.focus();
});
sessionFilter.addEventListener("input", () => {
  searchProjects = projectView();
  renderSessionList();
});
projectControls.addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (button?.dataset.action === "show-current") {
    showCurrentChatInExplorer();
    return;
  }
  const mode = button?.dataset.mode;
  if (!mode) return;
  const view = currentProjectView();
  view.mode = mode;
  view.overrides.clear();
  renderSessionList();
});
refreshSessions.addEventListener("click", () => {
  void loadSessions();
  void refreshActivity(true);
});
$("back-to-live").addEventListener("click", showLiveChat);
openSavedButton.addEventListener("click", () => void openSavedInBrowser());

function startChat(data) {
  // Older servers silently ignore the new attachments field on messages with a caption.
  if (data.protocol !== 2) throw new Error("Pi's chat server is outdated. Run /reload, then /chat in Pi.");
  annotationImagesSupported = data.annotationImages === true;
  $("comment-images").hidden = !annotationImagesSupported;
  $("comment-attach").hidden = !annotationImagesSupported;
  document.body.classList.add("chat-page");
  sessionTitlePill.hidden = false;
  chatNote.hidden = false;
  loadChatNote(data.sessionId);
  $("page-intro").hidden = true;
  document.querySelector(".chat-composer .actions").prepend($("chat-state"), $("status"));
  $("conversation").setAttribute("aria-label", "Conversation");
  $("conversation-label").hidden = true;
  for (const id of ["chat-rail", "turns", "chat-form", "chat-state", "explorer-toggle"]) $(id).hidden = false;
  $("empty").textContent = "Highlight text in a Pi reply to ask about it.";
  send.classList.add("chat-question-send");
  send.title = "Send questions";
  send.setAttribute("aria-label", "Send 0 questions");
  send.replaceChildren();
  send.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 2 15 22 11 13 2 9 22 2ZM22 2 11 13"/></svg><span id="count" class="send-count">0</span>';
  $("annotation-heading").append(send);
  responseElement.addEventListener("scroll", updateCurrentTurn, { passive: true });
  window.addEventListener("resize", updateCurrentTurn);
  window.addEventListener("pagehide", () => {
    // A closing tab can't wait for a reply. If the request is dropped, the idle timer reaps it.
    const body = chatSessionId && chatNoteReady ? { markdown: chatNoteInput.value } : {};
    void api("/api/close", body, { keepalive: true }).catch(() => {});
  }, { once: true });
  updateChat(data);
  status("");
  async function poll() {
    try {
      const wasConnected = connected;
      updateChat(await api(cursor === null ? "/api/response" : `/api/response?after=${encodeURIComponent(cursor)}`));
      if (!wasConnected) renderSessionList();
      if (!explorer.hidden || savedSessionId) void refreshActivity();
    } catch (error) {
      const wasConnected = connected;
      connected = false;
      if (wasConnected) renderSessionList();
      setChatState("disconnected");
      updateButtons();
      if ([401, 410].includes(error.status)) return;
    }
    setTimeout(poll, connected ? 1000 : 3000);
  }
  setTimeout(poll, 1000);
}

window.addEventListener("beforeunload", (event) => {
  if (annotations.length || comment.value.trim() || annotationFiles.length || readingAnnotationFiles || chatInput.value.trim() || attachments.length || readingFiles) {
    event.preventDefault();
    event.returnValue = "";
  }
});
try {
  if (!token) throw new Error("Open this page from Pi with /chat. Reloading the page discards its access token.");
  const data = await api("/api/response");
  if (data.mode !== "chat") throw new Error("Pi's chat server is outdated. Run /reload, then /chat in Pi.");
  startChat(data);
} catch (error) {
  status(error.message || "Could not load response.", true);
}
