import { mountExplorer } from "./explorer.js";
import { mountTranscript } from "./transcript.js";
import { createSendCoordinator } from "./send.js";
import { mountAnnotationDraft } from "./annotations.js";
import { mountAttachmentUi } from "./attachments.js";
import { mountComposerDraft } from "./composer.js";

export async function mountChatPage(window, { token, tooltipFactory, loadNotes = () => import("./notes.js") }) {
  const { document, crypto, Option } = window;
  const $ = (id) => document.getElementById(id);
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
  const sessionTitlePill = $("session-title-pill");
  const sessionTitleText = $("session-title-text");
  const renameSessionDialog = $("rename-session-dialog");
  const renameSessionInput = $("rename-session-input");
  const saveSessionName = $("save-session-name");
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
  const sender = createSendCoordinator({
    submit: (body) => api("/api/chat", body),
    requestId: () => crypto.randomUUID(),
    isAvailable: () => !explorer.isSaved() && !compacting && !modelChanging && connected,
    isBusy: () => busy,
    onChange() { updateChatState(); updateControls(); },
    onAccepted() {
      busy = true; // The next fresh poll reconciles this with Pi, even for a very fast reply.
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

  function updateControls() {
    composer.updateControls();
    annotations.updateControls();
    compactButton.disabled = confirmCompact.disabled = !compactAvailable || !connected || busy || sender.sending || compacting || modelChanging || explorer.isSaved();
    updateModelControls();
  }

  chatToolsToggle.addEventListener("click", () => {
    const expanded = chatToolsToggle.getAttribute("aria-expanded") === "true";
    document.querySelector("main").classList.toggle("chat-tools-collapsed", expanded);
    chatToolsToggle.setAttribute("aria-expanded", String(!expanded));
    const label = `${expanded ? "Expand" : "Collapse"} notes and annotations`;
    chatToolsToggle.setAttribute("aria-label", label);
    setTooltip(chatToolsToggle, label);
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
    const locked = !connected || busy || sender.sending || compacting || modelChanging || modelLoading;
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
      updateControls();
      try {
        modelSettings = await api("/api/session/model", { [key]: field.value });
      } catch (error) {
        $("chat-model-error").textContent = error.message;
      } finally {
        modelChanging = false;
        renderModelSettings();
        updateControls();
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
    updateControls();
    try {
      await api("/api/session/compact", {});
      status("Chat compacted.");
    } catch (error) {
      status(error.message || "Could not compact this chat.", true);
    } finally {
      compacting = false;
      updateChatState();
      updateControls();
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
    const state = !connected ? "disconnected" : sender.sending || busy || compacting ? "working" : failed ? "stopped" : "ready";
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
    updateControls();
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
  const isViewingLive = () => !explorer.isSaved();
  const attachmentUi = mountAttachmentUi(window, setTooltip);
  const composer = mountComposerDraft(window, { sender, attachmentUi, status, setTooltip });
  const annotations = mountAnnotationDraft(window, { sender, attachmentUi, status, setTooltip, isViewingLive });
  const transcript = mountTranscript(window, {
    fetchImage: (query) => window.fetch(`/api/image?${query}`, { headers: { Authorization: `Bearer ${token}` } }),
    isViewingLive, isCommentOpen: annotations.isDialogOpen,
    setTooltip, showImagePreview: attachmentUi.showImagePreview, status,
  });
  const explorer = mountExplorer(window, {
    api, status, setTooltip, hideMessagePreview,
    isConnected: () => connected,
    transcript,
    onViewChange() {
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
        updateContextUsage();
        if (wasConnected) explorer.refreshConnection();
        updateChatState();
        updateControls();
        if ([401, 410].includes(error.status)) return;
      }
      window.setTimeout(poll, connected ? 1000 : 3000);
    }
    window.setTimeout(poll, 1000);
  }

  window.addEventListener("beforeunload", (event) => {
    if (composer.hasDraft() || annotations.hasDraft()) {
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
