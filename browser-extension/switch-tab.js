const dashboard = /^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}\/\?dashboard=[a-f0-9]{32}(?:#[a-f0-9]{64})?$/;
const chat = /^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}\/\?tab=[a-f0-9]{32}$/;

chrome.runtime.onMessageExternal.addListener((message, sender, respond) => {
  if (sender.frameId !== 0 || !dashboard.test(sender.url ?? "") || typeof message?.focusTab !== "string" || !chat.test(message.focusTab)) return;
  async function focus() {
    const tabs = await chrome.tabs.query({ url: "http://127.0.0.1/*" });
    const tab = tabs.find(({ url, pendingUrl }) => url === message.focusTab && !pendingUrl);
    if (!tab) return "missing";
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
    return "focused";
  }
  void focus().then(respond, () => respond("failed"));
  return true;
});
