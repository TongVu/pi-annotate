export async function startChatPage(window, {
  tooltipFactory = typeof createTooltips === "function" ? createTooltips : undefined,
  loadNotes,
} = {}) {
  const { document, history, location } = window;
  const token = location.hash.slice(1);
  // Do not leave the capability in history/address bar. It remains in this page's memory only.
  history.replaceState(null, "", location.pathname + location.search);

  const showError = (message) => {
    const status = document.getElementById("status");
    status.textContent = message;
    status.classList.add("error");
  };
  if (!token) {
    showError("Open this page from Pi with /chat. Reloading the page discards its access token.");
    return;
  }

  let page;
  try {
    page = await import("./chat/page.js");
  } catch {
    // An old listener reads the new entry script from disk but only serves URLs it already knew.
    showError("Could not load the chat page. Run /reload in Pi, then reopen /chat.");
    return;
  }
  await page.mountChatPage(window, { token, tooltipFactory, loadNotes });
}

if (typeof window !== "undefined") await startChatPage(window);
