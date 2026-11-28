export function mountComposerDraft(window, { sender, attachmentUi, status, setTooltip, canStopReply, stopReply, isViewingLive }) {
  const $ = (id) => window.document.getElementById(id);
  const form = $("chat-form");
  const chatInput = $("chat-input");
  const chatFile = $("chat-file");
  const action = $("chat-send");
  const { renderAttachmentList, readAttachments } = attachmentUi;
  let attachments = [];
  let readingFiles = false;
  let sentDraft;
  let stopping = false;

  function canStop() {
    // Never replace a newer draft, even if Pi became stoppable again after a poll.
    return sentDraft && !sender.sending && !chatInput.value && !attachments.length && !readingFiles && canStopReply(sentDraft.requestId);
  }

  function composerBody() {
    return { text: chatInput.value.trim(), ...(attachments.length ? { attachments } : {}) };
  }

  function updateControls() {
    const body = composerBody();
    const stopMode = canStop() || stopping;
    const type = stopMode ? "button" : "submit";
    if (action.type !== type) {
      action.type = type;
      action.firstElementChild.textContent = stopMode ? "✍️" : "💬";
      action.setAttribute("aria-label", stopMode ? "Stop and edit" : "Send message");
      setTooltip(action, stopMode ? "Stop and edit" : "Send message (Enter)");
    }
    action.disabled = stopMode ? stopping : (!body.text && !body.attachments) || readingFiles || !sender.canSend(body);
    chatInput.readOnly = sender.sending || stopMode || !isViewingLive();
    $("chat-attach").disabled = chatInput.readOnly || readingFiles;
    for (const button of $("chat-attachments").querySelectorAll("button")) button.disabled = chatInput.readOnly || readingFiles;
  }

  function setAttachments(next) {
    // Don't retain removed files after a failed send.
    sender.invalidateRetry("attachments");
    attachments = next;
    renderAttachmentList($("chat-attachments"), attachments, (index) => {
      setAttachments(attachments.filter((_, i) => i !== index));
      status("File removed from your draft.");
    });
    updateControls();
  }

  async function attachFiles(files) {
    if (!files.length || chatInput.readOnly || readingFiles) return;
    readingFiles = true;
    updateControls();
    try {
      setAttachments([...attachments, ...await readAttachments(files, attachments)]);
      status(`${files.length === 1 ? "File" : `${files.length} files`} attached. Press Enter or click Send when ready.`);
    } catch (error) {
      status(error.message, true);
    } finally {
      readingFiles = false;
      updateControls();
    }
  }

  const expand = $("chat-expand");
  expand.addEventListener("click", () => {
    const expanded = expand.getAttribute("aria-expanded") !== "true";
    const text = `${expanded ? "Collapse" : "Expand"} message composer`;
    expand.setAttribute("aria-expanded", String(expanded));
    expand.setAttribute("aria-label", text);
    setTooltip(expand, text);
  });

  action.addEventListener("click", async (event) => {
    if (action.type !== "button") return;
    event.preventDefault();
    if (stopping || !canStop()) return;
    const draft = sentDraft;
    stopping = true;
    updateControls();
    status("Stopping Pi…");
    try {
      await stopReply(draft.requestId);
      sentDraft = undefined;
      chatInput.value = draft.text;
      setAttachments(draft.attachments);
      status("Stopped. Edit your message, then send it again.");
      if (!form.closest("[hidden]")) {
        chatInput.focus({ preventScroll: true });
        chatInput.setSelectionRange(chatInput.value.length, chatInput.value.length);
      }
    } catch (error) {
      if (error.status === 409) sentDraft = undefined;
      status(error.message || "Could not stop Pi.", true);
    } finally {
      stopping = false;
      updateControls();
    }
  });

  chatInput.addEventListener("input", updateControls);
  chatInput.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey || event.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    if (!event.repeat && action.type === "submit" && !action.disabled) form.requestSubmit();
  });
  chatInput.addEventListener("paste", (event) => {
    const files = Array.from(event.clipboardData?.files ?? []);
    if (!files.length || chatInput.readOnly) return;
    event.preventDefault();
    void attachFiles(files);
  });
  form.addEventListener("dragover", (event) => {
    if (!event.dataTransfer?.types.includes("Files")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = chatInput.readOnly || readingFiles ? "none" : "copy";
  });
  form.addEventListener("drop", (event) => {
    const files = Array.from(event.dataTransfer?.files ?? []);
    if (!files.length && !event.dataTransfer?.types.includes("Files")) return;
    event.preventDefault();
    if (!chatInput.readOnly) chatInput.focus({ preventScroll: true });
    void attachFiles(files);
  });
  $("chat-attach").addEventListener("click", () => chatFile.click());
  chatFile.addEventListener("change", () => {
    const files = Array.from(chatFile.files);
    chatFile.value = "";
    void attachFiles(files);
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const body = composerBody();
    if (!readingFiles && action.type === "submit" && (body.text || body.attachments)) {
      void sender.send(body, (result) => {
        const requestId = result?.stoppableRequestId;
        sentDraft = requestId ? { requestId, text: chatInput.value, attachments } : undefined;
        chatInput.value = "";
        setAttachments([]);
      });
    }
  });

  return {
    updateControls,
    forgetSentDraft: () => { sentDraft = undefined; },
    hasDraft: () => Boolean(chatInput.value.trim() || attachments.length || readingFiles),
    focus: () => chatInput.focus({ preventScroll: true }),
  };
}
