const token = location.hash.slice(1);
history.replaceState(null, "", location.pathname + location.search);
const $ = (id) => document.getElementById(id);
// An older running Pi server may serve this file without the shared prefix.
const { set: setTooltip, hide: hideTooltip } = typeof createTooltips === "function"
  ? createTooltips({ sideTargets: ".side" })
  : { set: (target, text) => { target.title = text; }, hide: () => {} };
const filter = $("session-filter");
const stats = $("stats");
const clearStatus = $("clear-status-filter");
const directory = $("directory");
const projectPath = $("project-path");
const projectPathStatus = $("project-path-status");
const codexQuota = el("span", "codex-quota");
codexQuota.tabIndex = 0;
codexQuota.hidden = true;
const bookmarkView = document.querySelector('[data-view="bookmarks"]');
const archiveView = $("archive-view");
const createChatButton = $("create-chat");
const focusTerminalButton = $("focus-terminal");
const newChatDialog = $("new-chat-dialog");
const newChatProject = $("new-chat-project");
const newChatProjects = $("new-chat-projects");
const noProjectMatches = $("new-chat-no-projects");
const newChatError = $("new-chat-error");
const submitNewChat = $("submit-new-chat");
const cancelNewChat = $("cancel-new-chat");
const statuses = {
  working: "In progress",
  ready: "Ready to chat",
  disconnected: "Disconnected",
  error: "Error",
  saved: "Saved",
  connected: "Connected · status unavailable",
};
const petCaptions = {
  working: "Typing",
  ready: "Ready",
  error: "Needs help",
  disconnected: "Asleep",
  "terminal-working": "Working in Terminal",
  saved: "On the shelf",
  connected: "Status unavailable",
};
const disconnectedHint = (terminalWorking) => `${terminalWorking ? "Working" : "Running"} in Terminal · No chat tab connected`;
const actions = {
  focus: "Go to tab",
  "browser-tab": "Go to tab",
  "manual-tab": "Find existing tab",
  reopen: "Reopen chat",
  resume: "Resume chat",
  "manual-resume": "Resume command",
  unavailable: "Unavailable",
};
const priority = ["ready", "error", "working", "connected", "disconnected", "saved"];
const needsAttention = (session) => ["ready", "error"].includes(session.status);
let sessions = [];
let browserSelect = false;
let projects = [];
let view = "all";
let project;
let statusFilter;
let lastData;
let refreshInFlight;
let connected = false;
let creatingChat = false;
let chosenProject;
let activeProjectOption;
const pending = new Set();
const savingBookmarks = new Set();
const archiving = new Set();
const stopping = new Set();
const restoring = new Set();

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function dot(state, terminalWorking) {
  const node = el("span", `dot ${state}${terminalWorking ? " terminal-working" : ""}`);
  node.setAttribute("aria-hidden", "true");
  return node;
}

function pill(state, label = statuses[state], terminalWorking) {
  const node = el("span", "pill");
  node.append(dot(state, terminalWorking), label);
  if (state === "disconnected") setTooltip(node, terminalWorking === undefined ? "No chat tab connected" : disconnectedHint(terminalWorking));
  return node;
}

function age(ms) {
  if (!ms) return "";
  const minutes = Math.max(0, Math.floor((Date.now() - ms) / 60_000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h`;
  return `${Math.floor(minutes / 1440)}d`;
}

function projectName(cwd) {
  return cwd.split(/[\\/]/).filter(Boolean).at(-1) || cwd || "Unknown project";
}

function actionButton(session, inSidebar = false) {
  const action = actions[session.action];
  const label = stopping.has(session.id) ? "Stopping…" : pending.has(session.id) ? "Opening…" : action;
  const node = el("button", inSidebar ? "session-link" : "open", inSidebar ? undefined : label);
  node.type = "button";
  node.dataset.id = session.id;
  node.dataset.place = inSidebar ? "side" : "card";
  node.disabled = session.action === "unavailable";
  node.setAttribute("aria-disabled", String(pending.has(session.id) || stopping.has(session.id) || node.disabled));
  const { status, terminalWorking } = session;
  node.setAttribute("aria-label", `${label}: ${session.name} (${statuses[status]}${terminalWorking ? " · Working in Terminal" : ""})`);
  setTooltip(node, status === "disconnected" ? `${session.name} · ${disconnectedHint(terminalWorking)}` : session.name);
  if (inSidebar) node.append(dot(status, terminalWorking), el("span", "truncate", session.name), el("span", "meta", age(session.modified)));
  return node;
}

function sessionIconButton({ id, name }, place, label, shape, busy) {
  const button = el("button", `${place}-session`);
  button.type = "button";
  button.dataset.id = id;
  button.dataset.place = place;
  button.setAttribute("aria-label", `${label}: ${name}`);
  button.setAttribute("aria-disabled", String(busy));
  setTooltip(button, label);
  const ns = "http://www.w3.org/2000/svg";
  const icon = document.createElementNS(ns, "svg");
  for (const [name, value] of Object.entries({ width: 16, height: 16, viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", "stroke-width": 1.3, "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" })) {
    icon.setAttribute(name, value);
  }
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", shape);
  icon.append(path);
  button.append(icon);
  return button;
}

function sidebarSession(session) {
  const link = actionButton(session, true);
  const stop = session.status === "disconnected" && session.stopTarget;
  if (!stop && !session.canArchive) return link;
  const row = el("div", "session-with-action");
  const button = stop
    ? sessionIconButton(session, "stop", "Stop Pi session", "M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM6 6l4 4m0-4-4 4", stopping.has(session.id) || pending.has(session.id))
    : sessionIconButton(session, "archive", "Archive", "M2.5 4h11M6 4V2h4v2M4 4l.7 10h6.6L12 4M7 7v4m2-4v4", archiving.has(session.id));
  row.append(link, button);
  return row;
}

function sidebar(groups) {
  const nodes = [];
  for (const [cwd, items] of groups) {
    const selected = view === "project" && project === cwd;
    const group = el("section", selected ? "project selected" : "project");
    const heading = el("button", "project-heading");
    heading.type = "button";
    heading.dataset.project = cwd;
    setTooltip(heading, cwd);
    if (selected) heading.setAttribute("aria-current", "true");
    heading.append(el("span", "truncate", projectName(cwd)), el("span", "meta", items.length));
    group.append(heading, ...items.map(sidebarSession));
    nodes.push(group);
  }
  $("projects").replaceChildren(...nodes);
  for (const button of document.querySelectorAll("[data-view]")) {
    if (button.dataset.view === view) button.setAttribute("aria-current", "true");
    else button.removeAttribute("aria-current");
  }
}

function renderArchive(archived) {
  if (!archiveView) return;
  archiveView.hidden = archived === undefined;
  const list = $("archived-sessions");
  const empty = $("archive-empty");
  const items = archived ?? [];
  $("archive-count").textContent = archived ? items.length : "";
  empty.hidden = items.length > 0;
  empty.textContent = archived === null ? "Could not load the archive." : "No archived chats yet.";
  const focused = document.activeElement?.dataset;
  list.hidden = items.length === 0;
  list.replaceChildren(...items.map(({ id, name, cwd, archivedAt }) => {
    const item = el("li");
    const details = el("span", "meta");
    const date = new Date(archivedAt);
    const time = el("time", "", date.toLocaleDateString());
    time.dateTime = date.toISOString();
    if (cwd) details.append(`${projectName(cwd)} · `);
    details.append(time);
    item.append(el("span", "", name), details);
    if (id) item.append(sessionIconButton({ id, name }, "restore", "Restore", "M2.5 4v4h4M2.5 8l2-2a5.5 5.5 0 1 1 1 8", restoring.has(id)));
    return item;
  }));
  if (focused?.place === "restore") (restoreButton(focused.id) ?? archiveView.querySelector("summary")).focus({ preventScroll: true });
}

function bookmarkButton(session) {
  const button = el("button", "bookmark");
  button.type = "button";
  button.dataset.id = session.id;
  button.dataset.place = "bookmark";
  button.setAttribute("aria-label", `Bookmark: ${session.name}`);
  button.setAttribute("aria-pressed", String(session.bookmarked));
  button.setAttribute("aria-disabled", String(savingBookmarks.has(session.id)));
  setTooltip(button, session.bookmarked ? "Remove bookmark" : "Add bookmark");
  const ns = "http://www.w3.org/2000/svg";
  const icon = document.createElementNS(ns, "svg");
  for (const [name, value] of Object.entries({ width: 16, height: 18, viewBox: "0 0 16 18", fill: "none", stroke: "currentColor", "stroke-width": 1.5, "stroke-linejoin": "round", "aria-hidden": "true" })) {
    icon.setAttribute(name, value);
  }
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", "M3 2h10v14l-5-3.5L3 16z");
  icon.append(path);
  button.append(icon);
  return button;
}

function petStage({ status, terminalWorking }) {
  const reaction = status === "disconnected" && terminalWorking ? "terminal-working" : status;
  const stage = $("pet-stage").content.firstElementChild.cloneNode(true);
  stage.dataset.pet = reaction;
  stage.querySelector(".pet-caption").textContent = petCaptions[reaction];
  return stage;
}

function cards(cwd, items, namesById) {
  const section = el("section", "section");
  const grid = el("div", "grid");
  if (view !== "project") section.append(el("h2", "", projectName(cwd)), el("p", "directory", cwd || "No saved directory"));
  for (const session of items) {
    const card = el("article", "card");
    const heading = el("header", "card-heading");
    heading.append(pill(session.status, "", Boolean(session.terminalWorking)), el("h3", "", session.name));
    card.append(heading);
    const parent = namesById.get(session.parentId);
    if (parent) {
      const lineage = el("p", "clone-lineage");
      const icon = el("span", "", "⑂");
      icon.setAttribute("aria-hidden", "true");
      lineage.append(icon, ` Cloned from ${parent}`);
      card.append(lineage);
    }
    if (typeof session.bookmarked === "boolean") card.append(bookmarkButton(session));
    if (session.preview) card.append(el("p", "", session.preview));
    const row = el("div", "row");
    const when = el("time", "", session.modified ? `Updated ${age(session.modified)}` : "");
    if (session.modified) {
      when.dateTime = new Date(session.modified).toISOString();
      setTooltip(when, new Date(session.modified).toLocaleString());
    }
    row.append(when);
    if (session.canVerify) {
      const verify = el("button", "verify-agent", "Verify agent");
      verify.type = "button";
      verify.dataset.place = "verify";
      verify.dataset.id = session.id;
      setTooltip(verify, "Open an independent, read-only Sol review of the current worktree in a new chat");
      row.append(verify);
    }
    row.append(actionButton(session));
    card.append(petStage(session), row);
    grid.append(card);
  }
  section.append(grid);
  return section;
}

function render() {
  hideTooltip();
  const focused = document.activeElement?.dataset;
  const actionProject = ["archive", "stop"].includes(focused?.place) ? document.activeElement.closest(".project")?.querySelector(".project-heading")?.dataset.project : undefined;
  createChatButton.disabled = !projects.length;
  if (view === "project" && !projects.includes(project) && !sessions.some(({ cwd }) => cwd === project)) {
    view = "all";
    statusFilter = undefined;
  }
  const query = filter.value.trim().toLowerCase();
  const matches = sessions.filter(({ name, cwd, bookmarked }) =>
    (view !== "bookmarks" || bookmarked) && (name.toLowerCase().includes(query) || cwd.toLowerCase().includes(query)));
  const groups = new Map();
  for (const session of matches.sort((a, b) => priority.indexOf(a.status) - priority.indexOf(b.status) || b.modified - a.modified)) {
    if (!groups.has(session.cwd)) groups.set(session.cwd, []);
    groups.get(session.cwd).push(session);
  }
  for (const cwd of projects) {
    if (view !== "bookmarks" && !groups.has(cwd) && cwd.toLowerCase().includes(query)) groups.set(cwd, []);
  }
  sidebar(groups);
  $("heading").textContent = view === "project" ? projectName(project)
    : view === "attention" ? "Needs attention" : view === "bookmarks" ? "Bookmarks" : "All sessions";
  const path = view === "project" ? project ?? "" : "";
  directory.hidden = !path;
  if (projectPath.textContent !== path) {
    projectPath.textContent = path;
    projectPathStatus.textContent = "";
  }
  // Needs attention filters the cards, not the status overview.
  const scope = view === "project" ? groups.get(project) ?? [] : matches;
  const counts = Object.fromEntries(Object.keys(statuses).map((state) => [state, 0]));
  for (const session of scope) counts[session.status]++;
  const total = `${scope.length} ${scope.length === 1 ? "session" : "sessions"}`;
  const attention = counts.ready + counts.error;
  $("summary").textContent = view === "attention" ? `${attention} of ${total} need attention`
    : `${total} · ${attention} need attention · ${counts.saved} saved`;
  const canFilterStatus = view === "all" || view === "project";
  stats.replaceChildren(...["working", "ready", "disconnected", "error"].map((state) => {
    const stat = el(canFilterStatus ? "button" : "div", "stat");
    if (canFilterStatus) {
      stat.type = "button";
      stat.dataset.statusFilter = state;
      stat.setAttribute("aria-controls", "sessions");
      stat.setAttribute("aria-pressed", String(statusFilter === state));
    }
    stat.append(pill(state, state === "error" ? "Errors" : statuses[state]), el("b", "", counts[state]));
    return stat;
  }));
  clearStatus.hidden = !statusFilter;
  const namesById = new Map(sessions.map(({ id, name }) => [id, name]));
  const visible = [...groups].flatMap(([cwd, items]) => {
    const selected = statusFilter ? items.filter(({ status }) => status === statusFilter)
      : view === "attention" ? items.filter(needsAttention) : items;
    return (view !== "project" || cwd === project) && selected.length ? [cards(cwd, selected, namesById)] : [];
  });
  const empty = statusFilter ? "No sessions match the status filter in the current view."
    : query ? "No sessions match this filter in the current view."
    : view === "attention" ? "No ready or failed chats right now."
    : view === "bookmarks" ? "No bookmarks yet. Use the bookmark button on a session card to add one."
    : projects.length ? "No sessions here yet. Use Create new chat to get started." : "No Pi sessions found.";
  $("sessions").replaceChildren(...(visible.length ? visible : [el("p", "sub", empty)]));
  if (focused?.statusFilter) {
    stats.querySelector(`[data-status-filter="${focused.statusFilter}"]`)?.focus({ preventScroll: true });
  } else if (focused?.id !== undefined || focused?.project !== undefined) {
    const replacement = [...document.querySelectorAll("button[data-id], button[data-project]")].find(({ dataset }) =>
      focused.id !== undefined ? dataset.id === focused.id && dataset.place === focused.place : dataset.project === focused.project);
    const rowLink = focused.place === "stop" ? [...document.querySelectorAll(".session-link")].find(({ dataset }) => dataset.id === focused.id) : undefined;
    const fallback = actionProject === undefined ? undefined : [...document.querySelectorAll(".project-heading")].find(({ dataset }) => dataset.project === actionProject);
    (replacement ?? rowLink ?? fallback ?? (view === "bookmarks" ? bookmarkView : undefined))?.focus({ preventScroll: true });
  }
}

async function api(path, data) {
  const headers = { Authorization: `Bearer ${token}` };
  if (data) headers["Content-Type"] = "application/json";
  // Same-origin POSTs need a non-opaque Origin despite the page's no-referrer policy.
  const response = await fetch(path, data ? { method: "POST", headers, body: JSON.stringify(data), referrerPolicy: "same-origin" } : { headers });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Dashboard request failed.");
  return result;
}

function notice(message, error = false, command = "") {
  $("notice").hidden = false;
  $("notice").dataset.error = String(error);
  $("message").textContent = message;
  $("manual").hidden = !command;
  $("command").value = command;
}

async function refresh(force = false) {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    try {
      const result = await api(force ? "/api/dashboard?refresh=1" : "/api/dashboard");
      connected = true;
      const left = result.codexQuotaLeft;
      const quotaLabel = Number.isInteger(left) && left >= 0 && left <= 100 ? `5-hour · ${left}% left` : "";
      if (codexQuota.textContent !== quotaLabel) codexQuota.textContent = quotaLabel;
      codexQuota.hidden = !quotaLabel;
      const now = Date.now();
      let quotaTooltip = "Codex account usage limit";
      const resetsAt = result.codexQuotaResetsAt;
      if (Number.isSafeInteger(resetsAt) && resetsAt * 1000 > now) {
        const remaining = Math.ceil((resetsAt * 1000 - now) / 60_000);
        const hours = Math.floor(remaining / 60);
        const minutes = remaining % 60;
        const duration = [hours && `${hours}h`, minutes && `${minutes}m`].filter(Boolean).join(" ");
        quotaTooltip += `\nResets in ${duration}`;
      }
      setTooltip(codexQuota, quotaTooltip);
      const key = JSON.stringify(result) + Math.floor(now / 60_000);
      if (key !== lastData) {
        lastData = key;
        sessions = result.sessions;
        browserSelect = result.browserSelect === true;
        projects = result.projects ?? [...new Set(sessions.map(({ cwd }) => cwd).filter(Boolean))];
        focusTerminalButton.hidden = result.canFocusTerminal !== true;
        bookmarkView.hidden = result.supportsBookmarks !== true;
        renderArchive(result.archived);
        render();
      }
      if (force) notice("Dashboard refreshed.");
    } catch {
      if (connected || !lastData) notice("Could not connect to the dashboard. If Pi was closed or reloaded, run /chat dashboard again.", true);
      connected = false;
      codexQuota.hidden = true;
      if (!lastData) $("summary").textContent = "Dashboard unavailable";
    }
  })().finally(() => { refreshInFlight = undefined; });
  return refreshInFlight;
}

async function archiveChat(id) {
  if (!sessions.some((session) => session.id === id && session.canArchive) || archiving.has(id)) return;
  archiving.add(id);
  render();
  try {
    const result = await api("/api/session/archive", { id });
    await refreshInFlight;
    await refresh();
    notice(result.message);
  } catch (error) {
    notice(error.message, true);
  } finally {
    archiving.delete(id);
    render();
  }
}

async function stopChat(id) {
  const session = sessions.find((item) => item.id === id);
  if (session?.status !== "disconnected" || !session.stopTarget || pending.has(id) || stopping.has(id)) return;
  if (!window.confirm(`Stop Pi for “${session.name}”? Any work in progress will be interrupted. Saved chat history will stay available.`)) return;
  stopping.add(id);
  render();
  try {
    const result = await api("/api/session/stop", { id, target: session.stopTarget });
    await refreshInFlight;
    await refresh();
    notice(result.message);
  } catch (error) {
    notice(error.message, true);
  } finally {
    stopping.delete(id);
    render();
  }
}

function restoreButton(id) {
  return [...document.querySelectorAll(".restore-session")].find(({ dataset }) => dataset.id === id);
}

async function restoreChat(button) {
  const { id } = button.dataset;
  if (restoring.has(id)) return;
  restoring.add(id);
  button.setAttribute("aria-disabled", "true");
  try {
    const result = await api("/api/session/restore", { id });
    await refreshInFlight;
    await refresh();
    notice(result.message);
  } catch (error) {
    notice(error.message, true);
  } finally {
    restoring.delete(id);
    restoreButton(id)?.setAttribute("aria-disabled", "false");
  }
}

async function toggleBookmark(id) {
  const session = sessions.find((item) => item.id === id);
  if (!session || savingBookmarks.has(id)) return;
  savingBookmarks.add(id);
  render();
  try {
    await api("/api/session/bookmark", { id, bookmarked: !session.bookmarked });
    // A poll already in flight might have read the state before the write.
    await refreshInFlight;
    await refresh();
  } catch (error) {
    notice(error.message, true);
  } finally {
    savingBookmarks.delete(id);
    render();
  }
}

async function focusBrowserTab(tab) {
  // Stable unpacked-extension ID derived from the public key in its manifest.
  const runtime = window.chrome?.runtime;
  const result = runtime?.sendMessage && await new Promise((resolve) => {
    runtime.sendMessage("gknkmicgmlfoodjnfohhgmiglekddeea", { focusTab: tab }, (response) => resolve(runtime.lastError ? undefined : response));
  });
  if (!result) throw new Error("Load Pi Chat Tab Switcher in this Edge or Chrome profile to select an existing chat tab. See docs/ubuntu-edge-kitty.md.");
  if (result !== "focused" && result !== "missing") throw new Error("The browser could not activate the chat tab. Try again.");
  return result;
}

async function openChat(id) {
  const session = sessions.find((item) => item.id === id);
  if (!session || pending.has(id) || stopping.has(id)) return;
  pending.add(id);
  render();
  try {
    const intent = browserSelect ? "select" : ["focus", "manual-tab"].includes(session.action) ? "focus" : "open";
    let result = await api("/api/open", { id, intent });
    if (result.focusTab && await focusBrowserTab(result.focusTab) === "missing") {
      // A closing chat may still be disconnecting. Recheck its owner before launching anything.
      result = await api("/api/open", { id, intent: "select" });
      if (result.focusTab) throw new Error("Pi still reports a connected tab. Use the same browser profile, or run /chat close in its terminal and click again.");
    }
    if (result.command) notice(result.message || "Resume this session manually.", false, result.command);
    else $("notice").hidden = true;
  } catch (error) {
    notice(error.message, true);
  } finally {
    pending.delete(id);
    render();
    await refresh();
  }
}

function highlightProject(option) {
  activeProjectOption?.setAttribute("aria-selected", "false");
  activeProjectOption = option;
  if (option) {
    option.setAttribute("aria-selected", "true");
    newChatProject.setAttribute("aria-activedescendant", option.id);
    option.scrollIntoView?.({ block: "nearest" });
  } else newChatProject.removeAttribute("aria-activedescendant");
}

function hideProjectCompletions() {
  highlightProject(undefined);
  newChatProjects.hidden = noProjectMatches.hidden = true;
  newChatProject.setAttribute("aria-expanded", "false");
}

function showProjectCompletions() {
  const query = chosenProject ? "" : newChatProject.value.trim().toLowerCase();
  const matches = projects.filter((cwd) => cwd.toLowerCase().includes(query))
    .sort((a, b) => projectName(a).localeCompare(projectName(b)) || a.localeCompare(b));
  highlightProject(undefined);
  newChatProjects.replaceChildren(...matches.map((cwd, index) => {
    const option = el("li");
    option.id = `new-chat-option-${index}`;
    option.dataset.cwd = cwd;
    option.setAttribute("role", "option");
    option.setAttribute("aria-selected", "false");
    option.append(el("strong", "", projectName(cwd)), el("small", "", cwd));
    return option;
  }));
  newChatProjects.hidden = !matches.length;
  noProjectMatches.hidden = !!matches.length;
  newChatProject.setAttribute("aria-expanded", String(!!matches.length));
}

function chooseProject(cwd) {
  chosenProject = cwd;
  newChatProject.value = cwd ?? "";
  submitNewChat.disabled = !cwd;
  newChatError.textContent = "";
  hideProjectCompletions();
}

createChatButton.addEventListener("click", () => {
  chooseProject(view === "project" && projects.includes(project) ? project : undefined);
  newChatDialog.showModal();
  newChatProject.focus();
  if (!chosenProject) showProjectCompletions();
});
newChatProject.addEventListener("input", () => {
  chosenProject = undefined;
  submitNewChat.disabled = true;
  newChatError.textContent = "";
  showProjectCompletions();
});
newChatProject.addEventListener("click", showProjectCompletions);
newChatProject.addEventListener("blur", hideProjectCompletions);
// Keep focus on the combobox when an option is clicked.
newChatProjects.addEventListener("mousedown", (event) => event.preventDefault());
newChatProjects.addEventListener("click", (event) => {
  const option = event.target.closest('[role="option"]');
  if (option) chooseProject(option.dataset.cwd);
});
newChatProject.addEventListener("keydown", (event) => {
  if (event.isComposing) return;
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    if (newChatProjects.hidden) showProjectCompletions();
    const down = event.key === "ArrowDown";
    const option = activeProjectOption ? (down ? activeProjectOption.nextElementSibling : activeProjectOption.previousElementSibling) ?? activeProjectOption
      : down ? newChatProjects.firstElementChild : newChatProjects.lastElementChild;
    highlightProject(option);
  } else if (event.key === "Enter" && !newChatProjects.hidden) {
    const option = activeProjectOption ?? (newChatProjects.childElementCount === 1 ? newChatProjects.firstElementChild : null);
    if (option) {
      event.preventDefault();
      chooseProject(option.dataset.cwd);
    }
  } else if (event.key === "Escape" && (!newChatProjects.hidden || !noProjectMatches.hidden)) {
    event.preventDefault();
    hideProjectCompletions();
  }
});
cancelNewChat.addEventListener("click", () => newChatDialog.close());
newChatDialog.addEventListener("cancel", (event) => { if (creatingChat) event.preventDefault(); });
$("new-chat-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const cwd = chosenProject;
  if (creatingChat || !cwd || newChatProject.value !== cwd) return;
  if (!projects.includes(cwd)) {
    chooseProject(undefined);
    newChatError.textContent = "That project is no longer available. Choose another project.";
    newChatProject.focus();
    showProjectCompletions();
    return;
  }
  hideProjectCompletions();
  creatingChat = newChatProject.disabled = submitNewChat.disabled = cancelNewChat.disabled = true;
  submitNewChat.textContent = "Starting…";
  newChatError.textContent = "";
  try {
    const result = await api("/api/session/new", { cwd });
    newChatDialog.close();
    notice(result.message || "Open a fresh Pi session in this project.", false, result.command);
    void refresh();
  } catch (error) {
    newChatError.textContent = error.message;
  } finally {
    creatingChat = newChatProject.disabled = submitNewChat.disabled = cancelNewChat.disabled = false;
    submitNewChat.textContent = "Create chat";
  }
});

document.addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button) {
    const open = event.target.closest(".card")?.querySelector("button.open");
    if (open && !open.disabled && !window.getSelection()?.toString()) void openChat(open.dataset.id);
    return;
  }
  const { id, place, project: cwd, view: next, statusFilter: state } = button.dataset;
  if (state) {
    statusFilter = statusFilter === state ? undefined : state;
    render();
  } else if (place === "verify") {
    button.disabled = true;
    void api("/api/session/verify", { id }).then(result => notice(result.message), error => notice(error.message, true)).finally(() => { button.disabled = false; });
  } else if (place === "bookmark") void toggleBookmark(id);
  else if (place === "archive") void archiveChat(id);
  else if (place === "stop") void stopChat(id);
  else if (place === "restore") void restoreChat(button);
  else if (id !== undefined) void openChat(id);
  else if (cwd !== undefined || next) {
    if (view !== (next || "project") || project !== cwd) statusFilter = undefined;
    view = next || "project";
    project = cwd;
    render();
    $("dashboard-scroll").scrollTop = 0;
  }
});
$("legend").append(...["working", "ready", "disconnected", "error", "saved"].map((state) => pill(state)), codexQuota);
filter.addEventListener("input", render);
clearStatus.addEventListener("click", () => {
  stats.querySelector(`[data-status-filter="${statusFilter}"]`)?.focus({ preventScroll: true });
  statusFilter = undefined;
  render();
});
$("refresh").addEventListener("click", () => void refresh(true));
focusTerminalButton.addEventListener("click", async () => {
  if (focusTerminalButton.hidden || focusTerminalButton.disabled) return;
  focusTerminalButton.disabled = true;
  try {
    const result = await api("/api/focus-terminal", {});
    notice(result.message);
  } catch (error) {
    notice(error.message, true);
  } finally {
    focusTerminalButton.disabled = false;
  }
});
$("dismiss").addEventListener("click", () => { $("notice").hidden = true; });
$("copy-project-path").addEventListener("click", async () => {
  const path = projectPath.textContent;
  if (!path) return;
  let message;
  try {
    await navigator.clipboard.writeText(path);
    message = "Path copied.";
  } catch {
    message = "Couldn’t copy. Select the path to copy it manually.";
  }
  if (projectPath.textContent === path) projectPathStatus.textContent = message;
});
$("copy").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText($("command").value);
    $("message").textContent = "Command copied.";
  } catch {
    $("command").select();
    $("message").textContent = "Copy the selected command manually.";
  }
});
document.addEventListener("visibilitychange", () => { if (!document.hidden) void refresh(); });
async function poll() {
  await refresh();
  setTimeout(poll, 2000);
}
void poll();
