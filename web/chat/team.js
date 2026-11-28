import { teamPet } from "./team-pets.js";

const labels = { queued: "Queued", working: "Working", paused: "Needs you", done: "Done", stopped: "Stopped" };

export function mountAgentTeam(window, { api, attachmentUi, onViewChange, focusMain = () => {}, setTooltip = (target, text) => { target.title = text; } }) {
  const { document } = window;
  const $ = (id) => document.getElementById(id);
  const panel = $("team-panel"), viewToggle = $("team-view-toggle");
  const rosterTab = $("team-roster-tab"), contextTab = $("team-context-tab");
  const roles = $("team-roles"), transcript = $("team-transcript");
  const setup = $("team-setup"), start = $("team-start"), submit = $("team-submit"), pick = $("team-attach"), files = $("team-files");
  const direction = $("team-direction"), stop = $("team-stop"), cancelStart = $("team-cancel-start");
  const brief = $("team-brief"), input = $("team-input"), resume = $("team-resume");
  const attachmentList = $("team-attachments"), resultView = $("team-result");
  const feedbackButton = $("team-feedback"), resultButton = $("team-open-result"), applyButton = $("team-apply-result");
  let composingFeedback = false, showingResult = false, displayedRound = 0, selectedFileKey = "", applyInFlight = false;
  let attachments = [], readingFiles = false, fileError = "";
  const cards = new Map(), drafts = new Map();
  let selected, saved = false, opened = false, supported = false, disconnected = false, unavailable = false;
  let snapshot, pending = false, actionError = "", selection = 0;
  let transcriptRole, renderedMessages = [];

  function setView(id, result = false) {
    const roleChanged = id !== selected;
    if (!roleChanged && showingResult === result) return;
    showingResult = result;
    if (roleChanged) {
      if (selected) drafts.set(selected, input.value);
      selected = id;
      if (snapshot) snapshot = { ...snapshot, messages: undefined };
      input.value = drafts.get(id) ?? "";
      selection++;
      $("team-conversation").hidden = !id;
    }
    render();
    onViewChange();
    if (roleChanged && id) void refresh(true);
  }

  function backToMain() {
    setView(undefined);
    focusMain();
  }

  function selectTab(context) {
    closeSettings();
    rosterTab.setAttribute("aria-pressed", String(!context));
    contextTab.setAttribute("aria-pressed", String(context));
    $("team-roster-view").hidden = context;
    $("team-context").hidden = !context;
  }
  rosterTab.addEventListener("click", () => selectTab(false));
  contextTab.addEventListener("click", () => selectTab(true));
  const workspacePath = $("team-result-workspace"), copyWorkspace = $("team-copy-workspace"), copyStatus = $("team-workspace-copy-status");
  for (const button of [resultButton, applyButton, copyWorkspace]) setTooltip(button, button.getAttribute("aria-label"));
  copyWorkspace.addEventListener("click", async () => {
    const path = workspacePath.textContent;
    if (!path) return;
    let message;
    try {
      await window.navigator.clipboard.writeText(path);
      message = "Workspace path copied.";
    } catch {
      message = "Could not copy the workspace path. Select it to copy manually.";
    }
    if (workspacePath.textContent === path) copyStatus.textContent = message;
  });
  resultButton.addEventListener("click", () => {
    if (resultButton.hidden) return;
    setView(undefined, true);
    $("team-result-title").focus();
  });
  applyButton.addEventListener("click", () => {
    if (applyButton.hidden || applyInFlight || !snapshot?.applyToken) return;
    const dialog = $("team-apply-dialog");
    dialog.dataset.round = String(snapshot.round);
    dialog.dataset.token = snapshot.applyToken;
    $("team-apply-status").textContent = "";
    $("team-apply-confirm").disabled = false;
    dialog.showModal();
    $("team-apply-cancel").focus();
  });
  $("team-apply-cancel").addEventListener("click", () => $("team-apply-dialog").close());
  $("team-result-files").addEventListener("keydown", (event) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const options = [...$("team-result-files").querySelectorAll('[role="option"]')];
    if (!options.length) return;
    event.preventDefault();
    const current = options.indexOf(document.activeElement);
    const index = event.key === "Home" ? 0 : event.key === "End" ? options.length - 1 :
      Math.max(0, Math.min(options.length - 1, (current < 0 ? 0 : current) + (event.key === "ArrowDown" ? 1 : -1)));
    options[index].click();
  });
  $("team-apply-confirm").addEventListener("click", async () => {
    const dialog = $("team-apply-dialog"), confirm = $("team-apply-confirm");
    if (applyInFlight) return;
    const round = Number(dialog.dataset.round), applyToken = dialog.dataset.token;
    if (!snapshot || snapshot.phase !== "done" || round !== snapshot.round || applyToken !== snapshot.applyToken) {
      $("team-apply-status").textContent = "This confirmation is stale. Close it and review the current result.";
      return;
    }
    applyInFlight = true; confirm.disabled = true; applyButton.disabled = true;
    $("team-apply-status").textContent = "Applying reviewed changes…";
    try {
      await api("/api/team", { action: "apply", round, applyToken });
      $("team-apply-status").textContent = "Applied to the original checkout, unstaged.";
      await refresh(true);
      window.setTimeout(() => { if (dialog.open) dialog.close(); }, 900);
    } catch (error) {
      $("team-apply-status").textContent = `${error.message} Your review is still available; refresh and review before retrying.`;
      confirm.disabled = false;
      await refresh(true);
    } finally {
      applyInFlight = false;
      render();
    }
  });

  function togglePanel(open) {
    opened = open;
    const label = open ? "Hide Teams" : "Open Teams";
    viewToggle.setAttribute("aria-expanded", String(open));
    viewToggle.setAttribute("aria-label", label);
    setTooltip(viewToggle, label);
    if (!open) {
      if (snapshot?.phase === "done") composingFeedback = false;
      closeSettings();
      setView(undefined);
    }
    render();
    if (!setup.hidden) brief.focus();
  }
  viewToggle.addEventListener("click", () => {
    togglePanel(!opened);
    if (opened) void refresh();
  });
  let activeSettings;
  function closeSettings(restoreFocus = false) {
    if (!activeSettings) return;
    const { popover, gear } = activeSettings;
    activeSettings = undefined;
    popover.hidden = true;
    gear.setAttribute("aria-expanded", "false");
    if (restoreFocus) gear.focus({ preventScroll: true });
  }
  function positionSettings() {
    if (!activeSettings) return;
    const { popover, gear } = activeSettings;
    const anchor = gear.getBoundingClientRect(), roster = roles.getBoundingClientRect();
    const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
    const viewportHeight = document.documentElement.clientHeight || window.innerHeight;
    const gap = 8, width = popover.offsetWidth;
    let left, top, availableHeight = viewportHeight - 2 * gap;
    if (roster.left >= width + 2 * gap || viewportWidth - roster.right >= width + 2 * gap) {
      left = roster.left >= width + 2 * gap ? roster.left - width - gap : roster.right + gap;
      popover.style.maxHeight = `${availableHeight}px`;
      top = Math.min(anchor.top, viewportHeight - popover.offsetHeight - gap);
    } else {
      const bounds = panel.getBoundingClientRect();
      const rosterTop = Math.max(roster.top, bounds.top), rosterBottom = Math.min(roster.bottom, bounds.bottom);
      const above = rosterTop - 2 * gap, below = viewportHeight - rosterBottom - 2 * gap;
      availableHeight = Math.max(0, above, below);
      popover.style.maxHeight = `${availableHeight}px`;
      left = anchor.right - width;
      top = above >= below ? rosterTop - popover.offsetHeight - gap : rosterBottom + gap;
    }
    popover.style.left = `${Math.max(gap, Math.min(left, viewportWidth - width - gap))}px`;
    popover.style.top = `${Math.max(gap, top)}px`;
  }
  window.addEventListener("resize", positionSettings);
  window.addEventListener("scroll", positionSettings, true);
  document.addEventListener("pointerdown", (event) => {
    if (activeSettings && !activeSettings.popover.contains(event.target) && !event.target.closest?.(".team-agent-gear")) closeSettings();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || event.defaultPrevented || !activeSettings) return;
    event.preventDefault();
    closeSettings(true);
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
      if (id === "lead") { backToMain(); return; }
      setView(id);
      transcript.focus({ preventScroll: true });
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
      popover.id = `team-${id}-settings`;
      popover.setAttribute("role", "group");
      popover.setAttribute("aria-label", `${name} model settings`);
      gear.setAttribute("aria-controls", popover.id);
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
        const open = activeSettings?.gear !== gear;
        closeSettings();
        if (!open) return;
        activeSettings = { gear, popover };
        popover.hidden = false;
        gear.setAttribute("aria-expanded", "true");
        positionSettings();
        modelInput.focus({ preventScroll: true });
      });
      modelInput.addEventListener("input", () => populateRoleOptions(id, popover));
      modelInput.addEventListener("focus", () => { modelInput.select(); populateRoleOptions(id, popover); });
      modelInput.addEventListener("keydown", (event) => {
        if (modelInput.readOnly) return;
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
    const hasResult = ["done", "finishing", "stopped"].includes(phase) && !!snapshot.result;
    const showResult = visible && hasResult && showingResult && !show;
    const changed = setup.hidden === show || resultView.hidden === showResult;
    const restoreFocus = !setup.hidden && !show && !saved && setup.contains(document.activeElement);
    setup.hidden = !show;
    resultView.hidden = !showResult;
    panel.hidden = !visible;
    resultButton.hidden = !hasResult;
    applyButton.hidden = !(phase === "done" && snapshot.applyToken);
    applyButton.disabled = pending || applyInFlight;
    if (changed) onViewChange();
    if (restoreFocus) {
      if (visible && phase === "active") focusMain();
      else viewToggle.focus();
    }
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
      attachments.push(...await attachmentUi.readAttachments(selected, attachments));
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
  brief.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey || event.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    if (!event.repeat && !submit.disabled) start.requestSubmit(submit);
  });
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
    if (!snapshot?.modelChoices || modelInput.readOnly) return;
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
    positionSettings();
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
      if (!editable || document.activeElement !== modelInput || modelInput.dataset.key !== config?.model) modelInput.value = choice?.label ?? config?.model ?? "Unavailable model";
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
      gear.disabled = disconnected;
      modelInput.readOnly = !editable;
      if (!editable) {
        popover.querySelector('[role="listbox"]').hidden = true;
        modelInput.setAttribute("aria-expanded", "false");
      }
      const action = snapshot.phase === "idle" ? "Configure" : "View";
      gear.setAttribute("aria-label", `${action} ${role.name} model and effort`);
      gear.title = disconnected ? "Disconnected; role settings unavailable" : `${action} ${role.name}`;
      popover.querySelector(".team-agent-settings-status").textContent = disconnected ? "Disconnected." :
        `${choice?.label ?? "Model unavailable"} · ${config?.effort ?? "No effort"} effort${snapshot.phase === "idle" ? "" : " — locked after team start."}`;
      popover.querySelector(".team-agent-settings-error").textContent = activeSettings?.gear === gear && actionError || role.settingsFallback || "";
    }
    if (disconnected) closeSettings();
    positionSettings();
  }

  async function saveRoleSettings(roleId, popover, settings) {
    if (!settings.model || !settings.effort || pending || disconnected || snapshot?.phase !== "idle") return;
    const button = popover.parentElement.querySelector(".team-agent-gear");
    await act({ action: "settings", role: roleId, settings }, button);
  }

  function renderFileDiff(result) {
    const list = $("team-result-files"), pane = $("team-result-diff"), heading = $("team-diff-heading");
    // Only backend-verified character ranges may associate a file with patch text.
    const source = String(result.diff || "");
    const entries = Array.isArray(result.changedFiles) ? result.changedFiles.map((file) => {
      const start = file.start, end = file.end;
      const hasRange = Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end > start && end <= source.length;
      return { key: String(file.key), path: String(file.path), status: String(file.status || "M"), patch: hasRange ? source.slice(start, end) : "" };
    }) : [];
    const count = entries.length;
    $("team-result-file-count").textContent = count ? (result.truncated ? `${count} shown` : `${count} ${count === 1 ? "file" : "files"}`) : "";
    if (!entries.some(({ key }) => key === selectedFileKey)) selectedFileKey = entries[0]?.key || "";
    list.replaceChildren();
    list.hidden = !count;
    for (const file of entries) {
      const button = document.createElement("button");
      button.type = "button"; button.className = "team-file-button"; button.setAttribute("role", "option");
      button.setAttribute("aria-selected", String(file.key === selectedFileKey));
      const status = file.status === "?" ? "A" : file.status;
      const label = { A: "Added", M: "Modified", D: "Deleted", R: "Renamed", C: "Copied", T: "Type changed" }[status];
      if (label) button.setAttribute("aria-label", `${label}: ${file.path}`);
      const badge = document.createElement("span"), path = document.createElement("span");
      badge.className = "team-file-status";
      badge.dataset.status = status;
      badge.textContent = status;
      path.textContent = file.path;
      button.append(badge, " ", path);
      button.addEventListener("click", () => {
        selectedFileKey = file.key;
        renderFileDiff(result);
        list.querySelector('[aria-selected="true"]')?.focus({ preventScroll: true });
      });
      list.append(button);
    }
    const selected = entries.find(({ key }) => key === selectedFileKey);
    heading.textContent = selected ? selected.path : "File diff";
    pane.replaceChildren();
    if (!entries.length) {
      pane.textContent = result.files ? "Changed-file metadata is unavailable for this result; no file diff can be safely associated." : "No changes to display.";
      return;
    }
    if (!selected?.patch || /^(?:Binary files .* differ|GIT binary patch)$/m.test(selected.patch)) {
      pane.textContent = "No displayable text patch is available for this file (it may be binary or outside the preview).";
      return;
    }
    const lines = document.createElement("div");
    lines.className = "team-diff-lines";
    let oldLine = 0, newLine = 0, inHunk = false;
    for (let line of selected.patch.replace(/\n$/, "").split("\n")) {
      if (line.startsWith("@@")) {
        const match = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
        if (!match) { inHunk = false; continue; }
        oldLine = Number(match[1]); newLine = Number(match[2]); inHunk = true;
        const row = document.createElement("div"); row.className = "team-diff-hunk"; row.textContent = line; lines.append(row); continue;
      }
      if (!inHunk || /^\\ /.test(line)) continue;
      const row = document.createElement("div"), oldNo = document.createElement("span"), newNo = document.createElement("span"), mark = document.createElement("span"), text = document.createElement("span");
      row.className = "team-diff-line";
      let kind = "context";
      if (line.startsWith("+")) { kind = "add"; newNo.textContent = String(newLine++); mark.textContent = "+"; text.textContent = line.slice(1); }
      else if (line.startsWith("-")) { kind = "remove"; oldNo.textContent = String(oldLine++); mark.textContent = "−"; text.textContent = line.slice(1); }
      else { if (line.startsWith(" ")) line = line.slice(1); oldNo.textContent = String(oldLine++); newNo.textContent = String(newLine++); text.textContent = line; }
      row.classList.add(`team-diff-${kind}`); oldNo.className = "team-diff-number"; newNo.className = "team-diff-number"; mark.className = "team-diff-marker"; text.className = "team-diff-text";
      row.append(oldNo, newNo, mark, text); lines.append(row);
    }
    if (lines.childElementCount) pane.append(lines);
    else pane.textContent = "No text diff is available for this file (metadata-only change).";
  }

  function render() {
    if (!snapshot) return;
    const { phase, round, maxRounds, issue, workspace, result, messages, mainChatManaged, disposition, feedback } = snapshot;
    const requirement = snapshot.brief ?? "";
    const firstLine = requirement.split("\n").find((line) => line.trim())?.trim().replace(/^[-*#]+\s+/, "") ?? "";
    const title = firstLine.length > 88 ? `${firstLine.slice(0, 87)}…` : firstLine;
    const workingRole = snapshot.roles.find(({ status }) => status === "working");
    const progress = phase === "done" ? "Reviewed · awaiting your decision" : phase === "finishing" ? "Applying reviewed result" : phase === "stopped" ?
      (disposition === "applied" ? "Applied · team stopped" : disposition === "discarded" ? "Not applied · team stopped" : "Stopped") :
      snapshot.roles.some(({ status }) => status === "paused") ? "Paused · see Main chat" :
      workingRole ? `${workingRole.name} working` : "Preparing";
    const roundLabel = `Round ${round}${maxRounds ? ` of ${maxRounds}` : ""}`;
    $("team-task-progress").textContent = phase === "idle" ? "Not started" : `${progress} · ${roundLabel}`;
    for (const prefix of ["team-task", "team-result"]) {
      $(`${prefix}-brief`).textContent = requirement || (round ? "Requirement supplied as attachments." : "No requirement sent yet.");
      $(`${prefix}-feedback`).textContent = feedback ?? "";
      $(`${prefix}-feedback`).parentElement.hidden = !feedback;
    }
    if (mainChatManaged) {
      feedbackButton.setAttribute("aria-label", "Discuss the result in Main chat");
      setTooltip(feedbackButton, "Discuss the result in Main chat");
    }
    if (round > displayedRound) {
      displayedRound = round;
      composingFeedback = showingResult = false;
      brief.value = "";
      attachments = [];
      renderAttachments();
    }
    syncSetup();
    if (result) {
      $("team-round").textContent = `${progress} · ${roundLabel}`;
      $("team-result-title").textContent = title || "Team result";
      $("team-result-note").textContent = disposition === "applied" ? "Applied to the original checkout, unstaged." : disposition === "discarded" ? "The reviewed result was discarded; the original checkout was not changed." : phase === "stopped" ? "The team workspace was retained; nothing was applied." :
        round >= maxRounds ? "Round limit reached. Review in Main chat, then apply here or in Main chat, or discard the result." :
          "See Main chat for the review and recommendation. Apply here or in Main chat, or discard. Nothing has been applied.";
      const path = workspace?.cwd ?? "";
      if (workspacePath.textContent !== path) {
        workspacePath.textContent = path;
        copyStatus.textContent = "";
      }
      copyWorkspace.disabled = !path;
      renderFileDiff(result);
      $("team-result-truncated").hidden = !result.truncated;
      applyButton.hidden = !(phase === "done" && snapshot.applyToken);
      applyButton.disabled = pending || applyInFlight;
    }
    const waiting = snapshot.roles.filter(({ status }) => status === "paused").length;
    const attention = !waiting ? "" : mainChatManaged ? "Blocked · see Main chat" : `${waiting} ${waiting === 1 ? "role needs" : "roles need"} your input`;
    const roleLabel = (status) => status === "paused" && mainChatManaged ? "Paused" : labels[status];
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
    const lead = card("lead", "Main conversation");
    lead.disabled = preStart;
    lead.setAttribute("aria-current", String(!preStart && !selected && !showingResult));
    for (const role of snapshot.roles) {
      const button = card(role.id, role.name);
      button.disabled = preStart;
      button.setAttribute("aria-current", String(!preStart && role.id === selected));
      button.dataset.state = preStart ? "not-started" : role.status;
      button.querySelector(".team-card-state").textContent = preStart ? "Not started" : roleLabel(role.status);
    }
    renderRoleSettings();
    const role = snapshot.roles.find(({ id }) => id === selected);
    if (!role) return;
    $("team-role-title").textContent = `${role.name} · ${roleLabel(role.status)}`;
    direction.hidden = mainChatManaged || role.status !== "paused";
    const blocker = $("team-blocker-note");
    const showBlocker = role.status === "paused" && role.report && !messages?.some(({ who, text }) => who === "Agent" && text === role.report);
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

  let request = 0, refreshing = false;
  async function refresh(force = false) {
    if (unavailable || saved || (!force && (pending || refreshing))) return;
    refreshing = true;
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
    } finally {
      if (sequence === request) refreshing = false;
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
    if (snapshot?.mainChatManaged) { backToMain(); return; }
    if (snapshot?.phase !== "done" || snapshot.round >= snapshot.maxRounds) return;
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
    refreshIfChanged(revision) {
      if (revision === undefined || revision !== snapshot?.revision || disconnected) void refresh();
    },
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
