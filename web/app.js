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
const annotations = [];
const chatInput = $("chat-input");
const chatFile = $("chat-file");
const MAX_ATTACHMENTS = 10;
const FILE_LIMIT = 5 * 1024 * 1024;
const ATTACHMENTS_LIMIT = 10 * 1024 * 1024;
let attachments = [];
let readingFiles = false;
let chat = false;
let cursor = null;
let busy = false;
let connected = true;
let lastAttempt;
let response;
let pending;
let submitted = false;
let sending = false;
let editing = -1;

function status(message, error = false) {
  $("status").textContent = message;
  $("status").classList.toggle("error", error);
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

function attemptKey({ text, annotations }) {
  return JSON.stringify([text, annotations]);
}

function isRetry(body) {
  // Draft changes replace the array; retries don't need to stringify every file on each poll.
  return lastAttempt && lastAttempt.attachments === body.attachments && lastAttempt.key === attemptKey(body);
}

function canSend(body) {
  return !submitted && !sending && connected && (!chat || !busy || isRetry(body));
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
  chatInput.readOnly = sending;
}

function setAttachments(next) {
  // Don't retain removed files after a failed send.
  if (lastAttempt?.attachments) lastAttempt = undefined;
  attachments = next;
  const list = $("chat-attachments");
  list.hidden = !attachments.length;
  list.replaceChildren();
  for (const [index, file] of attachments.entries()) {
    const item = document.createElement("li");
    const name = document.createElement("span");
    name.textContent = file.name;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "secondary";
    remove.textContent = "Remove";
    remove.setAttribute("aria-label", `Remove ${file.name}`);
    remove.addEventListener("click", () => {
      setAttachments(attachments.filter((_, i) => i !== index));
      status("File removed from your draft.");
    });
    item.append(name, remove);
    list.append(item);
  }
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

async function attachFiles(files) {
  if (!chat || !files.length || sending || readingFiles) return;
  if (attachments.length + files.length > MAX_ATTACHMENTS || files.some((file) => file.size > FILE_LIMIT)) {
    status(`Attach up to ${MAX_ATTACHMENTS} files, each 5 MiB or smaller.`, true);
    return;
  }
  const total = files.reduce((size, file) => size + file.size, 0) + attachments.reduce((size, { data }) =>
    size + data.length * 3 / 4 - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0), 0);
  if (total > ATTACHMENTS_LIMIT) {
    status("Attachments must be 10 MiB or less in total.", true);
    return;
  }
  readingFiles = true;
  updateButtons();
  try {
    setAttachments([...attachments, ...await Promise.all(files.map(readAttachment))]);
    status(`${files.length === 1 ? "File" : `${files.length} files`} attached. Press Enter or click Send when ready.`);
  } catch (error) {
    status(error.message, true);
  } finally {
    readingFiles = false;
    updateButtons();
  }
}

function renderAnnotations() {
  $("count").textContent = `(${annotations.length})`;
  updateButtons();
  $("empty").hidden = annotations.length > 0;
  $("annotations").replaceChildren();
  for (const [index, annotation] of annotations.entries()) {
    const item = document.createElement("li");
    const quote = document.createElement("blockquote");
    quote.textContent = annotation.quote;
    const text = document.createElement("p");
    text.textContent = annotation.comment;
    const actions = document.createElement("div");
    actions.className = "actions";
    for (const label of ["Edit", "Remove"]) {
      const button = document.createElement("button");
      button.className = "secondary";
      button.textContent = label;
      button.disabled = submitted || sending;
      button.addEventListener("click", () => {
        if (label === "Edit") {
          editing = index;
          showComment(annotation);
        } else {
          annotations.splice(index, 1);
          renderAnnotations();
        }
      });
      actions.append(button);
    }
    item.append(quote, text, actions);
    $("annotations").append(item);
  }
}

function showComment(selection) {
  pending = selection;
  $("selected-quote").textContent = selection.quote;
  comment.value = editing >= 0 ? selection.comment : "";
  dialog.showModal();
  comment.focus();
}

function selectPassage() {
  if ((!chat && !response) || submitted || sending || dialog.open) return;
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) return;
  const range = selection.getRangeAt(0);
  const startElement = range.startContainer.nodeType === Node.ELEMENT_NODE ? range.startContainer : range.startContainer.parentElement;
  const passage = chat ? startElement?.closest("[data-response-id]") : responseElement;
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
  showComment({ start, end: start + quote.length, quote, ...(chat ? { responseId: passage.dataset.responseId } : {}) });
}

// Native browser selection, not a clipboard read. Keyboard selection is supported too.
responseElement.addEventListener("mouseup", selectPassage);
responseElement.addEventListener("keyup", (event) => {
  if (event.key === "Shift") selectPassage();
});
$("cancel").addEventListener("click", () => dialog.close());
dialog.addEventListener("close", () => {
  pending = undefined;
  comment.value = "";
  editing = -1;
  window.getSelection()?.removeAllRanges();
});
$("comment-form").addEventListener("submit", (event) => {
  event.preventDefault();
  if (!pending || !comment.value.trim()) return;
  const annotation = { ...pending, comment: comment.value.trim() };
  if (editing >= 0) annotations[editing] = annotation;
  else annotations.push(annotation);
  dialog.close();
  renderAnnotations();
  status(chat ? "Question saved in the right panel. Send when ready." : "Annotation saved here. Add more, or choose Add to Pi draft.");
});

async function sendChat(body) {
  if (!canSend(body)) return;
  // An unchanged retry uses the same ID if Pi accepted it but the HTTP response was lost.
  if (!isRetry(body)) lastAttempt = { key: attemptKey(body), attachments: body.attachments, id: crypto.randomUUID() };
  sending = true;
  renderAnnotations();
  status("Sending to Pi…");
  try {
    await api("/api/chat", { ...body, requestId: lastAttempt.id });
    lastAttempt = undefined;
    if (body.annotations) annotations.length = 0;
    else {
      chatInput.value = "";
      setAttachments([]);
    }
    busy = true; // The next poll reconciles this with Pi, even for a very fast reply.
    status("Sent to Pi.");
  } catch (error) {
    status(error.message || "Could not confirm the send. Your draft is still here.", true);
  } finally {
    sending = false;
    renderAnnotations();
  }
}

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
  if (chat && !readingFiles && (body.text || body.attachments)) void sendChat(body);
});
send.addEventListener("click", async () => {
  if (!annotations.length || !canSend({ annotations })) return;
  if (chat) {
    await sendChat({ annotations });
    return;
  }
  sending = true;
  renderAnnotations();
  status("Adding annotations to Pi’s draft…");
  try {
    await api("/api/annotations", { annotations });
    submitted = true;
    send.firstChild.textContent = "Added to Pi draft ";
    status("Added to Pi’s draft—not sent. Switch back to Pi, review, and press Enter when ready. You can close this tab.");
  } catch (error) {
    status(error.message || "Could not connect to Pi. Keep this tab open and retry.", true);
  } finally {
    sending = false;
    renderAnnotations();
  }
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

function updateChat(data) {
  if (data.mode !== "chat" || !Array.isArray(data.messages)) throw new Error("Chat data is unavailable. Reopen from Pi.");
  const follow = !cursor || responseElement.scrollHeight - responseElement.scrollTop - responseElement.clientHeight < 80;
  const fragment = document.createDocumentFragment();
  const dots = document.createDocumentFragment();
  for (const message of data.messages) {
    const turn = document.createElement("section");
    const assistant = message.role === "assistant";
    turn.className = `chat-turn ${assistant ? "assistant-turn" : "user-turn"}`;
    const content = document.createElement("div");
    if (assistant) {
      const label = document.createElement("h2");
      label.textContent = "Pi";
      turn.append(label);
      // Same restricted Markdown renderer and DOM-text check as draft mode.
      content.innerHTML = message.html;
      if (content.textContent === message.text) content.dataset.responseId = message.id;
      else content.textContent = "This reply could not be rendered safely. See Pi in the terminal.";
    } else {
      turn.setAttribute("aria-label", "Your message");
      content.textContent = message.text;
      const preview = message.text.trim().replace(/\s+/g, " ").slice(0, 120);
      const dot = document.createElement("button");
      dot.type = "button";
      dot.title = preview;
      dot.setAttribute("aria-label", `Jump to your message: ${preview}`);
      dot.addEventListener("click", () => {
        responseElement.scrollTop += turn.getBoundingClientRect().top - responseElement.getBoundingClientRect().top;
        markCurrentDot(dot);
      });
      turns.push({ turn, dot });
      dots.append(dot);
    }
    turn.append(content);
    fragment.append(turn);
  }
  responseElement.append(fragment);
  turnRail.append(dots);
  if (data.messages.length) {
    if (follow && !dialog.open && window.getSelection()?.isCollapsed !== false) {
      responseElement.scrollTop = responseElement.scrollHeight;
    }
    updateCurrentTurn();
  }
  cursor = data.cursor;
  busy = data.busy;
  connected = true;
  const state = busy ? "Pi is working…" : data.failed ? "Pi stopped. Check the terminal for details." : "Pi is ready";
  if ($("chat-state").textContent !== state) $("chat-state").textContent = state;
  updateButtons();
}

function startChat(data) {
  // Older servers silently ignore the new attachments field on messages with a caption.
  if (data.protocol !== 2) throw new Error("Pi's chat server is outdated. Run /reload, then /chat in Pi.");
  chat = true;
  document.title = "Chat · Pi";
  document.body.classList.add("chat-page");
  $("page-title").textContent = "Pi / Chat";
  $("page-description").textContent = "Live view of this Pi session. Send here to start a turn in Pi.";
  $("conversation").setAttribute("aria-label", "Conversation");
  $("conversation-label").hidden = true;
  for (const id of ["turns", "chat-form", "chat-state"]) $(id).hidden = false;
  $("empty").textContent = "Highlight text in a Pi reply to ask about it.";
  send.firstChild.textContent = "Send questions ";
  $("empty").before(send);
  responseElement.addEventListener("scroll", updateCurrentTurn, { passive: true });
  window.addEventListener("resize", updateCurrentTurn);
  window.addEventListener("pagehide", () => {
    // A closing tab can't wait for a reply. If the request is dropped, the idle timer reaps it.
    void api("/api/close", {}, { keepalive: true }).catch(() => {});
  }, { once: true });
  updateChat(data);
  status("Write a message, or select text in any Pi reply to ask about it.");
  async function poll() {
    try {
      updateChat(await api(cursor === null ? "/api/response" : `/api/response?after=${encodeURIComponent(cursor)}`));
    } catch (error) {
      connected = false;
      $("chat-state").textContent = "Disconnected. If it persists, run /chat again in Pi.";
      updateButtons();
      if ([401, 410].includes(error.status)) return;
    }
    setTimeout(poll, connected ? 1000 : 3000);
  }
  setTimeout(poll, 1000);
}

window.addEventListener("beforeunload", (event) => {
  if (!submitted && (annotations.length || comment.value.trim() || chatInput.value.trim() || attachments.length || readingFiles)) {
    event.preventDefault();
    event.returnValue = "";
  }
});
try {
  if (!token) throw new Error("Open this page from Pi with /chat or /annotate. Reloading the page discards its access token.");
  const data = await api("/api/response");
  if (data.mode === "chat") startChat(data);
  else loadDraft(data);
} catch (error) {
  status(error.message || "Could not load response.", true);
}

function loadDraft(data) {
  if (typeof data.response?.html !== "string" || typeof data.response?.text !== "string") {
    throw new Error("Pi's annotation server is outdated. Run /reload, then /annotate in Pi. If it persists, restart Pi with --continue and the extension.");
  }
  response = data.response;
  submitted = data.submitted;
  // Only the local server's restricted Markdown renderer supplies this HTML.
  // Never insert the original assistant Markdown or annotation text as HTML.
  responseElement.innerHTML = response.html;
  if (responseElement.textContent !== response.text) {
    responseElement.replaceChildren();
    response = undefined;
    throw new Error("Rendered text did not match Pi's quote validation. Run /annotate again.");
  }
  renderAnnotations();
  status(submitted ? "This response was already added to Pi. Run /annotate for a new batch." : "Select a passage to add your first annotation. Drafts stay in this tab until you add them to Pi.");
}
