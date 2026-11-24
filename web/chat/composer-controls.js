export function mountComposerControls(window, { api, status, setTooltip, isBusy, isConnected, isViewingLive, onActionChange }) {
  const { document } = window;
  const $ = (id) => document.getElementById(id);
  const contextButton = $("chat-context");
  const contextDetails = $("chat-context-details");
  const modelToggle = $("chat-model-toggle");
  const modelPanel = $("chat-model-panel");
  const modelInput = $("chat-model");
  const modelOptions = $("chat-model-options");
  const noModelMatches = $("chat-model-no-matches");
  const modelError = $("chat-model-error");
  const effortGroup = $("chat-effort");
  const compactButton = $("chat-compact");
  const compactDialog = $("compact-chat-dialog");
  const confirmCompact = $("confirm-chat-compact");
  let compactAvailable = false;
  let compacting = false;
  let modelSettings;
  let activeModelOption;
  let modelLoading = false;
  let modelChanging = false;

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

  function highlightModel(option) {
    activeModelOption?.setAttribute("aria-selected", "false");
    activeModelOption = option;
    if (option) {
      option.setAttribute("aria-selected", "true");
      modelInput.setAttribute("aria-activedescendant", option.id);
      option.scrollIntoView?.({ block: "nearest" });
    } else modelInput.removeAttribute("aria-activedescendant");
  }

  function hideModelOptions() {
    highlightModel(undefined);
    modelOptions.hidden = noModelMatches.hidden = true;
    modelInput.setAttribute("aria-expanded", "false");
    modelInput.value = modelSettings?.model?.label ?? "";
  }

  function showModelOptions() {
    if (modelInput.disabled || modelPanel.hidden) return;
    const query = modelInput.value === modelSettings.model?.label ? "" : modelInput.value.trim().toLowerCase();
    const matches = modelSettings.models.filter(({ key, label }) =>
      label.toLowerCase().includes(query) || key.toLowerCase().includes(query));
    highlightModel(undefined);
    modelOptions.replaceChildren(...matches.map(({ key, label }, index) => {
      const option = document.createElement("li");
      option.id = `chat-model-option-${index}`;
      option.dataset.key = key;
      option.setAttribute("role", "option");
      option.setAttribute("aria-selected", "false");
      option.textContent = label;
      return option;
    }));
    modelOptions.hidden = !matches.length;
    noModelMatches.hidden = !!matches.length;
    modelInput.setAttribute("aria-expanded", String(!!matches.length));
  }

  function showModelPanel(open) {
    if (!open) hideModelOptions();
    modelPanel.hidden = !open;
    modelToggle.setAttribute("aria-expanded", String(open));
  }

  function updateModelControls() {
    const connected = isConnected();
    const unavailable = !connected || isBusy() || compacting || modelLoading;
    const locked = unavailable || modelChanging;
    modelInput.disabled = locked || !modelSettings?.models.length;
    if (modelInput.disabled) hideModelOptions();
    for (const button of effortGroup.children) {
      button.disabled = unavailable || effortGroup.childElementCount < 2;
      // Keep keyboard focus on the selected control while the change is in flight.
      button.setAttribute("aria-disabled", String(button.disabled || modelChanging));
    }
    const message = modelLoading ? "Loading Pi’s settings…" : modelChanging ? "Changing settings…"
      : !connected ? "Disconnected from Pi." : locked ? "Wait for Pi to finish before changing settings." : "";
    const hint = $("chat-model-status");
    if (hint.textContent !== message) hint.textContent = message;
  }

  function renderModelSettings() {
    hideModelOptions();
    const { effort, efforts = [] } = modelSettings ?? {};
    if (effortGroup.childElementCount !== efforts.length ||
        efforts.some((level, i) => level !== effortGroup.children[i].value)) {
      effortGroup.replaceChildren(...efforts.map((level) => {
        const button = document.createElement("button");
        button.type = "button";
        button.value = level;
        button.textContent = level === "xhigh" ? "Extra high" : level[0].toUpperCase() + level.slice(1);
        return button;
      }));
    }
    effortGroup.hidden = !efforts.length;
    for (const button of effortGroup.children) {
      button.setAttribute("aria-pressed", String(button.value === effort));
    }
  }

  modelToggle.addEventListener("click", async () => {
    if (!modelPanel.hidden) return showModelPanel(false);
    showContextDetails(false);
    showModelPanel(true);
    if (modelLoading || modelChanging) return;
    modelLoading = true;
    modelError.textContent = "";
    updateModelControls();
    try {
      modelSettings = await api("/api/session/model");
      renderModelSettings();
    } catch (error) {
      modelSettings = undefined;
      renderModelSettings();
      modelError.textContent = error.message;
    } finally {
      modelLoading = false;
      updateModelControls();
    }
  });
  async function changeModelSettings(change) {
    modelChanging = true;
    modelError.textContent = "";
    onActionChange();
    try {
      modelSettings = await api("/api/session/model", change);
    } catch (error) {
      modelError.textContent = error.message;
    } finally {
      modelChanging = false;
      renderModelSettings();
      onActionChange();
    }
  }

  function chooseModel(option) {
    if (!option || modelInput.disabled || modelOptions.hidden) return;
    const key = option.dataset.key;
    hideModelOptions();
    if (key !== modelSettings.model?.key) void changeModelSettings({ model: key });
  }

  modelInput.addEventListener("focus", () => modelInput.select());
  modelInput.addEventListener("input", showModelOptions);
  modelInput.addEventListener("click", () => {
    if (!modelOptions.hidden || !noModelMatches.hidden) return;
    modelInput.select();
    showModelOptions();
  });
  modelInput.addEventListener("blur", hideModelOptions);
  // Keep focus in the combobox when clicking a result.
  modelOptions.addEventListener("mousedown", (event) => event.preventDefault());
  modelOptions.addEventListener("click", (event) => chooseModel(event.target.closest('[role="option"]')));
  modelInput.addEventListener("keydown", (event) => {
    if (event.isComposing || modelInput.disabled) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (modelOptions.hidden) showModelOptions();
      if (modelOptions.hidden) return;
      const down = event.key === "ArrowDown";
      const option = activeModelOption ? (down ? activeModelOption.nextElementSibling : activeModelOption.previousElementSibling) ?? activeModelOption
        : down ? modelOptions.firstElementChild : modelOptions.lastElementChild;
      highlightModel(option);
    } else if (event.key === "Enter") {
      // This input is inside the chat form; Enter must never send the draft.
      event.preventDefault();
      chooseModel(activeModelOption ?? (modelOptions.childElementCount === 1 ? modelOptions.firstElementChild : null));
    } else if (event.key === "Escape" && (!modelOptions.hidden || !noModelMatches.hidden)) {
      event.preventDefault();
      hideModelOptions();
      modelInput.select();
    }
  });
  effortGroup.addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button || button.disabled || modelChanging || button.value === modelSettings?.effort) return;
    void changeModelSettings({ effort: button.value });
  });

  contextButton.addEventListener("click", () => {
    showModelPanel(false);
    showContextDetails(contextDetails.hidden);
  });
  document.addEventListener("pointerdown", (event) => {
    if (!contextDetails.hidden && !contextDetails.contains(event.target) && !contextButton.contains(event.target)) showContextDetails(false);
    if (!modelPanel.hidden && !modelPanel.contains(event.target) && !modelToggle.contains(event.target)) showModelPanel(false);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
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
    onActionChange();
    try {
      await api("/api/session/compact", {});
      status("Chat compacted.");
    } catch (error) {
      status(error.message || "Could not compact this chat.", true);
    } finally {
      compacting = false;
      onActionChange();
    }
  });

  return {
    get changing() { return compacting || modelChanging; },
    get compacting() { return compacting; },
    updateContext(usage, canCompact = compactAvailable) {
      compactAvailable = canCompact;
      updateContextUsage(usage);
    },
    updateControls() {
      compactButton.disabled = confirmCompact.disabled = !compactAvailable || !isConnected() || isBusy() || compacting || modelChanging || !isViewingLive();
      updateModelControls();
    },
  };
}
