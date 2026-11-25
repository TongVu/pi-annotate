export function mountComposerDraft(window, { sender, attachmentUi, status, setTooltip }) {
  const $ = (id) => window.document.getElementById(id);
  const form = $("chat-form");
  const chatInput = $("chat-input");
  const chatFile = $("chat-file");
  const { renderAttachmentList, readAttachment, checkAttachmentLimits } = attachmentUi;
  let attachments = [];
  let readingFiles = false;

  function composerBody() {
    return { text: chatInput.value.trim(), ...(attachments.length ? { attachments } : {}) };
  }

  function updateControls() {
    const body = composerBody();
    $("chat-send").disabled = (!body.text && !body.attachments) || readingFiles || !sender.canSend(body);
    $("chat-attach").disabled = sender.sending || readingFiles;
    for (const button of $("chat-attachments").querySelectorAll("button")) button.disabled = sender.sending || readingFiles;
    chatInput.readOnly = sender.sending;
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
    if (!files.length || sender.sending || readingFiles) return;
    readingFiles = true;
    updateControls();
    try {
      checkAttachmentLimits(files, attachments);
      setAttachments([...attachments, ...await Promise.all(files.map(readAttachment))]);
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

  chatInput.addEventListener("input", updateControls);
  chatInput.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey || event.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    if (!event.repeat && !$("chat-send").disabled) form.requestSubmit();
  });
  chatInput.addEventListener("paste", (event) => {
    const files = Array.from(event.clipboardData?.files ?? []);
    if (!files.length || sender.sending) return;
    event.preventDefault();
    void attachFiles(files);
  });
  form.addEventListener("dragover", (event) => {
    if (!event.dataTransfer?.types.includes("Files")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = sender.sending || readingFiles ? "none" : "copy";
  });
  form.addEventListener("drop", (event) => {
    const files = Array.from(event.dataTransfer?.files ?? []);
    if (!files.length && !event.dataTransfer?.types.includes("Files")) return;
    event.preventDefault();
    if (!sender.sending) chatInput.focus({ preventScroll: true });
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
    if (!readingFiles && (body.text || body.attachments)) {
      void sender.send(body, () => {
        chatInput.value = "";
        setAttachments([]);
      });
    }
  });

  return {
    updateControls,
    hasDraft: () => Boolean(chatInput.value.trim() || attachments.length || readingFiles),
    focus: () => chatInput.focus({ preventScroll: true }),
  };
}
