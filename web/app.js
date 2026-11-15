const token = location.hash.slice(1);
// Do not leave the capability in history/address bar. It remains in this page's memory only.
history.replaceState(null, "", location.pathname);
const $ = (id) => document.getElementById(id);
const responseElement = $("response");
const dialog = $("comment-dialog");
const comment = $("comment");
const send = $("send");
const annotations = [];
let response;
let pending;
let submitted = false;
let sending = false;
let editing = -1;

function status(message, error = false) {
  $("status").textContent = message;
  $("status").classList.toggle("error", error);
}

async function api(path, body) {
  const res = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Could not connect to Pi.");
  return data;
}

function renderAnnotations() {
  $("count").textContent = `(${annotations.length})`;
  send.disabled = submitted || sending || annotations.length === 0;
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
  if (!response || submitted || sending || dialog.open) return;
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) return;
  const range = selection.getRangeAt(0);
  if (!responseElement.contains(range.startContainer) || !responseElement.contains(range.endContainer)) return;
  const before = range.cloneRange();
  before.selectNodeContents(responseElement);
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
  showComment({ start, end: start + quote.length, quote });
}

// Native browser selection, not a clipboard read. Keyboard selection is supported too.
responseElement.addEventListener("mouseup", selectPassage);
responseElement.addEventListener("keyup", (event) => {
  if (event.key === "Shift") selectPassage();
});
$("cancel").addEventListener("click", () => dialog.close());
dialog.addEventListener("close", () => {
  pending = undefined;
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
  status("Annotation saved here. Add more, or choose Add to Pi draft.");
});
send.addEventListener("click", async () => {
  if (submitted || sending || !annotations.length) return;
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
window.addEventListener("beforeunload", (event) => {
  if (!submitted && (annotations.length || comment.value.trim())) {
    event.preventDefault();
    event.returnValue = "";
  }
});
try {
  if (!token) throw new Error("Open this page using /annotate in Pi. Reloading the page discards its access token.");
  const data = await api("/api/response");
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
} catch (error) {
  status(error.message || "Could not load response.", true);
}
