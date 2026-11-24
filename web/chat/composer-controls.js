export function mountComposerControls(window, { api, status, setTooltip, isBusy, isConnected, isViewingLive, onActionChange }) {
  const { document, Option } = window;
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
  let compactAvailable = false;
  let compacting = false;
  let modelSettings;
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

  function showModelPanel(open) {
    modelPanel.hidden = !open;
    modelToggle.setAttribute("aria-expanded", String(open));
  }

  function updateModelControls() {
    const connected = isConnected();
    const locked = !connected || isBusy() || compacting || modelChanging || modelLoading;
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
      onActionChange();
      try {
        modelSettings = await api("/api/session/model", { [key]: field.value });
      } catch (error) {
        $("chat-model-error").textContent = error.message;
      } finally {
        modelChanging = false;
        renderModelSettings();
        onActionChange();
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
