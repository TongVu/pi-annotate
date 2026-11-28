import { teamPet } from "./team-pets.js";

const labels = { queued: "Queued", working: "Working", paused: "Needs you", done: "Done", stopped: "Stopped" };

export function mountAgentTeam(window, { api, attachmentUi, onViewChange, setTooltip = (target, text) => { target.title = text; } }) {
  const { document } = window;
  const $ = (id) => document.getElementById(id);
  const panel = $("team-panel"), viewToggle = $("team-view-toggle");
  const notes = $("chat-tools-content");
  const roles = $("team-roles"), transcript = $("team-transcript");
  const setup = $("team-setup"), start = $("team-start"), submit = $("team-submit"), pick = $("team-attach"), files = $("team-files");
  const direction = $("team-direction"), stop = $("team-stop"), cancelStart = $("team-cancel-start");
  const brief = $("team-brief"), input = $("team-input"), resume = $("team-resume");
  const attachmentList = $("team-attachments"), resultView = $("team-result");
  const feedbackButton = $("team-feedback");
  let composingFeedback = false, displayedRound = 0;
  let attachments = [], readingFiles = false, fileError = "";
  const cards = new Map(), drafts = new Map();
  let selected, saved = false, opened = false, supported = false, disconnected = false, unavailable = false;
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
  document.addEventListener("pointerdown", (event) => {
    for (const wrapper of roles.querySelectorAll(".team-agent-wrap")) {
      const popover = wrapper.querySelector(".team-agent-settings");
      if (popover && !popover.hidden && !popover.contains(event.target) && !wrapper.querySelector(".team-agent-gear").contains(event.target)) {
        popover.hidden = true;
        wrapper.querySelector(".team-agent-gear").setAttribute("aria-expanded", "false");
      }
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    const open = roles.querySelector(".team-agent-settings:not([hidden])");
    if (!open) return;
    const gear = open.parentElement.querySelector(".team-agent-gear");
    open.hidden = true;
    gear.setAttribute("aria-expanded", "false");
    gear.focus();
  });

  function card(id, name) {
    if (cards.has(id)) return cards.get(id);
    const wrapper = document.createElement("div");
    wrapper.className = id === "lead" ? "team-agent-wrap team-lead-wrap" : "team-agent-wrap";
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
    wrapper.append(button);
    if (id !== "lead") {
      const gear = document.createElement("button");
      gear.type = "button";
      gear.className = "secondary team-agent-gear";
      gear.setAttribute("aria-label", `Configure ${name} model and effort`);
      gear.setAttribute("aria-expanded", "false");
      gear.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="m19.4 15 .1.1 1.4 1.1-1.4 2.4-1.7-.6a8 8 0 0 1-1.5.9l-.3 1.8h-2.8l-.3-1.8a8 8 0 0 1-1.5-.9l-1.7.6-1.4-2.4 1.4-1.1a7 7 0 0 1 0-1.8l-1.4-1.1 1.4-2.4 1.7.6a8 8 0 0 1 1.5-.9l.3-1.8h2.8l.3 1.8a8 8 0 0 1 1.5.9l1.7-.6 1.4 2.4-1.4 1.1a7 7 0 0 1 0 1.8Z"/></svg>';
      const popover = document.createElement("div");
      popover.className = "team-agent-settings";
      popover.hidden = true;
      popover.setAttribute("aria-label", `${name} model settings`);
      const modelLabel = document.createElement("label");
      modelLabel.textContent = "Model";
      const modelInput = document.createElement("input");
      modelInput.type = "text";
      modelInput.setAttribute("role", "combobox");
      modelInput.setAttribute("aria-autocomplete", "list");
      modelInput.setAttribute("aria-expanded", "false");
      modelInput.setAttribute("aria-label", `${name} model`);
      modelInput.autocomplete = "off";
      const options = document.createElement("ul");
      options.className = "team-agent-model-options";
      options.id = `team-${id}-model-options`;
      options.setAttribute("role", "listbox");
      options.hidden = true;
      modelInput.setAttribute("aria-controls", options.id);
      modelLabel.append(modelInput);
      const effortLabel = document.createElement("span");
      effortLabel.className = "team-agent-effort-label";
      effortLabel.textContent = "Thinking effort";
      const efforts = document.createElement("div");
      efforts.className = "team-agent-efforts";
      efforts.setAttribute("role", "group");
      efforts.setAttribute("aria-label", `${name} thinking effort`);
      const status = document.createElement("p");
      status.className = "team-agent-settings-status";
      status.setAttribute("role", "status");
      const error = document.createElement("p");
      error.className = "team-agent-settings-error";
      error.setAttribute("role", "alert");
      popover.append(modelLabel, options, effortLabel, efforts, status, error);
      gear.addEventListener("click", (event) => {
        event.stopPropagation();
        const open = popover.hidden;
        document.querySelectorAll(".team-agent-settings:not([hidden])").forEach((other) => { other.hidden = true; other.parentElement.querySelector(".team-agent-gear")?.setAttribute("aria-expanded", "false"); });
        popover.hidden = !open;
        gear.setAttribute("aria-expanded", String(open));
        if (open) modelInput.focus();
      });
      modelInput.addEventListener("input", () => populateRoleOptions(id, popover));
      modelInput.addEventListener("focus", () => { modelInput.select(); populateRoleOptions(id, popover); });
      modelInput.addEventListener("keydown", (event) => {
        if (event.key === "Escape") { event.preventDefault(); popover.hidden = true; gear.setAttribute("aria-expanded", "false"); gear.focus(); }
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          const items = [...options.querySelectorAll('[role="option"]')];
          if (!items.length) return;
          const active = items.findIndex((item) => item.getAttribute("aria-selected") === "true");
          const nextIndex = active < 0 ? (event.key === "ArrowDown" ? 0 : items.length - 1)
            : (active + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
          const next = items[nextIndex];
          items.forEach((item) => item.setAttribute("aria-selected", String(item === next)));
          modelInput.setAttribute("aria-activedescendant", next.id);
        }
        if (event.key === "Enter") {
          event.preventDefault();
          (options.querySelector('[aria-selected="true"]') ?? options.querySelector('[role="option"]'))?.click();
        }
      });
      options.addEventListener("click", (event) => {
        const option = event.target.closest('[role="option"]');
        if (!option) return;
        const choice = snapshot?.modelChoices?.find(({ key }) => key === option.dataset.key);
        modelInput.value = choice?.label ?? "";
        modelInput.dataset.key = option.dataset.key;
        options.hidden = true;
        modelInput.setAttribute("aria-expanded", "false");
        const currentEffort = popover.dataset.effort;
        const effort = choice?.efforts.includes(currentEffort) ? currentEffort : choice?.efforts[0];
        void saveRoleSettings(id, popover, { model: option.dataset.key, effort });
      });
      efforts.addEventListener("click", (event) => {
        const control = event.target.closest("button");
        if (!control || control.disabled || control.getAttribute("aria-pressed") === "true") return;
        void saveRoleSettings(id, popover, { model: popover.dataset.model, effort: control.value });
      });
      wrapper.append(gear, popover);
    }
    cards.set(id, button);
    button.dataset.role = id;
    roles.append(wrapper);
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
    const showPanel = opened && !saved;
    panel.hidden = !showPanel;
    notes.hidden = showPanel;
    if (changed) onViewChange();
    if (restoreFocus) viewToggle.focus();
    const locked = pending || phase === "starting" || readingFiles;
    renderRoleSettings();
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
    syncDirection();
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

  function populateRoleOptions(roleId, popover) {
    const modelInput = popover.querySelector('[role="combobox"]');
    const list = popover.querySelector('[role="listbox"]');
    if (!snapshot?.modelChoices) return;
    const allSelected = modelInput.selectionStart === 0 && modelInput.selectionEnd === modelInput.value.length;
    const query = allSelected ? "" : modelInput.value.trim().toLowerCase();
    const choices = snapshot.modelChoices.filter(({ key, label }) => label.toLowerCase().includes(query) || key.toLowerCase().includes(query));
    list.replaceChildren(...choices.map(({ key, label }, index) => {
      const option = document.createElement("li");
      option.id = `team-${roleId}-model-option-${index}`;
      option.dataset.key = key;
      option.setAttribute("role", "option");
      option.setAttribute("aria-selected", "false");
      option.textContent = label;
      return option;
    }));
    list.hidden = !choices.length;
    modelInput.setAttribute("aria-expanded", String(!!choices.length));
  }

  function renderRoleSettings() {
    if (!snapshot?.settings || !Array.isArray(snapshot.modelChoices)) return;
    const editable = snapshot.phase === "idle" && !pending && !disconnected;
    for (const role of snapshot.roles ?? []) {
      const button = cards.get(role.id);
      if (!button) continue;
      const wrapper = button.parentElement;
      const gear = wrapper.querySelector(".team-agent-gear");
      const popover = wrapper.querySelector(".team-agent-settings");
      if (!gear || !popover) continue;
      const config = role.model ? { model: role.model, effort: role.effort } : snapshot.settings[role.id];
      const choice = snapshot.modelChoices.find(({ key }) => key === config?.model);
      const modelInput = popover.querySelector('[role="combobox"]');
      if (document.activeElement !== modelInput) modelInput.value = choice?.label ?? config?.model ?? "Unavailable model";
      modelInput.dataset.key = config?.model ?? "";
      popover.dataset.model = config?.model ?? "";
      popover.dataset.effort = config?.effort ?? "";
      const efforts = popover.querySelector(".team-agent-efforts");
      if (efforts.childElementCount !== (choice?.efforts.length ?? 0) ||
          (choice?.efforts ?? []).some((level, index) => level !== efforts.children[index]?.value)) {
        efforts.replaceChildren(...(choice?.efforts ?? []).map((effort) => {
          const control = document.createElement("button");
          control.type = "button";
          control.value = effort;
          control.textContent = effort === "xhigh" ? "Extra high" : effort[0].toUpperCase() + effort.slice(1);
          return control;
        }));
      }
      for (const control of efforts.children) {
        control.setAttribute("aria-pressed", String(control.value === config?.effort));
        control.disabled = !editable || efforts.childElementCount < 2;
      }
      gear.disabled = !editable;
      modelInput.disabled = !editable;
      gear.title = disconnected ? "Disconnected; role settings unavailable" : editable ? `Configure ${role.name}` : "Role settings lock when the team starts";
      popover.querySelector(".team-agent-settings-status").textContent = disconnected ? "Disconnected." : snapshot.phase === "idle" ? `${choice?.label ?? "Model unavailable"} · ${config?.effort ?? "No effort"} effort` : "Settings locked after team start.";
      popover.querySelector(".team-agent-settings-error").textContent = actionError;
    }
  }

  async function saveRoleSettings(roleId, popover, settings) {
    if (!settings.model || !settings.effort || pending || disconnected || snapshot?.phase !== "idle") return;
    const button = popover.parentElement.querySelector(".team-agent-gear");
    await act({ action: "settings", role: roleId, settings }, button);
  }

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
    const preStart = phase === "idle" || phase === "starting";
    roles.hidden = false;
    stop.hidden = phase !== "active";
    $("team-status").textContent = actionError || issue || (phase === "stopped" ? "Team stopped. The workspace was retained." : "");
    if (workspace && $("team-workspace").hidden) {
      $("team-workspace").hidden = false;
      $("team-paths").textContent = workspace.cwd;
    }
    const lead = card("lead", "Main chat");
    lead.hidden = preStart;
    lead.setAttribute("aria-current", String(!preStart && !selected));
    for (const role of snapshot.roles) {
      const button = card(role.id, role.name);
      button.disabled = preStart;
      button.setAttribute("aria-current", String(!preStart && role.id === selected));
      button.dataset.state = preStart ? "not-started" : role.status;
      button.querySelector(".team-card-state").textContent = preStart ? "Not started" : labels[role.status];
    }
    renderRoleSettings();
    const role = snapshot.roles.find(({ id }) => id === selected);
    if (!role) return;
    $("team-role-title").textContent = `${role.name} · ${labels[role.status]}`;
    direction.hidden = role.status !== "paused";
    const blocker = $("team-blocker-note");
    const showBlocker = !direction.hidden && role.report && !messages?.some(({ who, text }) => who === "Agent" && text === role.report);
    blocker.hidden = !showBlocker;
    blocker.textContent = showBlocker ? role.report : "";
    syncDirection();
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
    const current = () => sequence === request && version === selection && !saved;
    const query = new URLSearchParams();
    if (selected) query.set("role", selected);
    if (!force && snapshot) query.set("revision", snapshot.revision);
    try {
      const result = await api(`/api/team?${query}`);
      if (!current()) return;
      const reconnecting = disconnected;
      supported = true;
      disconnected = false;
      viewToggle.hidden = false;
      if (result.roles) snapshot = result;
      if (result.roles || reconnecting) render();
    } catch (error) {
      if (!current()) return;
      disconnected = true;
      unavailable = [401, 404, 410].includes(error.status);
      render();
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
  function syncDirection() {
    const role = snapshot?.roles.find(({ id }) => id === selected);
    input.readOnly = pending || role?.status !== "paused";
    resume.disabled = pending || role?.status !== "paused" || !input.value.trim();
  }
  input.addEventListener("input", syncDirection);
  input.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey || event.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    if (!event.repeat && !resume.disabled) direction.requestSubmit();
  });
  direction.addEventListener("submit", (event) => {
    event.preventDefault();
    const id = selected;
    const role = snapshot?.roles.find((role) => role.id === id);
    if (!role || role.status !== "paused") return;
    const text = input.value;
    if (!text.trim()) return;
    void act({ action: "resume", role: id, pause: role.pause, direction: text }, resume, () => {
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
