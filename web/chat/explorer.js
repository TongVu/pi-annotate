export function mountExplorer(window, { api, status, setTooltip, hideMessagePreview, isConnected, transcript, onViewChange, onBackToLive }) {
  const { document, navigator, URLSearchParams, ClipboardItem, Blob } = window;
  const $ = (id) => document.getElementById(id);
  let catalog;
  let loadingSessions;
  let catalogProblem = "";
  let openingSavedChat;
  let activeSessions = [];
  let nextActivityCheck = 0;
  let activityInFlight = false;
  let savedSessionId;
  let savedSelection = 0;

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
        showResumeCommand(await command);
      } catch (error) {
        status(error.message || "Could not get this session’s resume command.", true);
      }
    }
  }

  function showResumeCommand(command) {
    const field = $("resume-command");
    field.value = command;
    $("resume-command-dialog").showModal();
    field.focus();
    field.select();
  }

  $("close-resume-command").addEventListener("click", () => $("resume-command-dialog").close());
  function updateSavedLaunchButton() {
    const saved = catalog?.sessions.find(({ id }) => id === savedSessionId);
    const alreadyOpen = activeSessions.some(({ id }) => id === savedSessionId);
    const opening = Boolean(saved && openingSavedChat === saved.id);
    openSavedButton.hidden = !catalog?.canOpen || !saved?.cwd;
    openSavedButton.disabled = !isConnected() || alreadyOpen || opening;
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
        setTooltip(heading, cwd);
        element.append(heading);
        list.append(element);
        group = { element, roots: [] };
        groups.set(cwd, group);
      }
      const active = own ? isConnected() : Boolean(peer);
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
      setTooltip(button, name);
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
        setTooltip(indicator, indicator.getAttribute("aria-label"));
        actions.append(indicator);
        if (session.canClone) {
          const clone = document.createElement("button");
          clone.type = "button";
          clone.className = "secondary session-clone";
          clone.textContent = "🧬";
          clone.setAttribute("aria-label", `Clone chat session ${name}`);
          setTooltip(clone, `Clone chat session ${name}`);
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
        setTooltip(copy, "Copy resume command");
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
      const branch = document.createElement("div");
      branch.className = "session-tree-node";
      branch.append(node.row);
      container.append(branch);
      if (!node.children.length) return;
      const children = document.createElement("div");
      children.className = "session-tree-children";
      node.children.forEach((child) => appendNode(children, child));
      branch.append(children);
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

  function loadSessions() {
    return loadingSessions ??= fetchSessions().finally(() => { loadingSessions = undefined; });
  }

  async function fetchSessions() {
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
        transcript.clearSaved();
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

  function setSavedView(saved) {
    $("saved-conversation").hidden = $("saved-title").hidden = !saved;
    for (const id of ["conversation", "chat-rail", "chat-tools", "session-title-text", "focus-terminal", "chat-tools-toggle"]) $(id).hidden = saved;
    if (window.matchMedia?.("(max-width: 760px)").matches) setExplorerOpen(false);
    renderSessionList();
    onViewChange();
  }

  function showLiveChat() {
    savedSelection++;
    savedSessionId = undefined;
    transcript.clearSaved();
    setSavedView(false);
    transcript.restoreLiveScroll();
    onBackToLive();
  }

  async function showSavedChat({ id, name, cwd }, replyId) {
    const selection = ++savedSelection;
    if (!savedSessionId) transcript.rememberLiveScroll();
    savedSessionId = id;
    transcript.clearSaved();
    document.title = name;
    $("saved-title").textContent = name;
    $("saved-directory").textContent = cwd ? `Read-only · ${cwd}` : "Read-only · Unknown directory";
    $("saved-status").textContent = "Loading conversation…";
    setSavedView(true);
    transcript.focusSaved();
    try {
      const { messages } = await api(`/api/session?${new URLSearchParams({ id })}`);
      if (selection !== savedSelection) return;
      const foundReply = transcript.renderSaved(messages, id, replyId);
      $("saved-status").textContent = replyId && !foundReply ? "The original reply is no longer on the parent’s active branch."
        : !messages.length ? "No visible messages in this saved chat."
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

  return {
    isSaved: () => savedSessionId !== undefined,
    refreshSessions: loadSessions,
    showResumeCommand,
    async showParent(replyId) {
      await loadSessions();
      const parent = catalog?.sessions.find(({ id }) => id === catalog.current.parentId);
      if (parent) await showSavedChat(parent, replyId);
      else status(catalogProblem || "The parent chat is not available in the explorer.", true);
    },
    setLiveSessionName(name) {
      if (catalog && catalog.current.name !== name) {
        catalog.current.name = name;
        renderSessionList();
      }
    },
    refreshConnection: renderSessionList,
    pollActivity() {
      if (!explorer.hidden || savedSessionId) void refreshActivity();
    },
  };
}
