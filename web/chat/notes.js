const noSession = "Session ID unavailable. Run /reload in Pi, then reopen /chat to save this note.";

export function mountChatNotes(window, { sessionId, api, setTooltip }) {
  const $ = (id) => window.document.getElementById(id);
  const note = $("chat-note");
  const dialog = $("chat-note-dialog");
  const input = $("chat-note-input");
  const preview = $("chat-note-preview");
  const previewToggle = $("chat-note-preview-toggle");
  const copy = $("chat-note-copy");
  const expand = $("chat-note-expand");
  const statusElement = $("chat-note-status");
  const id = typeof sessionId === "string" && sessionId ? sessionId : undefined;
  let ready = !id;
  let saveTimer;
  let saveQueue = Promise.resolve();
  let previewing = false;
  let home;

  function status(message, error = false) {
    statusElement.textContent = message;
    statusElement.classList.toggle("error", error);
  }

  function updateCopy() {
    copy.disabled = !ready || !input.value.trim();
  }

  async function load() {
    if (!id) {
      status(noSession, true);
      updateCopy();
      return;
    }
    input.disabled = expand.disabled = previewToggle.disabled = true;
    status("Loading this chat’s saved note…");
    let legacyNote = null;
    const legacyKey = `pi-annotate:markdown-note:v1:${id}`;
    try { legacyNote = window.localStorage.getItem(legacyKey); } catch { /* Server storage stays authoritative. */ }
    try {
      const saved = await api("/api/note");
      if (typeof saved.markdown !== "string") throw new Error("Invalid saved note response.");
      let markdown = saved.markdown;
      if (!markdown && legacyNote) {
        await api("/api/note", { markdown: legacyNote });
        markdown = legacyNote;
      }
      input.value = markdown;
      try { window.localStorage.removeItem(legacyKey); } catch { /* Migration can be retried next time. */ }
      status("");
    } catch (error) {
      input.value = legacyNote ?? "";
      status(error.message || "Could not load this chat’s saved note.", true);
    } finally {
      ready = true;
      input.disabled = expand.disabled = previewToggle.disabled = false;
      updateCopy();
    }
  }

  function restoreFromDialog() {
    if (!home) return;
    const { parent, nextSibling } = home;
    parent.insertBefore(note, nextSibling?.parentNode === parent ? nextSibling : null);
    home = undefined;
    expand.setAttribute("aria-expanded", "false");
    expand.setAttribute("aria-label", "Expand Markdown note");
    setTooltip(expand, "Expand Markdown note");
  }

  expand.addEventListener("click", () => {
    if (dialog.open) {
      dialog.close();
      return;
    }
    home = { parent: note.parentNode, nextSibling: note.nextSibling };
    dialog.append(note);
    expand.setAttribute("aria-expanded", "true");
    expand.setAttribute("aria-label", "Collapse Markdown note");
    setTooltip(expand, "Collapse Markdown note");
    try { dialog.showModal(); }
    catch {
      restoreFromDialog();
      status("Could not expand the Markdown note.", true);
    }
  });
  dialog.addEventListener("close", restoreFromDialog);
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });

  function markdownForClose() {
    return id && ready ? input.value : undefined;
  }

  async function save() {
    window.clearTimeout(saveTimer);
    const markdown = markdownForClose();
    if (markdown === undefined) return;
    const pending = saveQueue.catch(() => {}).then(() => api("/api/note", { markdown }));
    saveQueue = pending;
    try {
      await pending;
      if (markdown === input.value) status("Saved for this chat.");
    } catch (error) {
      if (markdown === input.value) status(error.message || "Could not save this chat’s note.", true);
    }
  }

  input.addEventListener("input", () => {
    updateCopy();
    status("");
    if (!id) {
      status(noSession, true);
      return;
    }
    if (!ready) return;
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => { void save(); }, 350);
  });
  input.addEventListener("blur", () => { void save(); });

  previewToggle.addEventListener("click", async () => {
    if (previewing) {
      input.hidden = false;
      preview.hidden = true;
      previewing = false;
      previewToggle.setAttribute("aria-label", "Preview note");
      setTooltip(previewToggle, "Preview Markdown note");
      previewToggle.setAttribute("aria-pressed", "false");
      input.focus();
      return;
    }
    previewToggle.disabled = true;
    status("");
    try {
      const { html } = await api("/api/markdown", { markdown: input.value });
      preview.innerHTML = html || "<p>Nothing to preview yet.</p>";
      input.hidden = true;
      preview.hidden = false;
      previewing = true;
      previewToggle.setAttribute("aria-label", "Edit note");
      setTooltip(previewToggle, "Edit Markdown note");
      previewToggle.setAttribute("aria-pressed", "true");
    } catch (error) {
      status(error.message || "Could not preview this note.", true);
    } finally {
      previewToggle.disabled = false;
    }
  });
  copy.addEventListener("click", async () => {
    try {
      await window.navigator.clipboard.writeText(input.value);
      status("Copied Markdown to clipboard.");
    } catch {
      status("Clipboard access failed. Select and copy the note text instead.", true);
    }
  });

  note.hidden = false;
  void load();
  return { markdownForClose };
}
