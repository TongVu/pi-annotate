import { mountExplorer } from "./explorer.js";
import { mountTranscript } from "./transcript.js";
import { createSendCoordinator } from "./send.js";
import { mountAnnotationDraft } from "./annotations.js";
import { mountAttachmentUi } from "./attachments.js";
import { mountComposerDraft } from "./composer.js";
import { mountComposerControls } from "./composer-controls.js";

export async function mountChatPage(window, { token, tooltipFactory, loadNotes = () => import("./notes.js") }) {
  const { document, crypto } = window;
  const $ = (id) => document.getElementById(id);
  const chatToolsToggle = $("chat-tools-toggle");
  const sessionTitlePill = $("session-title-pill");
  const sessionTitleText = $("session-title-text");
  const renameSessionDialog = $("rename-session-dialog");
  const renameSessionInput = $("rename-session-input");
  const saveSessionName = $("save-session-name");
  const branchDialog = $("branch-chat-dialog");
  const branchName = $("branch-chat-name");
  let creatingSubchat = false;
  const branchStatus = $("branch-chat-status");
  const subchatOrigin = $("subchat-origin");
  const parentButton = $("subchat-parent");
  let branchReplyId;
  let originReplyId;
  let cursor = null;
  let notes;
  const appTitle = "Pi Chat";
  let liveTitle = appTitle;
  let chatTitleStatus = "⚪";
  let liveSessionName;
  let busy = false;
  let stoppableRequestId;
  let failed = false;
  let connected = true;
  const sender = createSendCoordinator({
    submit: (body) => api("/api/chat", body),
    requestId: () => crypto.randomUUID(),
    isAvailable: () => isViewingLive() && !composerControls.changing && connected,
    isBusy: () => busy,
    onChange: refreshChatUi,
    onAccepted(result) {
      busy = true; // The next fresh poll reconciles this with Pi, even for a very fast reply.
      stoppableRequestId = result?.stoppableRequestId;
    },
    status,
  });

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

  function refreshChatUi() {
    updateChatState();
    updateControls();
  }

  function updateControls() {
    composer.updateControls();
    annotations.updateControls();
    composerControls.updateControls();
  }

  chatToolsToggle.addEventListener("click", () => {
    const expanded = chatToolsToggle.getAttribute("aria-expanded") === "true";
    document.querySelector("main").classList.toggle("chat-tools-collapsed", expanded);
    chatToolsToggle.setAttribute("aria-expanded", String(!expanded));
    const label = `${expanded ? "Expand" : "Collapse"} notes and annotations`;
    chatToolsToggle.setAttribute("aria-label", label);
    setTooltip(chatToolsToggle, label);
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
    const state = !connected ? "disconnected" : sender.sending || busy || composerControls.compacting ? "working" : failed ? "stopped" : "ready";
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
    ? tooltipFactory({ sideTargets: "#chat-explorer" })
    : { set: (target, text) => { target.title = text; }, hide: () => {} };

  function updateSubchatOriginVisibility() {
    subchatOrigin.hidden = !originReplyId || explorer.isSaved();
  }

  function updateChat(data) {
    if (data.mode !== "chat" || !Array.isArray(data.messages)) throw new Error("Chat data is unavailable. Reopen from Pi.");
    const sessionName = data.sessionName?.trim();
    updateSessionTitle(sessionName);
    if (data.subchatOrigin) {
      originReplyId = data.subchatOrigin.replyId;
      const { parentName } = data.subchatOrigin;
      $("subchat-parent-name").textContent = parentName;
      setTooltip(parentButton, `Open parent chat: ${parentName}`);
      updateSubchatOriginVisibility();
    }
    transcript.appendLive(data.messages, { initial: !cursor, branchReplyId: data.subchatOrigin?.replyId });
    cursor = data.cursor;
    busy = data.busy;
    stoppableRequestId = data.stoppableRequestId;
    if (!busy) composer.forgetSentDraft();
    failed = data.failed;
    connected = true;
    composerControls.updateContext(data.contextUsage, data.canCompact === true);
    refreshChatUi();
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

  function openBranchDialog(replyId) {
    if (!connected) return status("Reopen /chat in Pi before branching.", true);
    hideMessagePreview();
    annotations.hideSelectionAction();
    branchReplyId = replyId;
    branchName.value = "";
    branchStatus.textContent = "";
    branchDialog.showModal();
    branchName.focus();
  }
  branchDialog.addEventListener("cancel", (event) => {
    if (creatingSubchat) event.preventDefault();
  });
  $("branch-chat-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const name = branchName.value.trim();
    if (creatingSubchat || !branchReplyId || !name || name.length > 100) return;
    creatingSubchat = true;
    branchStatus.classList.remove("error");
    branchStatus.textContent = "Creating subchat…";
    try {
      const result = await api("/api/session/branch", { replyId: branchReplyId, name });
      branchDialog.close();
      status(result.message || "Pi is opening the subchat in a new tab.");
      if (result.command) explorer.showResumeCommand(result.command);
      void explorer.refreshSessions();
    } catch (error) {
      branchStatus.textContent = error.message || "Could not create the subchat.";
      branchStatus.classList.add("error");
    } finally {
      creatingSubchat = false;
    }
  });
  parentButton.addEventListener("click", async () => {
    hideMessagePreview();
    parentButton.disabled = true;
    try { await explorer.showParent(originReplyId); }
    finally { parentButton.disabled = false; }
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
  const isViewingLive = () => !explorer.isSaved();
  const attachmentUi = mountAttachmentUi(window, setTooltip);
  const composer = mountComposerDraft(window, {
    sender, attachmentUi, status, setTooltip,
    canStopReply: (id) => connected && isViewingLive() && busy && id === stoppableRequestId,
    stopReply: (requestId) => api("/api/chat/stop", { requestId }),
  });
  const composerControls = mountComposerControls(window, {
    api, status, setTooltip, isViewingLive,
    isBusy: () => busy || sender.sending,
    isConnected: () => connected,
    onActionChange: refreshChatUi,
  });
  const annotations = mountAnnotationDraft(window, { sender, attachmentUi, status, setTooltip, isViewingLive });
  const transcript = mountTranscript(window, {
    fetchImage: (query) => window.fetch(`/api/image?${query}`, { headers: { Authorization: `Bearer ${token}` } }),
    isViewingLive, isCommentOpen: () => annotations.isDialogOpen() || branchDialog.open,
    showImagePreview: attachmentUi.showImagePreview, onBranchReply: openBranchDialog, setTooltip, status,
  });
  const explorer = mountExplorer(window, {
    api, status, setTooltip, hideMessagePreview,
    isConnected: () => connected,
    transcript,
    onViewChange() {
      updateSubchatOriginVisibility();
      annotations.hideSelectionAction();
      updateControls();
    },
    onBackToLive() {
      updateLiveDocumentTitle();
      composer.focus();
    },
  });

  function startChat(data, mountChatNotes) {
    // Older servers silently ignore the new attachments field on messages with a caption.
    if (data.protocol !== 2) throw new Error("Pi's chat server is outdated. Run /reload, then /chat in Pi.");
    document.body.classList.add("chat-page");
    sessionTitlePill.hidden = false;
    notes = mountChatNotes?.(window, { sessionId: data.sessionId, api, setTooltip, attachmentUi });
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
    annotations.start(data.annotationImages === true);
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
        const sendsAtPollStart = sender.accepted;
        const data = await api(cursor === null ? "/api/response" : `/api/response?after=${encodeURIComponent(cursor)}`);
        // A poll started before send acknowledgement may still report the previous idle state.
        if (sendsAtPollStart === sender.accepted) updateChat(data);
        if (!wasConnected) explorer.refreshConnection();
        explorer.pollActivity();
      } catch (error) {
        const wasConnected = connected;
        connected = false;
        composerControls.updateContext();
        if (wasConnected) explorer.refreshConnection();
        refreshChatUi();
        if ([401, 410].includes(error.status)) return;
      }
      window.setTimeout(poll, connected ? 1000 : 3000);
    }
    window.setTimeout(poll, 1000);
  }

  window.addEventListener("beforeunload", (event) => {
    if (composer.hasDraft() || annotations.hasDraft() || notes?.hasPendingAttachments()) {
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
