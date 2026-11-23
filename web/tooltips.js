function createTooltips({ sideTargets } = {}) {
  let tooltip;
  let activeTarget;

  function hide() {
    activeTarget?.removeAttribute("aria-describedby");
    activeTarget = undefined;
    tooltip?.remove();
    tooltip = undefined;
  }

  function set(target, text) {
    if (target.dataset.tooltip === text) return;
    target.dataset.tooltip = text;
    if (activeTarget === target) show(target);
  }

  function show(target) {
    hide();
    if (!target.dataset.tooltip) return;
    tooltip = document.createElement("div");
    tooltip.id = "message-preview";
    tooltip.className = "message-preview";
    tooltip.setAttribute("role", "tooltip");
    tooltip.textContent = target.dataset.tooltip;
    (target.closest("dialog[open]") ?? document.body).append(tooltip);
    activeTarget = target;
    target.setAttribute("aria-describedby", tooltip.id);
    const rect = target.getBoundingClientRect();
    const { width, height } = tooltip.getBoundingClientRect();
    const gap = 8;
    const right = rect.right + gap;
    const below = rect.bottom + gap;
    const side = sideTargets && target.closest(sideTargets);
    const left = side ? (right + width <= window.innerWidth - gap ? right : rect.left - width - gap) : (rect.left + rect.right - width) / 2;
    const top = side ? (rect.top + rect.bottom - height) / 2 : (below + height <= window.innerHeight - gap ? below : rect.top - height - gap);
    tooltip.style.left = `${Math.max(gap, Math.min(left, window.innerWidth - width - gap))}px`;
    tooltip.style.top = `${Math.max(gap, Math.min(top, window.innerHeight - height - gap))}px`;
  }

  for (const target of document.querySelectorAll("[title]")) {
    set(target, target.getAttribute("title"));
    target.removeAttribute("title");
  }
  // Capture non-bubbling events so dynamically rendered controls share the same tooltip.
  for (const type of ["mouseenter", "focus"]) document.addEventListener(type, (event) => {
    if (event.target.dataset?.tooltip) show(event.target);
  }, true);
  for (const type of ["mouseleave", "blur"]) document.addEventListener(type, (event) => {
    if (event.target === activeTarget) hide();
  }, true);
  document.addEventListener("click", hide, true);
  document.addEventListener("scroll", hide, { capture: true, passive: true });
  document.addEventListener("keydown", (event) => { if (event.key === "Escape") hide(); });
  window.addEventListener("resize", hide);
  return { set, hide };
}
