export function mountTranscript(window, { fetchImage, isViewingLive, isCommentOpen, showImagePreview, onBranchReply, setTooltip, status }) {
  const { document, IntersectionObserver, URL, URLSearchParams } = window;
  const response = document.getElementById("response");
  const rail = document.getElementById("chat-rail");
  const turnRail = document.getElementById("turns");
  const turnList = document.getElementById("turn-list");
  const turns = [];
  let currentTurn;
  let liveScroll;

  function reveal(container, button) {
    const bounds = container.getBoundingClientRect();
    const position = button.getBoundingClientRect();
    if (position.top < bounds.top) container.scrollTop += position.top - bounds.top;
    else if (position.bottom > bounds.bottom) container.scrollTop += position.bottom - bounds.bottom;
  }

  function markCurrentTurn(entry) {
    if (currentTurn === entry) return;
    currentTurn?.dot.removeAttribute("aria-current");
    currentTurn?.row.removeAttribute("aria-current");
    currentTurn = entry;
    entry.dot.setAttribute("aria-current", "location");
    entry.row.setAttribute("aria-current", "location");
    reveal(turnRail, entry.dot);
    if (!turnList.hidden) reveal(turnList, entry.row);
  }

  function openTurnList() {
    if (!turnList.hidden || !turns.length) return;
    turnList.hidden = false;
    if (currentTurn) reveal(turnList, currentTurn.row);
  }

  function closeTurnList() { turnList.hidden = true; }

  turnRail.addEventListener("mouseenter", openTurnList);
  turnRail.addEventListener("focusin", openTurnList);
  rail.addEventListener("mouseleave", () => {
    if (!turnList.contains(document.activeElement)) closeTurnList();
  });
  rail.addEventListener("focusout", (event) => {
    if (!rail.contains(event.relatedTarget) && !rail.matches(":hover")) closeTurnList();
  });
  document.addEventListener("pointerdown", (event) => {
    if (!rail.contains(event.target)) closeTurnList();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || turnList.hidden) return;
    if (turnList.contains(event.target)) (currentTurn ?? turns[0]).dot.focus({ preventScroll: true });
    closeTurnList();
    if (rail.contains(event.target)) event.preventDefault();
  });

  function updateCurrentTurn() {
    if (!turns.length) return;
    const atEnd = response.scrollHeight - response.scrollTop - response.clientHeight <= 2;
    const readingLine = response.getBoundingClientRect().top + 24;
    const current = atEnd ? turns.at(-1) : turns.findLast(({ turn }) => turn.getBoundingClientRect().top <= readingLine) ?? turns[0];
    markCurrentTurn(current);
  }

  const imageLoaders = new WeakMap();
  function observeImages(root) {
    return typeof IntersectionObserver === "function" ? new IntersectionObserver((entries, observer) => {
      for (const { target, isIntersecting } of entries) {
        if (!isIntersecting) continue;
        observer.unobserve(target);
        if (target.isConnected) void imageLoaders.get(target)().catch(() => {}); // The preview button can retry.
      }
    }, { root, rootMargin: "120px" }) : null;
  }
  const transcriptImageObserver = observeImages(response);
  const savedResponse = document.getElementById("saved-response");
  const savedImageObserver = observeImages(savedResponse);

  function appendTranscriptImages(turn, { id, imageCount }, session) {
    if (!imageCount) return;
    const images = document.createElement("div");
    images.className = "transcript-images";
    for (let index = 0; index < imageCount; index++) {
      const name = `Image ${index + 1}`; // Pi's stored image blocks have no filename.
      const open = document.createElement("button");
      open.type = "button";
      open.className = "secondary attachment-preview";
      open.setAttribute("aria-label", `Preview ${name}`);
      const thumbnail = document.createElement("img");
      thumbnail.alt = "";
      open.append(thumbnail, name);
      const query = new URLSearchParams({ id, index });
      if (session) query.set("session", session);
      const observer = session ? savedImageObserver : transcriptImageObserver;
      let pendingImage;
      const load = () => pendingImage ??= (async () => {
        const result = await fetchImage(query);
        if (!result.ok) throw new Error("Could not load this image from Pi.");
        const blob = await result.blob();
        if (!open.isConnected) throw new Error("Image is no longer in view.");
        const src = URL.createObjectURL(blob);
        thumbnail.src = src;
        return src;
      })().catch((error) => { pendingImage = undefined; throw error; });
      imageLoaders.set(open, load);
      open.addEventListener("click", async () => {
        try {
          const src = await load();
          if (open.isConnected && (session || isViewingLive())) showImagePreview(name, src);
        } catch { if (open.isConnected) status("Could not load this image from Pi.", true); }
      });
      images.append(open);
      if (observer) observer.observe(open);
      else void load().catch(() => {});
    }
    turn.append(images);
  }

  function renderTurn(message, session) {
    const turn = document.createElement("section");
    const assistant = message.role === "assistant";
    const teamReport = message.role === "team-report";
    turn.className = `chat-turn ${teamReport ? "team-report-turn" : assistant ? "assistant-turn" : "user-turn"}`;
    turn.dataset.entryId = message.id;
    const content = document.createElement("div");
    if (assistant || teamReport) {
      const label = document.createElement("h2");
      label.textContent = teamReport ? "Software architect · Team report" : "Pi";
      turn.append(label);
    } else {
      turn.setAttribute("aria-label", "Your message");
    }
    // The server renders restricted Markdown for both roles. Only live Pi replies
    // with matching DOM text can provide annotation offsets.
    if (typeof message.html === "string") content.innerHTML = message.html;
    if (typeof message.html === "string" && content.textContent === message.text) {
      if (assistant && !session) content.dataset.responseId = message.id;
    } else if (assistant) {
      content.textContent = "This reply could not be rendered safely. See Pi in the terminal.";
    } else {
      content.className = "plain-message";
      content.textContent = message.text;
    }
    if (message.text || message.html || assistant) turn.append(content);
    if (message.role === "user") appendTranscriptImages(turn, message, session);
    if (assistant && !session && message.canBranch) {
      const branch = document.createElement("button");
      branch.type = "button";
      branch.className = "reply-branch";
      branch.setAttribute("aria-label", "Branch from here");
      branch.setAttribute("aria-haspopup", "dialog");
      branch.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">
        <circle cx="6" cy="5" r="2.5"/><circle cx="6" cy="19" r="2.5"/><circle cx="18" cy="5" r="2.5"/>
        <path d="M6 7.5v9m12-9a7 7 0 0 1-7 7H6"/>
      </svg>`;
      setTooltip(branch, "Branch from here");
      branch.addEventListener("click", () => onBranchReply(message.id));
      turn.append(branch);
    }
    return turn;
  }

  const nearChatEnd = () => response.scrollHeight - response.scrollTop - response.clientHeight < 80;
  function clearSaved() {
    savedImageObserver?.disconnect();
    for (const image of savedResponse.querySelectorAll("img[src^='blob:']")) URL.revokeObjectURL(image.src);
    savedResponse.replaceChildren();
  }

  function appendLive(messages, { initial = false, branchReplyId } = {}) {
    const follow = initial || nearChatEnd();
    const fragment = document.createDocumentFragment();
    const dots = document.createDocumentFragment();
    const rows = document.createDocumentFragment();
    for (const message of messages) {
      const turn = renderTurn(message);
      if (message.role === "user") {
        const preview = message.text.trim().replace(/\s+/g, " ") || (message.imageCount ? "Image attachment" : "Your message");
        const dot = document.createElement("button");
        dot.type = "button";
        dot.setAttribute("aria-label", `Jump to your message: ${preview}`);
        const row = document.createElement("button");
        row.type = "button";
        const excerpt = document.createElement("span");
        excerpt.textContent = preview;
        row.append(excerpt);
        const entry = { turn, dot, row };
        function jumpToTurn() {
          response.scrollTop += turn.getBoundingClientRect().top - response.getBoundingClientRect().top;
          markCurrentTurn(entry);
        }
        dot.addEventListener("click", () => {
          jumpToTurn();
          openTurnList();
        });
        dot.addEventListener("keydown", (event) => {
          if (event.key !== "ArrowRight") return;
          event.preventDefault();
          openTurnList();
          row.focus();
        });
        row.addEventListener("click", () => {
          jumpToTurn();
          response.focus({ preventScroll: true });
          closeTurnList();
        });
        turns.push(entry);
        dots.append(dot);
        rows.append(row);
      }
      fragment.append(turn);
      if (message.id === branchReplyId) {
        const divider = document.createElement("p");
        divider.className = "subchat-divider";
        divider.textContent = "Subchat starts here";
        fragment.append(divider);
      }
    }
    response.append(fragment);
    turnRail.append(dots);
    turnList.append(rows);
    if (messages.length && isViewingLive()) {
      if (follow && !isCommentOpen() && window.getSelection()?.isCollapsed !== false) {
        response.scrollTop = response.scrollHeight;
      }
      updateCurrentTurn();
    }
  }

  response.addEventListener("scroll", updateCurrentTurn, { passive: true });
  window.addEventListener("resize", updateCurrentTurn);

  return {
    appendLive,
    clearSaved,
    focusSaved: () => savedResponse.focus({ preventScroll: true }),
    renderSaved(messages, id, replyId) {
      const fragment = document.createDocumentFragment();
      let target;
      for (const message of messages) {
        const turn = renderTurn(message, id);
        if (message.id === replyId) target = turn;
        fragment.append(turn);
      }
      savedResponse.append(fragment);
      if (target) {
        savedResponse.scrollTop = target.getBoundingClientRect().top - savedResponse.getBoundingClientRect().top;
        target.tabIndex = -1;
        target.focus({ preventScroll: true });
      } else savedResponse.scrollTop = savedResponse.scrollHeight;
      return Boolean(target);
    },
    rememberLiveScroll() {
      closeTurnList();
      liveScroll = { follow: nearChatEnd(), top: response.scrollTop };
    },
    restoreLiveScroll() {
      if (liveScroll) {
        response.scrollTop = liveScroll.follow ? response.scrollHeight : liveScroll.top;
        liveScroll = undefined;
      }
      updateCurrentTurn();
    },
  };
}
