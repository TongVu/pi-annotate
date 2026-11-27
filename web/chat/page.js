import { mountExplorer } from "./explorer.js";
import { mountTranscript } from "./transcript.js";
import { createSendCoordinator } from "./send.js";
import { mountAnnotationDraft } from "./annotations.js";
import { mountAttachmentUi } from "./attachments.js";
import { mountComposerDraft } from "./composer.js";
import { mountComposerControls } from "./composer-controls.js";

function mountPanelResizers(window) {
  const { document } = window;
  const min = 220;
  // At desktop widths, leave at least 40% of the window for the middle column.
  const max = () => Math.max(min, Math.min(600, Math.floor(window.innerWidth * 0.3)));
  const clamp = (width) => Math.max(min, Math.min(max(), Math.round(width)));
  for (const [id, direction, defaultWidth] of [
    ["chat-tools", 1, () => 340],
    ["chat-explorer", -1, () => Math.min(280, window.innerWidth * 0.22)],
  ]) {
    const handle = document.getElementById(`${id}-resize`);
    const key = `pi-chat:${id}-width`;
    let preferred;
    let drag;
    try { preferred = Number(window.localStorage.getItem(key)) || undefined; } catch { /* Resizing still works. */ }
    const currentWidth = () => clamp(preferred ?? defaultWidth());
    function update() {
      const width = currentWidth();
      document.body.style.setProperty(`--${id}-size`, `${width}px`);
      handle.setAttribute("aria-valuemin", String(min));
      handle.setAttribute("aria-valuemax", String(max()));
      handle.setAttribute("aria-valuenow", String(width));
    }
    function save() {
      try { window.localStorage.setItem(key, String(preferred)); } catch { /* Persistence is optional. */ }
    }
    function resize(width) {
      const next = clamp(width);
      if (next === currentWidth()) return false;
      preferred = next;
      update();
      return true;
    }
    handle.addEventListener("pointerdown", (event) => {
      if (drag || event.button !== 0) return;
      event.preventDefault();
      handle.focus({ preventScroll: true });
      handle.setPointerCapture(event.pointerId);
      drag = { id: event.pointerId, x: event.clientX, width: currentWidth(), changed: false };
    });
    handle.addEventListener("pointermove", (event) => {
      if (drag?.id !== event.pointerId) return;
      drag.changed = resize(drag.width + (event.clientX - drag.x) * direction) || drag.changed;
    });
    function finishDrag(event) {
      if (drag?.id !== event.pointerId) return;
      if (drag.changed) save();
      drag = undefined;
    }
    for (const event of ["pointerup", "pointercancel", "lostpointercapture"]) handle.addEventListener(event, finishDrag);
    handle.addEventListener("keydown", (event) => {
      if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
      const offsets = { ArrowLeft: -16, ArrowRight: 16 };
      let width;
      if (event.key === "Home") width = min;
      else if (event.key === "End") width = max();
      else if (Object.hasOwn(offsets, event.key)) width = currentWidth() + offsets[event.key] * direction;
      else return;
      event.preventDefault();
      if (resize(width)) save();
    });
    window.addEventListener("resize", update);
    update();
  }
}

export async function mountChatPage(window, { token, tooltipFactory, loadNotes = () => import("./notes.js") }) {
  const { document, crypto } = window;
  const $ = (id) => document.getElementById(id);
  const chatToolsToggle = $("chat-tools-toggle");
  const sessionTitlePill = $("session-title-pill");
  const chatHeading = sessionTitlePill.parentElement;
  const sessionTitleText = $("session-title-text");
  const sessionTitleStatus = $("session-title-status");
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
  let team;
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
    setTooltip(chatToolsToggle, `${label} (Ctrl+Shift+2)`);
  });

  const chatStates = {
    working: { label: "Working", icon: "🏗️", color: "#dc4141", detail: "Pi is working…" },
    ready: { label: "Ready", icon: "✓", color: "#2f9b69", detail: "Pi is ready for the next task." },
    stopped: { label: "Stopped", icon: "🚫", color: "#d99b25", detail: "Pi stopped. Check the terminal for details." },
    disconnected: { label: "Offline", icon: "🔌", color: "#858b91", detail: "Disconnected. If it persists, run /chat again in Pi." },
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

  function updateFaviconStatus(color) {
    if (!faviconLogo) return;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><image href="${faviconLogo}" width="32" height="32"/><circle cx="22" cy="22" r="10" fill="#242424"/><circle cx="22" cy="22" r="8" fill="${color}" stroke="white" stroke-width="2"/></svg>`;
    const favicon = $("app-favicon");
    favicon.type = "image/svg+xml";
    favicon.href = `data:image/svg+xml,${encodeURIComponent(svg)}`;
  }

  function updateChatState() {
    const state = !connected ? "disconnected" : sender.sending || busy || composerControls.compacting ? "working" : failed ? "stopped" : "ready";
    const indicator = $("chat-state");
    if (indicator.dataset.state === state) return;
    indicator.dataset.state = state;
    const { label, icon, color, detail } = chatStates[state];
    setTooltip(indicator, detail);
    indicator.querySelector(".chat-state-label").textContent = detail;
    sessionTitleStatus.textContent = label;
    sessionTitleStatus.style.setProperty("--title-status-color", color);
    chatTitleStatus = `${icon} ${label}`;
    updateFaviconStatus(color);
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
  const isViewingLive = () => !explorer.isSaved() && !team?.viewingTeam();
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
  const annotations = mountAnnotationDraft(window, {
    sender, attachmentUi, status, setTooltip, isViewingLive,
    renderMarkdown: (markdown) => api("/api/markdown", { markdown }),
  });
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
      team?.setSavedView(explorer.isSaved());
      placeChatHeading();
      updateSubchatOriginVisibility();
      annotations.hideSelectionAction();
      updateControls();
    },
    onBackToLive() {
      updateLiveDocumentTitle();
      composer.focus();
    },
  });

  function placeChatHeading() {
    // The live toolbar is above the composer. Views that hide the composer need
    // the same toolbar outside the live conversation so the return control stays usable.
    const next = explorer.isSaved() || team?.viewingTeam() ? $("chat-rail") : $("chat-form");
    if (next.previousElementSibling === chatHeading) return;
    const focused = document.activeElement;
    next.before(chatHeading);
    if (chatHeading.contains(focused)) focused.focus({ preventScroll: true });
  }

  function startChat(data, mountChatNotes) {
    // Older servers silently ignore the new attachments field on messages with a caption.
    if (data.protocol !== 2) throw new Error("Pi's chat server is outdated. Run /reload, then /chat in Pi.");
    document.body.classList.add("chat-page");
    mountPanelResizers(window);
    placeChatHeading();
    sessionTitlePill.hidden = false;
    const shortcuts = new Map([
      ["Digit1", focusTerminalButton],
      ["Digit2", chatToolsToggle],
      ["Digit3", $("explorer-toggle")],
    ]);
    document.addEventListener("keydown", (event) => {
      if (event.defaultPrevented || event.isComposing || !event.ctrlKey || !event.shiftKey || event.altKey || event.metaKey) return;
      const button = shortcuts.get(event.code);
      if (!button || button.hidden || button.disabled || document.querySelector("dialog[open]")) return;
      event.preventDefault();
      if (event.repeat) return;
      if (button.getAttribute("aria-expanded") === "true" && $(button.getAttribute("aria-controls"))?.contains(document.activeElement)) {
        button.focus();
      }
      button.click();
    });
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
    if (data.team === true) void import("./team.js").then(({ mountAgentTeam }) => {
      team = mountAgentTeam(window, { api, attachmentUi, setTooltip, onViewChange() {
        placeChatHeading();
        annotations.hideSelectionAction();
        updateControls();
      } });
      team.setSavedView(explorer.isSaved());
      void team.refresh();
    }).catch(() => {}); // Older listeners don't serve the optional team assets.
    async function poll() {
      try {
        const wasConnected = connected;
        const sendsAtPollStart = sender.accepted;
        const data = await api(cursor === null ? "/api/response" : `/api/response?after=${encodeURIComponent(cursor)}`);
        // A poll started before send acknowledgement may still report the previous idle state.
        if (sendsAtPollStart === sender.accepted) updateChat(data);
        if (!wasConnected) explorer.refreshConnection();
        explorer.pollActivity();
        void team?.refresh();
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
    if (composer.hasDraft() || annotations.hasDraft() || notes?.hasPendingAttachments() || team?.hasDraft()) {
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
