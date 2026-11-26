import { teamPet } from "./team-pets.js";

const labels = { queued: "Queued", working: "Working", paused: "Needs you", done: "Done", stopped: "Stopped" };

export function mountAgentTeam(window, { api, attachmentUi, onViewChange }) {
  const { document } = window;
  const $ = (id) => document.getElementById(id);
  const bar = $("team-bar"), toggle = $("team-toggle"), panel = $("team-panel"), viewToggle = $("team-view-toggle");
  const roles = $("team-roles"), transcript = $("team-transcript");
  const setup = $("team-setup"), start = $("team-start"), submit = $("team-submit"), pick = $("team-attach"), files = $("team-files");
  const direction = $("team-direction"), stop = $("team-stop"), brief = $("team-brief"), input = $("team-input");
  const attachmentList = $("team-attachments");
  let attachments = [], readingFiles = false, fileError = "";
  $("team-setup-pets").innerHTML = ["po", "backend", "frontend", "architect"].map(teamPet).join("");
  const cards = new Map(), drafts = new Map();
  let selected, saved = false, opened = false, supported = false, unavailable = false;
  let snapshot, pending = false, actionError = "", selection = 0;
  let transcriptRole, renderedMessages = [];

  function setRole(id) {
    if (id === selected) return;
    if (selected) drafts.set(selected, input.value);
    selected = id;
    if (snapshot) snapshot = { ...snapshot, messages: undefined };
    input.value = drafts.get(id) ?? "";
    selection++;
    document.querySelector("main").classList.toggle("team-viewing", Boolean(id));
    $("team-conversation").hidden = !id;
    onViewChange();
    render();
    if (id) void refresh(true);
  }

  function togglePanel(open) {
    opened = open;
    if (open && $("chat-tools-toggle").getAttribute("aria-expanded") === "false") $("chat-tools-toggle").click();
    panel.hidden = !open;
    document.querySelector("#chat-tools > #chat-tools-content").hidden = open;
    for (const button of [toggle, viewToggle]) button.setAttribute("aria-expanded", String(open));
    if (!open) setRole(undefined);
    render();
    if (!setup.hidden) brief.focus();
  }
  for (const button of [toggle, viewToggle]) button.addEventListener("click", () => togglePanel(!opened));
  $("team-setup-back").addEventListener("click", () => { togglePanel(false); viewToggle.focus(); });
  $("team-back").addEventListener("click", () => {
    setRole(undefined);
    cards.get("lead")?.focus();
  });

  function card(id, name) {
    if (cards.has(id)) return cards.get(id);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "secondary team-card";
    button.innerHTML = teamPet(id); // Sprite markup is generated only from local constants.
    const title = document.createElement("strong");
    title.textContent = name;
    const state = document.createElement("span");
    state.className = "team-card-state";
    button.append(title, state);
    button.addEventListener("click", () => {
      setRole(id === "lead" ? undefined : id);
      if (id !== "lead") transcript.focus({ preventScroll: true });
    });
    cards.set(id, button);
    roles.append(button);
    return button;
  }

  function syncSetup() {
    const phase = snapshot?.phase;
    const show = opened && !saved && (phase === "idle" || phase === "starting");
    const changed = setup.hidden === show;
    setup.hidden = !show;
    if (changed) onViewChange();
    const locked = pending || phase === "starting" || readingFiles;
    brief.readOnly = locked;
    pick.disabled = files.disabled = locked;
    submit.disabled = locked || (!brief.value.trim() && !attachments.length);
    for (const button of attachmentList.querySelectorAll("button")) button.disabled = locked;
    const problem = actionError || snapshot?.issue || fileError;
    const status = $("team-setup-status");
    status.textContent = problem || (phase === "starting" ? "Preparing worktrees…" : readingFiles ? "Reading files…" : "");
    status.classList.toggle("error", Boolean(problem));
  }

  function renderAttachments() {
    attachmentUi.renderAttachmentList(attachmentList, attachments, (index) => {
      attachments.splice(index, 1);
      renderAttachments();
    });
    syncSetup();
  }
  async function addFiles(selected) {
    if (!selected.length || pick.disabled) return;
    readingFiles = true;
    actionError = fileError = "";
    syncSetup();
    try {
      attachmentUi.checkAttachmentLimits(selected, attachments);
      attachments.push(...await Promise.all(selected.map(attachmentUi.readAttachment)));
      renderAttachments();
    } catch (error) {
      fileError = error.message;
    } finally {
      readingFiles = false;
      syncSetup();
    }
  }
  pick.addEventListener("click", () => files.click());
  files.addEventListener("change", () => {
    const selected = Array.from(files.files);
    files.value = "";
    void addFiles(selected);
  });
  brief.addEventListener("input", syncSetup);
  brief.addEventListener("paste", (event) => {
    const selected = Array.from(event.clipboardData?.files ?? []);
    if (!selected.length) return;
    event.preventDefault();
    void addFiles(selected);
  });
  start.addEventListener("dragover", (event) => {
    if (!event.dataTransfer?.types.includes("Files")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = pick.disabled ? "none" : "copy";
  });
  start.addEventListener("drop", (event) => {
    const selected = Array.from(event.dataTransfer?.files ?? []);
    if (!selected.length && !event.dataTransfer?.types.includes("Files")) return;
    event.preventDefault();
    void addFiles(selected);
  });

  function render() {
    if (!snapshot) return;
    const { phase, issue, worktrees, messages } = snapshot;
    if (["active", "done"].includes(phase) && (brief.value || attachments.length)) {
      brief.value = "";
      attachments = [];
      renderAttachments();
    }
    syncSetup();
    const waiting = snapshot.roles.filter(({ status }) => status === "paused").length;
    const attention = waiting ? `${waiting} ${waiting === 1 ? "role needs" : "roles need"} your input` : "";
    if ($("team-attention").textContent !== attention) $("team-attention").textContent = attention;
    roles.hidden = ["idle", "starting"].includes(phase);
    stop.hidden = !["starting", "active"].includes(phase);
    $("team-status").textContent = actionError || issue || ({ idle: "Write a brief in Teams to get started.", starting: "Preparing worktrees…", done: "Review complete. See the final report in Main chat. Changes are not integrated.", stopped: "Team stopped. Any worktree changes are retained." })[phase] || "";
    if (worktrees && $("team-worktrees").hidden) {
      $("team-worktrees").hidden = false;
      $("team-paths").textContent = `Backend: ${worktrees.backend}\nFrontend: ${worktrees.frontend}`;
    }
    if (roles.hidden) return;
    card("lead", "Main chat").setAttribute("aria-current", String(!selected));
    for (const role of snapshot.roles) {
      const button = card(role.id, role.name);
      button.setAttribute("aria-current", String(role.id === selected));
      button.dataset.state = role.status;
      button.querySelector(".team-card-state").textContent = labels[role.status];
    }
    const role = snapshot.roles.find(({ id }) => id === selected);
    if (!role) return;
    $("team-role-title").textContent = `${role.name} · ${labels[role.status]}`;
    direction.hidden = role.status !== "paused";
    $("team-report").textContent = role.report;
    if (transcriptRole !== role.id) {
      transcriptRole = role.id;
      transcript.replaceChildren();
      renderedMessages = [];
    }
    if (!messages) return;
    const follow = !renderedMessages.length || transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 40;
    if (renderedMessages.length > messages.length || renderedMessages.some((old, i) => old.who !== messages[i]?.who || old.text !== messages[i]?.text)) {
      transcript.replaceChildren();
      renderedMessages = [];
    }
    for (const { who, text } of messages.slice(renderedMessages.length)) {
      const row = document.createElement("section");
      const label = document.createElement("strong");
      const body = document.createElement("p");
      label.textContent = who;
      body.textContent = text;
      row.append(label, body);
      transcript.append(row);
    }
    renderedMessages = messages;
    if (follow) transcript.scrollTop = transcript.scrollHeight;
  }

  let request = 0;
  async function refresh(force = false) {
    if (unavailable || saved || (pending && !force)) return;
    const version = selection, sequence = ++request;
    const query = new URLSearchParams();
    if (selected) query.set("role", selected);
    if (!force && snapshot) query.set("revision", snapshot.revision);
    try {
      const result = await api(`/api/team?${query}`);
      if (sequence !== request || version !== selection || saved) return;
      supported = true;
      bar.hidden = viewToggle.hidden = false;
      if (result.roles) {
        snapshot = result;
        render();
      }
    } catch (error) {
      if ([401, 404, 410].includes(error.status)) unavailable = true;
    }
  }

  async function act(body, button, accepted) {
    if (pending) return;
    pending = button.disabled = true;
    actionError = fileError = "";
    syncSetup();
    try {
      await api("/api/team", body);
      accepted?.();
    } catch (error) {
      actionError = error.message;
    } finally {
      pending = button.disabled = false;
      render();
      await refresh(true);
    }
  }
  start.addEventListener("submit", (event) => {
    event.preventDefault();
    if (submit.disabled) return;
    void act({ action: "start", brief: brief.value.trim(), ...(attachments.length ? { attachments } : {}) }, submit);
  });
  direction.addEventListener("submit", (event) => {
    event.preventDefault();
    const id = selected;
    const role = snapshot?.roles.find((role) => role.id === id);
    if (!role || role.status !== "paused") return;
    const text = input.value;
    void act({ action: "resume", role: id, pause: role.pause, direction: text }, direction.querySelector("button"), () => {
      if (selected === id && input.value === text) input.value = "";
      if (drafts.get(id) === text) drafts.delete(id);
    });
  });
  stop.addEventListener("click", () => void act({ action: "stop" }, stop));

  return {
    refresh,
    viewingTeam: () => Boolean(selected) || !setup.hidden,
    hasDraft: () => (["idle", "starting"].includes(snapshot?.phase) && Boolean(brief.value.trim() || attachments.length || readingFiles)) || Boolean(input.value.trim()) || [...drafts.values()].some((draft) => draft.trim()),
    setSavedView(value) {
      if (saved === value) return;
      saved = value;
      if (saved) {
        viewToggle.hidden = true;
        setRole(undefined);
      } else {
        bar.hidden = viewToggle.hidden = !supported;
        void refresh(true);
      }
      syncSetup();
    },
  };
}
