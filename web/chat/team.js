import { teamPet } from "./team-pets.js";

const labels = { queued: "Queued", working: "Working", paused: "Needs you", done: "Done", stopped: "Stopped" };

export function mountAgentTeam(window, { api, attachmentUi, onViewChange, setTooltip = (target, text) => { target.title = text; } }) {
  const { document } = window;
  const $ = (id) => document.getElementById(id);
  const panel = $("team-panel"), viewToggle = $("team-view-toggle");
  const toolsToggle = $("chat-tools-toggle"), notes = $("chat-tools-content");
  const roles = $("team-roles"), transcript = $("team-transcript");
  const setup = $("team-setup"), start = $("team-start"), submit = $("team-submit"), pick = $("team-attach"), files = $("team-files");
  const direction = $("team-direction"), stop = $("team-stop"), cancelStart = $("team-cancel-start");
  const brief = $("team-brief"), input = $("team-input");
  const attachmentList = $("team-attachments"), resultView = $("team-result");
  const feedbackButton = $("team-feedback");
  let composingFeedback = false, displayedRound = 0;
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
    const label = open ? "Return to main chat" : "Open Teams";
    viewToggle.setAttribute("aria-expanded", String(open));
    viewToggle.setAttribute("aria-label", label);
    setTooltip(viewToggle, label);
    if (!open) {
      if (snapshot?.phase === "done") composingFeedback = false;
      setRole(undefined);
    }
    render();
    if (!setup.hidden) brief.focus();
  }
  viewToggle.addEventListener("click", () => togglePanel(!opened));

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
      if (id === "lead" && snapshot?.phase === "done") { togglePanel(false); viewToggle.focus(); return; }
      setRole(id === "lead" ? undefined : id);
      if (id !== "lead") transcript.focus({ preventScroll: true });
    });
    cards.set(id, button);
    roles.append(button);
    return button;
  }

  function syncSetup() {
    const phase = snapshot?.phase;
    const visible = opened && !saved;
    const show = visible && (phase === "idle" || phase === "starting" || (phase === "done" && composingFeedback));
    const showResult = visible && phase === "done" && !!snapshot.result && !show && !selected;
    const changed = setup.hidden === show || resultView.hidden === showResult;
    const restoreFocus = !setup.hidden && !show && !saved && setup.contains(document.activeElement);
    setup.hidden = !show;
    resultView.hidden = !showResult;
    const showPanel = opened && !saved && !show;
    if (showPanel && panel.hidden && toolsToggle.getAttribute("aria-expanded") === "false") toolsToggle.click();
    panel.hidden = !showPanel;
    notes.hidden = showPanel;
    if (changed) onViewChange();
    if (restoreFocus) viewToggle.focus();
    const locked = pending || phase === "starting" || readingFiles;
    brief.readOnly = locked;
    pick.disabled = files.disabled = locked;
    cancelStart.hidden = phase !== "starting";
    cancelStart.disabled = pending;
    submit.hidden = !cancelStart.hidden;
    submit.disabled = locked || (!brief.value.trim() && !attachments.length);
    for (const button of attachmentList.querySelectorAll("button")) button.disabled = locked;
    const problem = actionError || snapshot?.issue || fileError;
    const status = $("team-setup-status");
    status.textContent = problem || (phase === "starting" ? "Preparing the shared workspace…" : readingFiles ? "Reading files…" : "");
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
    const { phase, round, issue, workspace, result, messages } = snapshot;
    if (round > displayedRound) {
      displayedRound = round;
      composingFeedback = false;
      brief.value = "";
      attachments = [];
      renderAttachments();
    }
    syncSetup();
    if (result) {
      $("team-round").textContent = `TEAMS · ROUND ${round}`;
      $("team-result-workspace").textContent = workspace.cwd;
      $("team-result-files").textContent = result.files || "No code changes.";
      $("team-result-diff").textContent = result.diff || "No patch to display.";
      $("team-result-truncated").hidden = !result.truncated;
    }
    const waiting = snapshot.roles.filter(({ status }) => status === "paused").length;
    const attention = waiting ? `${waiting} ${waiting === 1 ? "role needs" : "roles need"} your input` : "";
    if ($("team-attention").textContent !== attention) $("team-attention").textContent = attention;
    $("team-attention-dot").hidden = !waiting;
    roles.hidden = ["idle", "starting"].includes(phase);
    stop.hidden = phase !== "active";
    $("team-status").textContent = actionError || issue || (phase === "stopped" ? "Team stopped. The workspace was retained." : "");
    if (workspace && $("team-workspace").hidden) {
      $("team-workspace").hidden = false;
      $("team-paths").textContent = workspace.cwd;
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
      viewToggle.hidden = false;
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
    void act({ action: composingFeedback ? "feedback" : "start", brief: brief.value.trim(), ...(attachments.length ? { attachments } : {}) }, submit);
  });
  feedbackButton.addEventListener("click", () => {
    if (snapshot?.phase !== "done") return;
    composingFeedback = true;
    actionError = fileError = "";
    $("team-setup-title").textContent = "Feedback for the team";
    $("team-setup-description").textContent = "The same roles will continue from the latest changes in the shared workspace.";
    brief.placeholder = "What should change in this result?";
    submit.setAttribute("aria-label", "Send feedback");
    setTooltip(submit, "Send feedback");
    syncSetup();
    brief.focus();
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
  for (const button of [stop, cancelStart]) button.addEventListener("click", () => void act({ action: "stop" }, button));

  return {
    refresh,
    viewingTeam: () => Boolean(selected) || !setup.hidden || !resultView.hidden,
    hasDraft: () => (["idle", "starting", "done"].includes(snapshot?.phase) && Boolean(brief.value.trim() || attachments.length || readingFiles)) || Boolean(input.value.trim()) || [...drafts.values()].some((draft) => draft.trim()),
    setSavedView(value) {
      if (saved === value) return;
      saved = value;
      if (saved) {
        viewToggle.hidden = true;
        togglePanel(false);
      } else {
        viewToggle.hidden = !supported;
        void refresh(true);
      }
      syncSetup();
    },
  };
}
