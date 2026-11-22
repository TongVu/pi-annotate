import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
import { renderMarkdown } from "../src/markdown.ts";
import { validateAnnotations } from "../src/annotations.ts";

async function fixture(t, { failFirst = false, markdown = "A reactor module.\n<script>alert('bad')</script>", corruptText = false, legacyServer = false, chatFetch, storedNotes = {} } = {}) {
  const html = await readFile(new URL("../web/index.html", import.meta.url), "utf8");
  const source = await readFile(new URL("../web/app.js", import.meta.url), "utf8");
  const dom = new JSDOM(html, { url: "http://127.0.0.1:12345/#test-token", runScripts: "outside-only" });
  t.after(() => dom.window.close());
  const { window } = dom;
  for (const [sessionId, note] of Object.entries(storedNotes)) window.localStorage.setItem(`pi-annotate:markdown-note:v1:${sessionId}`, note);
  const $ = (id) => window.document.getElementById(id);
  const posts = [];
  const rendered = renderMarkdown(markdown);
  window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  window.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new window.Event("close")); };
  const polls = [];
  if (chatFetch) window.setTimeout = (fn) => polls.push(fn);
  window.fetch = async (path, opts) => {
    assert.equal(opts.headers.Authorization, "Bearer test-token");
    if (chatFetch) return chatFetch(path, opts.body && JSON.parse(opts.body), opts);
    if (path === "/api/response") return { ok: true, json: async () => ({ response: legacyServer ? { id: "test", text: markdown } : { id: "test", ...rendered, ...(corruptText ? { text: "mismatch" } : {}) }, submitted: false }) };
    const body = JSON.parse(opts.body);
    validateAnnotations(body.annotations, rendered.text);
    posts.push(body);
    return { ok: !(failFirst && posts.length === 1), json: async () => failFirst && posts.length === 1 ? { error: "Pi is busy" } : { ok: true } };
  };
  await window.eval(`(async () => { ${source}\n})()`);
  const select = (start, end, target = $("response")) => {
    const range = window.document.createRange();
    const locate = (offset) => {
      const nodes = window.document.createTreeWalker(target, window.NodeFilter.SHOW_TEXT);
      let node;
      while ((node = nodes.nextNode())) {
        if (offset <= node.length) return [node, offset];
        offset -= node.length;
      }
      throw new Error("Selection offset is outside the rendered response");
    };
    range.setStart(...locate(start));
    range.setEnd(...locate(end));
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(range);
    $("response").dispatchEvent(new window.MouseEvent("mouseup"));
  };
  const add = (question) => {
    $("comment").value = question;
    $("comment-form").dispatchEvent(new window.Event("submit", { cancelable: true }));
  };
  return { window, $, posts, select, add, rendered, poll: () => polls.shift()() };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("native selection opens comment dialog; content is text, not executable HTML", async (t) => {
  const f = await fixture(t);
  assert.equal(f.window.location.hash, "");
  assert.equal(f.$("response").querySelector("script"), null);
  f.select(2, 9);
  assert.equal(f.$("comment-dialog").open, true);
  assert.equal(f.$("selected-quote").textContent, "reactor");
  assert.equal(f.$("comment-close").getAttribute("aria-label"), "Close annotation");
  assert.equal(f.$("save-annotation").getAttribute("aria-label"), "Add annotation");
  assert.equal(f.$("save-annotation").textContent.trim(), "");
  assert.equal(f.$("save-annotation").closest(".comment-composer"), f.$("comment").parentElement);
  assert.equal(f.$("comment-close").title, "Close annotation");
  assert.equal(f.$("comment-expand"), null);
  const css = await readFile(new URL("../web/style.css", import.meta.url), "utf8");
  assert.match(css, /#comment-dialog \{[^}]*height: min\(85dvh, 900px\)/);
  assert.match(css, /\.comment-composer \{[^}]*flex: 1 1 auto/);
  assert.match(css, /#comment \{[^}]*flex: 1 1 auto/);
  f.add("What does this mean?");
  assert.equal(f.$("annotations").children.length, 1);
  assert.equal(f.$("send").disabled, false);
  f.$("send").click();
  await tick();
  assert.deepEqual(f.posts[0].annotations, [{ start: 2, end: 9, quote: "reactor", comment: "What does this mean?" }]);
  assert.equal(f.$("send").disabled, true);
  assert.match(f.$("status").textContent, /not sent/);
});

test("multiple annotations support edit, remove, cancel and retry after failure", async (t) => {
  const f = await fixture(t, { failFirst: true });
  f.select(2, 9);
  f.$("comment-close").click();
  assert.equal(f.$("annotations").children.length, 0);
  f.select(2, 9);
  f.add("First question");
  f.select(10, 16);
  f.add("Second question");
  const actions = f.$("annotations").firstElementChild.querySelectorAll("button");
  assert.deepEqual([...actions].map((button) => button.getAttribute("aria-label")), ["Edit annotation", "Remove annotation"]);
  assert.ok([...actions].every((button) => button.textContent.trim() === "" && button.querySelector('svg[aria-hidden="true"]')));
  f.$("annotations").querySelector('[aria-label="Edit annotation"]').click();
  assert.equal(f.$("comment").value, "First question");
  f.add("Edited question");
  f.$("annotations").lastElementChild.querySelector('[aria-label="Remove annotation"]').click();
  assert.equal(f.$("annotations").children.length, 1);
  f.$("send").click();
  await tick();
  assert.match(f.$("status").textContent, /Pi is busy/);
  assert.equal(f.$("send").disabled, false);
  f.$("send").click();
  await tick();
  assert.equal(f.posts.length, 2);
  assert.equal(f.posts[1].annotations[0].comment, "Edited question");
  assert.equal(f.$("send").disabled, true);
});

for (const [name, markdown, quote] of [
  ["nested bold and link text", "Some **bold** and [docs](https://example.com) here.", "bold and docs"],
  ["paragraph boundaries", "First **paragraph**.\n\nSecond paragraph.", "paragraph.\nSecond"],
  ["list items", "- first **item**\n- second item", "first item\nsecond item"],
  ["fenced code", "```js\nconst x = '<tag>';\nconst y = 2;\n```", "const x = '<tag>';\nconst y = 2;"],
  ["entities and emoji", "Fish &amp; **chips 🦊** &copy;", "& chips 🦊 ©"],
  ["hard breaks", "first  \nsecond", "first\nsecond"],
]) {
  test(`rendered selection round-trips through quote validation: ${name}`, async (t) => {
    const f = await fixture(t, { markdown });
    const start = f.rendered.text.indexOf(quote);
    assert.notEqual(start, -1);
    f.select(start, start + quote.length);
    assert.equal(f.$("selected-quote").textContent, quote);
    f.add("Explain this passage.");
    f.$("send").click();
    await tick();
    assert.deepEqual(f.posts[0].annotations, [{ start, end: start + quote.length, quote, comment: "Explain this passage." }]);
    assert.match(f.$("status").textContent, /not sent/);
  });
}

test("chat dots jump to user turns; failed questions are kept, accepted questions clear, and new replies are annotatable", async (t) => {
  const user = { id: "u1", role: "user", text: "A question <b>posted as text</b>" };
  const assistant = (id, text) => ({ id, role: "assistant", ...renderMarkdown(text) });
  const chatResponse = (cursor, messages, busy = false) => ({ mode: "chat", protocol: 2, cursor, messages, busy });
  const json = (data, status = 200) => ({ ok: status === 200, status, json: async () => data });
  const posts = [];
  const accept = Promise.withResolvers();
  const f = await fixture(t, { chatFetch: async (path, body) => {
    if (path === "/api/response") return json(chatResponse("a1", [user, assistant("a1", "**Old** reply")]));
    if (path === "/api/response?after=a1") return json(chatResponse("a2", [{ id: "u2", role: "user", text: "Why old?" }, assistant("a2", "**New** reply")]));
    assert.equal(path, "/api/chat");
    posts.push(body);
    if (posts.length === 1) return json({ error: "Pi is busy" }, 409);
    if (posts.length === 2) await accept.promise;
    return json({ ok: true });
  } });
  assert.equal(f.$("turns").children.length, 1);
  assert.equal(f.$("send").parentElement.id, "annotation-heading");
  assert.equal(f.$("send").title, "Send questions");
  assert.equal(f.$("send").getAttribute("aria-label"), "Send 0 questions");
  assert.equal(f.$("send").textContent, "0");
  assert.equal(f.$("send").classList.contains("chat-question-send"), true);
  assert.ok(f.$("send").querySelector("svg"));
  const currentDot = () => f.$("turns").querySelector('[aria-current="location"]');
  assert.equal(currentDot(), f.$("turns").firstElementChild);
  const firstUser = f.$("response").querySelector(".user-turn");
  assert.equal(firstUser.textContent, user.text);
  assert.equal(firstUser.getAttribute("aria-label"), "Your message");
  assert.equal(firstUser.querySelector("b"), null);
  firstUser.getBoundingClientRect = () => ({ top: 300 });
  f.$("response").getBoundingClientRect = () => ({ top: 50 });
  f.$("response").scrollTop = 20;
  f.$("turns").scrollTop = 10;
  f.$("turns").firstElementChild.click();
  assert.equal(f.$("response").scrollTop, 270);
  assert.equal(f.$("turns").scrollTop, 10);
  const dot = f.$("turns").firstElementChild;
  assert.equal(dot.title, "", "avoid the delayed native browser tooltip");
  dot.dispatchEvent(new f.window.MouseEvent("mouseenter"));
  const tooltip = f.window.document.getElementById("message-preview");
  assert.equal(tooltip.getAttribute("role"), "tooltip");
  assert.equal(tooltip.textContent, "A question <b>posted as text</b>");
  assert.equal(dot.getAttribute("aria-describedby"), "message-preview");
  dot.dispatchEvent(new f.window.MouseEvent("mouseleave"));
  assert.equal(f.window.document.getElementById("message-preview"), null);
  const oldReply = f.$("response").querySelector('[data-response-id="a1"]');
  f.select(0, 3, oldReply);
  f.add("Why old?");
  f.$("send").click();
  await tick();
  assert.match(f.$("status").textContent, /Pi is busy/);
  assert.equal(f.$("annotations").children.length, 1);
  f.$("send").click();
  assert.equal(f.$("annotations").children.length, 1);
  accept.resolve();
  await tick();
  assert.deepEqual(posts[0], posts[1]);
  assert.deepEqual(posts[1].annotations, [{ responseId: "a1", start: 0, end: 3, quote: "Old", comment: "Why old?" }]);
  assert.equal(f.$("annotations").children.length, 0);
  assert.equal(f.$("count").textContent, "0");
  await f.poll();
  assert.equal(f.$("turns").children.length, 2);
  assert.equal(currentDot(), f.$("turns").lastElementChild);
  const transcript = f.$("response");
  Object.defineProperties(transcript, { scrollHeight: { value: 1000 }, clientHeight: { value: 400 } });
  firstUser.getBoundingClientRect = () => ({ top: 62 - transcript.scrollTop });
  transcript.querySelectorAll(".user-turn")[1].getBoundingClientRect = () => ({ top: 500 - transcript.scrollTop });
  for (const [scrollTop, dot] of [[120, f.$("turns").firstElementChild], [450, f.$("turns").lastElementChild]]) {
    transcript.scrollTop = scrollTop;
    transcript.dispatchEvent(new f.window.Event("scroll"));
    assert.equal(currentDot(), dot);
    assert.equal(f.$("turns").querySelectorAll("[aria-current]").length, 1);
  }
  assert.equal(transcript.querySelector('[data-response-id="a1"]'), oldReply);
  const newReply = f.$("response").querySelector('[data-response-id="a2"]');
  f.select(0, 3, newReply);
  assert.equal(f.$("selected-quote").textContent, "New");
  f.add("Why new?");
  f.$("send").click();
  await tick();
  assert.notEqual(posts[2].requestId, posts[1].requestId);
  assert.equal(posts[2].annotations[0].responseId, "a2");
});

test("sent images fetch a separate thumbnail and open a larger preview", async (t) => {
  const calls = [];
  const thumbnail = Promise.withResolvers();
  const f = await fixture(t, { chatFetch: async (path) => {
    calls.push(path);
    if (path === "/api/response") return { ok: true, json: async () => ({
      mode: "chat", protocol: 2, cursor: "u1", busy: false,
      messages: [{ id: "u1", role: "user", text: "Look at this", imageCount: 1 }],
    }) };
    assert.equal(path, "/api/image?id=u1&index=0");
    return { ok: true, blob: () => thumbnail.promise };
  } });
  f.window.URL.createObjectURL = () => "blob:mock-image";
  const button = f.$("response").querySelector('[aria-label="Preview Image 1"]');
  button.click();
  thumbnail.resolve(new f.window.Blob());
  await tick();
  assert.deepEqual(calls, ["/api/response", "/api/image?id=u1&index=0"]);
  assert.equal(button.querySelector("img").src, "blob:mock-image");
  assert.equal(f.$("image-preview").open, true);
  assert.equal(f.$("preview-image").src, "blob:mock-image");
});

test("status icon distinguishes ready, working, stopped and disconnected", async (t) => {
  let busy = false;
  let failed = false;
  let offline = false;
  const f = await fixture(t, { chatFetch: async () => {
    if (offline) throw new Error("Offline");
    return { ok: true, json: async () => ({ mode: "chat", protocol: 2, cursor: null, messages: [], busy, failed }) };
  } });
  const indicator = f.$("chat-state");
  assert.equal(indicator.dataset.state, "ready");
  assert.match(indicator.textContent, /ready for the next task/);
  busy = true;
  await f.poll();
  assert.equal(indicator.dataset.state, "working");
  assert.match(indicator.textContent, /working/);
  busy = false;
  failed = true;
  await f.poll();
  assert.equal(indicator.dataset.state, "stopped");
  offline = true;
  await f.poll();
  assert.equal(indicator.dataset.state, "disconnected");
});

test("chat tab follows the Pi session name and moves chat controls out of the header", async (t) => {
  let sessionName = "Live browser chat feature";
  const f = await fixture(t, { chatFetch: async () => ({
    ok: true, json: async () => ({ mode: "chat", protocol: 2, cursor: null, messages: [], busy: false, sessionName }),
  }) });
  assert.equal(f.window.document.title, sessionName);
  assert.equal(f.$("page-intro").hidden, true);
  assert.equal(f.$("chat-state").hidden, false);
  assert.equal(f.$("chat-state").parentElement, f.$("chat-form").querySelector(".actions"));
  assert.equal(f.$("chat-state").nextElementSibling, f.$("status"));
  assert.equal(f.$("explorer-toggle").parentElement, f.$("chat-rail"));
  assert.equal(f.$("turns").parentElement, f.$("chat-rail"));
  assert.equal(f.$("status").textContent, "");

  sessionName = "Renamed <em>chat</em>";
  await f.poll();
  assert.equal(f.window.document.title, sessionName);

  sessionName = undefined;
  await f.poll();
  assert.equal(f.window.document.title, "Chat · Pi");
});

test("the sticky session pill renames the Pi session and updates the browser tab", async (t) => {
  let sessionName = "Live browser chat feature";
  let renamed;
  let oldServer = true;
  const f = await fixture(t, { chatFetch: async (path, body) => {
    if (path === "/api/session/name") {
      if (oldServer) {
        oldServer = false;
        return { ok: false, status: 404, json: async () => ({ error: "Not found." }) };
      }
      renamed = body.name;
      sessionName = renamed;
      return { ok: true, json: async () => ({ sessionName }) };
    }
    return { ok: true, json: async () => ({ mode: "chat", protocol: 2, sessionName, cursor: null, messages: [], busy: false }) };
  } });
  const pill = f.$("session-title-pill");
  assert.equal(pill.hidden, false);
  assert.equal(f.$("session-title-text").textContent, sessionName);
  assert.equal(f.window.document.title, sessionName);
  f.$("rename-session").click();
  const input = f.$("rename-session-input");
  input.value = "Personal repository cleanup";
  const submitRename = () => f.$("rename-session-form").dispatchEvent(new f.window.Event("submit", { cancelable: true }));
  submitRename();
  await tick();
  assert.match(f.$("rename-session-status").textContent, /run \/reload/i, "a stale server explains how to enable renaming inside the dialog");
  submitRename();
  await tick();
  assert.equal(renamed, input.value);
  assert.equal(f.$("session-title-text").textContent, renamed);
  assert.equal(f.window.document.title, renamed);
  assert.equal(f.$("status").textContent, "Chat renamed.");
});

test("explorer groups chat branches and filters chats, then opens a saved transcript without losing the live draft", async (t) => {
  const calls = [];
  const longTitle = "Renovate updates for the important project with an extremely descriptive title";
  const f = await fixture(t, { chatFetch: async (path) => {
    calls.push(path);
    if (path === "/api/activity") return { ok: true, json: async () => ({ sessions: [{ id: "a", name: "Earlier live work", cwd: "/work/alpha" }] }) };
    if (path === "/api/sessions") return { ok: true, json: async () => ({
      current: { id: "current", name: "Live chat", cwd: "/work/alpha" },
      sessions: [{ id: "a", name: "Earlier live work", cwd: "/work/alpha", parentId: "current" }, { id: "b", name: longTitle, cwd: "/work/beta" }],
    }) };
    if (path === "/api/session/resume?id=b") return { ok: true, json: async () => ({ command: "cd -- '/work/beta' && pi --session '/store/b.jsonl'" }) };
    if (path === "/api/session?id=b") return { ok: true, json: async () => ({
      messages: [{ id: "r1", role: "assistant", ...renderMarkdown("**Saved reply**") }],
    }) };
    assert.match(path, /^\/api\/response/);
    return { ok: true, json: async () => ({
      mode: "chat", protocol: 2, sessionName: "Live chat", cursor: path.includes("?") ? "u2" : "u1", busy: false,
      messages: [{ id: path.includes("?") ? "u2" : "u1", role: "user", text: path.includes("?") ? "New live message" : "Live message" }],
    }) };
  } });
  assert.equal(f.$("right-panel").hidden, false);
  const css = await readFile(new URL("../web/style.css", import.meta.url), "utf8");
  assert.match(css, /\.chat-page #right-panel\[hidden\]\s*\{\s*display:\s*none;\s*\}/);
  const input = f.$("chat-input");
  input.value = "Unsent live draft";
  input.dispatchEvent(new f.window.Event("input"));
  assert.deepEqual(calls, ["/api/response"], "the catalog is not fetched until the explorer opens");
  const explorerToggle = f.$("explorer-toggle");
  assert.equal(explorerToggle.textContent.trim(), "");
  assert.equal(explorerToggle.getAttribute("aria-label"), "Toggle chat explorer");
  assert.equal(explorerToggle.title, "Toggle chat explorer");
  assert.ok(explorerToggle.querySelector('svg[aria-hidden="true"] rect'));
  assert.ok(explorerToggle.querySelector('svg path'));
  const scrolled = [];
  f.window.Element.prototype.scrollIntoView = function (options) { if (this.dataset.currentChat) scrolled.push(options); };
  explorerToggle.click();
  assert.equal(explorerToggle.getAttribute("aria-expanded"), "true");
  assert.equal(explorerToggle.getAttribute("aria-label"), "Toggle chat explorer");
  await tick();
  const list = f.$("session-list");
  assert.equal(scrolled.length, 0, "opening the explorer does not change its view mode");
  assert.deepEqual([...list.querySelectorAll("summary")].map(({ textContent }) => textContent), ["alpha", "beta"]);
  assert.equal(list.querySelectorAll(".session-indicator.live").length, 2);
  const peer = list.querySelector('[aria-label="Live in another tab"]');
  assert.ok(peer);
  assert.equal(peer.closest(".session-row").querySelector(".session-copy"), null);
  const live = list.querySelector('[aria-current="true"]');
  assert.equal(live.textContent, "Live chat");
  assert.equal(live.dataset.currentChat, "true");
  assert.ok(live.querySelector('.session-indicator.live[aria-label="Live session"]'));
  assert.equal(live.parentElement.querySelector(".session-copy"), null);
  const alphaGroup = list.querySelector('summary[title="/work/alpha"]').parentElement;
  assert.equal(alphaGroup.querySelector(".session-tree-children .session-open").textContent, "Earlier live work");

  const refresh = f.$("refresh-sessions");
  assert.equal(refresh.textContent.trim(), "");
  assert.equal(refresh.getAttribute("aria-label"), "Refresh chats");
  assert.ok(refresh.querySelector("svg"));
  const beta = list.querySelector('summary[title="/work/beta"]');
  beta.click();
  await tick();
  assert.equal(beta.parentElement.open, false);
  const controls = f.$("project-view-controls");
  assert.equal(controls.parentElement.querySelector("label"), null);
  assert.ok(controls.parentElement.firstElementChild === controls, "view-mode pill replaces the old heading position");
  assert.equal(f.$("session-filter").getAttribute("aria-label"), "Search chats by name or directory");
  assert.ok(f.$("session-filter").closest(".session-search").querySelector('svg[aria-hidden="true"]'));
  assert.deepEqual([...controls.querySelectorAll("button")].map((button) => button.getAttribute("aria-label")), ["Collapse all", "Show current chat in explorer", "Expand all"]);
  assert.ok(controls.querySelector('[data-action="show-current"] svg path'));
  assert.ok(controls.querySelector('[data-action="show-current"] svg circle'));
  assert.equal(controls.querySelectorAll('svg[aria-hidden="true"]').length, 3);
  const setMode = (mode) => {
    const button = controls.querySelector(`[data-mode="${mode}"]`);
    button.click();
    assert.equal(button.getAttribute("aria-pressed"), "true");
    return [...list.querySelectorAll("details")].map((group) => group.open);
  };
  assert.deepEqual(setMode("collapse"), [false, false]);
  assert.deepEqual(setMode("expand"), [true, true]);
  assert.deepEqual(setMode("collapse"), [false, false]);
  controls.querySelector('[data-action="show-current"]').click();
  assert.deepEqual([...list.querySelectorAll("details")].map((group) => group.open), [true, false]);
  assert.equal(scrolled.length, 1, "the pin control scrolls the current chat into view");
  assert.equal(scrolled[0].block, "nearest");
  const filter = f.$("session-filter");
  const search = (value) => {
    filter.value = value;
    filter.dispatchEvent(new f.window.Event("input"));
  };
  search("BETA renovate");
  assert.equal(list.querySelector("details").open, true, "search reveals matches in a collapsed project");
  search("");
  assert.equal(list.querySelector('summary[title="/work/beta"]').parentElement.open, false);
  search("beta renovate");
  assert.equal(list.querySelectorAll(".session-open").length, 1);
  const saved = list.querySelector(".session-open");
  assert.equal(saved.textContent, longTitle);
  assert.equal(saved.querySelector(".session-indicator"), null, "inactive chats have no status dot");
  saved.dispatchEvent(new f.window.MouseEvent("mouseenter"));
  assert.equal(f.window.document.getElementById("message-preview").textContent, longTitle);
  saved.dispatchEvent(new f.window.MouseEvent("mouseleave"));
  const copied = [];
  const clipboard = { writeText: async (text) => copied.push(text) };
  Object.defineProperty(f.window.navigator, "clipboard", { value: clipboard });
  const copy = list.querySelector(".session-copy");
  assert.equal(copy.textContent, "⧉", "copy control keeps its previous copy glyph");
  copy.click();
  await tick();
  assert.deepEqual(copied, ["cd -- '/work/beta' && pi --session '/store/b.jsonl'"]);
  assert.equal(f.$("conversation").hidden, false, "copying does not open the saved session");
  clipboard.writeText = async () => { throw new Error("Clipboard unavailable"); };
  copy.click();
  await tick();
  assert.equal(f.$("resume-command-dialog").open, true);
  assert.equal(f.$("resume-command").value, copied[0]);
  f.$("close-resume-command").click();
  saved.click();
  await tick();
  assert.equal(f.window.document.title, longTitle);
  assert.match(f.$("saved-directory").textContent, /Read-only · \/work\/beta/);
  assert.equal(f.$("saved-response").querySelector("strong").textContent, "Saved reply");
  assert.equal(f.$("saved-response").querySelector("[data-response-id]"), null);
  assert.equal(f.$("conversation").hidden, true);
  assert.equal(f.$("right-panel").hidden, true);
  assert.equal(f.$("chat-send").disabled, true);
  await f.poll();
  assert.equal(f.window.document.title, longTitle);
  assert.match(f.$("response").textContent, /New live message/);

  f.$("back-to-live").click();
  assert.equal(f.window.document.title, "Live chat");
  assert.equal(f.$("conversation").hidden, false);
  assert.equal(f.$("right-panel").hidden, false);
  assert.equal(f.$("saved-conversation").hidden, true);
  assert.equal(input.value, "Unsent live draft");
  assert.equal(f.$("chat-send").disabled, false);
  assert.equal(calls.some((path) => path === "/api/chat"), false);
});

test("saved-chat launch leaves the live composer alone and refresh drops a deleted duplicate", async (t) => {
  const cwd = "/work/pi-annotate";
  const name = "Live browser chat feature";
  const current = { id: "current", cwd, name };
  const copy = { id: "copy", cwd, name };
  const peer = { id: "peer", cwd, name: "Other live chat" };
  let deleted = false;
  let listFailures = 0;
  const launches = [];
  const f = await fixture(t, { chatFetch: async (path, body) => {
    if (path === "/api/sessions") {
      if (listFailures > 0) { listFailures--; throw new TypeError("Load failed"); }
      return { ok: true, json: async () => ({ current, canOpen: true, sessions: deleted ? [peer] : [copy, peer] }) };
    }
    if (path === "/api/activity") return { ok: true, json: async () => ({ sessions: [peer] }) };
    if (path.startsWith("/api/session?")) return { ok: true, json: async () => ({ messages: [] }) };
    if (path === "/api/session/open") {
      launches.push(body);
      return { ok: true, status: 202, json: async () => ({ ok: true }) };
    }
    assert.equal(path, "/api/response");
    return { ok: true, json: async () => ({ mode: "chat", protocol: 2, sessionName: name, cursor: null, busy: false, messages: [] }) };
  } });
  f.$("chat-input").value = "Keep this draft";
  f.$("explorer-toggle").click();
  await tick();
  const sessionButtons = () => [...f.$("session-list").querySelectorAll(".session-open")];
  sessionButtons().find((button) => button.textContent === peer.name).click();
  await tick();
  const resume = f.$("open-saved-chat");
  assert.equal(resume.textContent, "Open in another tab");
  assert.equal(resume.disabled, true);
  sessionButtons().filter((button) => button.textContent === name)[1].click();
  await tick();
  assert.equal(resume.textContent, "Resume in browser");
  assert.equal(resume.disabled, false);
  resume.click();
  assert.equal(resume.disabled, true);
  await tick();
  assert.deepEqual(launches, [{ id: "copy" }]);
  assert.match(f.$("status").textContent, /opening the chat in a new tab/);

  deleted = true;
  listFailures = 1;
  f.$("refresh-sessions").click();
  await tick();
  assert.equal(sessionButtons().filter((button) => button.textContent === name).length, 1);
  assert.match(f.$("saved-status").textContent, /saved chat was removed/);
  assert.equal(f.$("explorer-status").textContent, "");
  assert.equal(resume.hidden, true);
  f.$("back-to-live").click();
  assert.equal(f.$("chat-input").value, "Keep this draft");
});

test("Markdown notes persist per chat, preview safely, and copy their source", async (t) => {
  const sessionId = "note-session";
  const fetchChat = async (path, body) => {
    if (path === "/api/response") return { ok: true, json: async () => ({ mode: "chat", protocol: 2, sessionId, cursor: null, messages: [], busy: false }) };
    if (path === "/api/markdown") return { ok: true, json: async () => renderMarkdown(body.markdown) };
    throw new Error(`Unexpected chat request: ${path}`);
  };
  const f = await fixture(t, { chatFetch: fetchChat, storedNotes: { [sessionId]: "# Saved snippet" } });
  const note = f.$("chat-note-input");
  const key = `pi-annotate:markdown-note:v1:${sessionId}`;
  assert.equal(f.$("chat-note").hidden, false);
  assert.equal(f.$("chat-note").parentElement, f.$("annotations-panel").parentElement);
  assert.notEqual(f.$("chat-note").parentElement, f.$("annotations-panel"));
  assert.equal(f.$("chat-note-preview-toggle").textContent.trim(), "");
  assert.equal(f.$("chat-note-copy").textContent.trim(), "");
  const expandNote = f.$("chat-note-expand");
  assert.equal(expandNote.getAttribute("aria-controls"), "chat-note-input");
  expandNote.click();
  assert.equal(expandNote.getAttribute("aria-expanded"), "true");
  assert.equal(expandNote.getAttribute("aria-label"), "Collapse Markdown note");
  assert.equal(f.$("chat-note-dialog").open, true);
  assert.equal(f.$("chat-note").parentElement, f.$("chat-note-dialog"));
  expandNote.click();
  assert.equal(f.$("chat-note-dialog").open, false);
  assert.equal(f.$("chat-note").parentElement, f.$("right-panel"));
  assert.equal(expandNote.getAttribute("aria-expanded"), "false");
  const css = await readFile(new URL("../web/style.css", import.meta.url), "utf8");
  assert.match(css, /#chat-note-dialog \{[^}]*width: 80vw; height: 80dvh/);
  assert.match(css, /#chat-note\[data-previewing="true"\] \.chat-note-box:hover #chat-note-expand/);
  assert.equal(note.value, "# Saved snippet");
  note.value = "# Reusable\n\n**Prompt text** <script>bad()</script>";
  note.dispatchEvent(new f.window.Event("input"));
  assert.equal(f.window.localStorage.getItem(key), note.value);
  f.$("chat-note-preview-toggle").click();
  await tick();
  assert.equal(note.hidden, true);
  assert.ok(f.$("chat-note-preview").querySelector("h1 strong") || f.$("chat-note-preview").querySelector("h1"));
  assert.equal(f.$("chat-note-preview").querySelector("script"), null);
  assert.equal(f.$("chat-note-expand").hidden, false);
  f.$("chat-note-expand").click();
  assert.equal(f.$("chat-note-dialog").open, true);
  assert.equal(f.$("chat-note-preview").hidden, false, "expansion retains preview mode");
  f.$("chat-note-expand").click();
  assert.equal(f.$("chat-note-dialog").open, false);
  f.$("chat-note-preview-toggle").click();
  assert.equal(note.hidden, false);
  const copied = [];
  Object.defineProperty(f.window.navigator, "clipboard", { value: { writeText: async (text) => copied.push(text) } });
  f.$("chat-note-copy").click();
  await tick();
  assert.deepEqual(copied, [note.value]);

  const reopened = await fixture(t, { chatFetch: fetchChat, storedNotes: { [sessionId]: note.value } });
  assert.equal(reopened.$("chat-note-input").value, note.value);
  assert.equal(reopened.$("chat-input").value, "", "the note is separate from the message draft");
  const otherChat = async (path) => path === "/api/response"
    ? { ok: true, json: async () => ({ mode: "chat", protocol: 2, sessionId: "another-session", cursor: null, messages: [], busy: false }) }
    : { ok: true, json: async () => ({}) };
  const isolated = await fixture(t, { chatFetch: otherChat, storedNotes: { [sessionId]: note.value } });
  assert.equal(isolated.$("chat-note-input").value, "", "notes are scoped to their Pi session ID");
});

test("chat composer works from an empty session and clears only its own draft", async (t) => {
  const posts = [];
  const f = await fixture(t, { chatFetch: async (path, body) => {
    if (path !== "/api/response") posts.push(body);
    return { ok: true, json: async () => body ? { ok: true } : { mode: "chat", protocol: 2, cursor: null, messages: [], busy: false } };
  } });
  assert.equal(f.$("chat-form").hidden, false);
  assert.equal(f.$("chat-form").querySelector('label[for="chat-input"]'), null);
  assert.equal(f.$("chat-input").getAttribute("aria-label"), "Message");
  const attach = f.$("chat-attach");
  assert.equal(attach.getAttribute("aria-label"), "Attach files");
  assert.ok(attach.querySelector('svg[aria-hidden="true"] path'));
  assert.equal(attach.querySelector("svg rect"), null, "attachment control uses a paperclip, not a clipboard");
  let pickerOpens = 0;
  f.$("chat-file").addEventListener("click", (event) => {
    pickerOpens++;
    event.preventDefault();
  });
  attach.click();
  assert.equal(pickerOpens, 1);
  assert.ok(f.$("chat-send").closest(".chat-composer").contains(f.$("chat-input")));
  assert.equal(f.$("chat-send").getAttribute("aria-label"), "Send message");
  assert.ok(f.$("chat-send").querySelector("svg"));
  assert.equal(f.$("chat-send").querySelector("svg").getAttribute("width"), "18");
  assert.equal(f.$("chat-send").querySelector("svg").getAttribute("stroke-width"), "2");
  assert.equal(f.$("chat-send").querySelector("svg path").getAttribute("d"), "m5 12 4 4L19 6");
  assert.equal(f.$("chat-send").querySelector("svg path").getAttribute("d"), f.$("save-annotation").querySelector("svg path").getAttribute("d"));
  assert.equal(f.$("chat-send").disabled, true);
  const input = f.$("chat-input");
  input.value = "Hello from the browser";
  input.dispatchEvent(new f.window.Event("input"));
  const expand = f.$("chat-expand");
  assert.equal(expand.getAttribute("aria-controls"), input.id);
  assert.equal(expand.getAttribute("aria-expanded"), "false");
  expand.click();
  assert.equal(expand.getAttribute("aria-expanded"), "true");
  assert.equal(expand.getAttribute("aria-label"), "Collapse message composer");
  expand.click();
  assert.equal(expand.getAttribute("aria-expanded"), "false");
  assert.equal(input.value, "Hello from the browser");
  assert.equal(posts.length, 0);
  assert.equal(f.$("chat-send").disabled, false);
  for (const modifiers of [{ shiftKey: true }, { isComposing: true }]) {
    assert.equal(input.dispatchEvent(new f.window.KeyboardEvent("keydown", { key: "Enter", cancelable: true, ...modifiers })), true);
    assert.equal(posts.length, 0);
  }
  assert.equal(input.dispatchEvent(new f.window.KeyboardEvent("keydown", { key: "Enter", cancelable: true })), false);
  await tick();
  assert.equal(posts[0].text, "Hello from the browser");
  assert.equal(f.$("chat-input").value, "");
});

test("sending either draft leaves the other one unsent", async (t) => {
  const posts = [];
  const reply = { id: "a1", role: "assistant", ...renderMarkdown("Some answer.") };
  const f = await fixture(t, { chatFetch: async (path, body) => {
    if (body) posts.push(body);
    return { ok: true, json: async () => body ? { ok: true } : {
      mode: "chat", protocol: 2, cursor: reply.id, messages: path.includes("?") ? [] : [reply], busy: false,
    } };
  } });
  const input = f.$("chat-input");
  const write = (text) => { input.value = text; input.dispatchEvent(new f.window.Event("input")); };
  write("Ordinary message");
  f.select(0, 4, f.$("response").querySelector('[data-response-id="a1"]'));
  f.add("Question about the quote");
  f.$("chat-send").click();
  await tick();
  assert.deepEqual(posts.map(({ text, annotations }) => [text, annotations]), [["Ordinary message", undefined]]);
  assert.equal(f.$("annotations").children.length, 1);
  await f.poll();
  write("Unsent follow-up");
  f.$("send").click();
  await tick();
  assert.equal(posts.length, 2);
  assert.equal(posts[1].text, undefined);
  assert.equal(posts[1].annotations[0].comment, "Question about the quote");
  assert.equal(input.value, "Unsent follow-up");
});

test("leaving a chat page sends one authenticated disconnect request with keepalive", async (t) => {
  const calls = [];
  const f = await fixture(t, { chatFetch: async (path, body, { method, keepalive }) => {
    calls.push({ path, body, method, keepalive });
    return { ok: true, json: async () => ({ mode: "chat", protocol: 2, cursor: null, messages: [], busy: false }) };
  } });
  f.window.dispatchEvent(new f.window.Event("pagehide"));
  f.window.dispatchEvent(new f.window.Event("pagehide"));
  await tick();
  assert.deepEqual(calls.slice(1), [{ path: "/api/close", body: {}, method: "POST", keepalive: true }]);
});

test("browser chat adds several picked or pasted files, removes them individually, and retains them on failure", async (t) => {
  const posts = [];
  const f = await fixture(t, { chatFetch: async (path, body) => {
    if (path === "/api/response") return { ok: true, json: async () => ({ mode: "chat", protocol: 2, cursor: null, messages: [], busy: false }) };
    posts.push(body);
    const ok = posts.length > 1;
    return { ok, json: async () => ok ? { ok: true } : { error: "Pi is busy" } };
  } });
  const w = f.window;
  const input = f.$("chat-input");
  const file = f.$("chat-file");
  const list = f.$("chat-attachments");
  const filenames = () => Array.from(list.querySelectorAll("span"), (span) => span.textContent);
  function waitForFileCount(count) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { observer.disconnect(); reject(new Error(`Expected ${count} attached files`)); }, 1000);
      const observer = new w.MutationObserver(() => {
        if (list.children.length === count) {
          clearTimeout(timeout);
          observer.disconnect();
          resolve();
        }
      });
      observer.observe(list, { childList: true });
    });
  }
  assert.equal(file.multiple, true);
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgZGIGAAAOAAfXb+R4AAAAAElFTkSuQmCC";
  const pasted = waitForFileCount(1);
  const event = new w.Event("paste", { cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: { files: [new w.File([Buffer.from(png, "base64")], "clipboard.png", { type: "image/png" })] } });
  input.dispatchEvent(event);
  assert.equal(event.defaultPrevented, true);
  await pasted;
  assert.deepEqual(filenames(), ["clipboard.png"]);
  const preview = list.querySelector('[aria-label="Preview clipboard.png"]');
  const src = `data:image/png;base64,${png}`;
  assert.equal(preview.querySelector("img").src, src);
  preview.click();
  assert.equal(f.$("image-preview").open, true);
  assert.equal(f.$("preview-image").src, src);
  f.$("close-preview").click();
  assert.equal(f.$("image-preview").open, false);
  assert.equal(f.$("preview-image").hasAttribute("src"), false);
  const picked = waitForFileCount(3);
  Object.defineProperty(file, "files", { value: [
    new w.File(["picked"], "picked.png", { type: "image/png" }),
    new w.File(["code"], "Example.java"),
  ] });
  file.dispatchEvent(new w.Event("change"));
  await picked;
  assert.deepEqual(filenames(), ["clipboard.png", "picked.png", "Example.java"]);
  const removeImage = list.querySelector('[aria-label="Remove picked.png"]');
  assert.equal(removeImage.textContent, "×");
  assert.equal(list.querySelector('[aria-label="Remove Example.java"]').textContent, "Remove");
  removeImage.click();
  assert.equal(f.$("image-preview").open, false);
  assert.deepEqual(filenames(), ["clipboard.png", "Example.java"]);
  assert.equal(list.querySelectorAll("img").length, 1);
  assert.equal(posts.length, 0);
  assert.equal(f.$("chat-send").disabled, false);
  f.$("chat-send").click();
  await tick();
  assert.match(f.$("status").textContent, /Pi is busy/);
  assert.deepEqual(filenames(), ["clipboard.png", "Example.java"]);
  f.$("chat-send").click();
  await tick();
  assert.equal(posts[0].text, "", "attachment-only sends are allowed");
  assert.deepEqual(posts[0].attachments, [
    { name: "clipboard.png", mimeType: "image/png", data: png },
    { name: "Example.java", mimeType: "", data: "Y29kZQ==" },
  ]);
  assert.deepEqual(posts[0], posts[1]);
  assert.equal(list.hidden, true);
});

test("live annotations can paste and pick images, edit them, and retry without touching the composer", async (t) => {
  const posts = [];
  const f = await fixture(t, { chatFetch: async (path, body) => {
    if (path === "/api/response") return { ok: true, json: async () => ({
      mode: "chat", protocol: 2, annotationImages: true, cursor: "a1", busy: false,
      messages: [{ id: "a1", role: "assistant", ...renderMarkdown("Choose a **passage**.") }],
    }) };
    assert.equal(path, "/api/chat");
    posts.push(body);
    return { ok: posts.length > 1, json: async () => posts.length > 1 ? { ok: true } : { error: "Pi is busy" } };
  } });
  const w = f.window;
  const list = f.$("comment-attachments");
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgZGIGAAAOAAfXb+R4AAAAAElFTkSuQmCC";
  const picture = (name) => new w.File([Buffer.from(png, "base64")], name, { type: "image/png" });
  const waitForCount = (count) => new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { observer.disconnect(); reject(new Error(`Expected ${count} images`)); }, 1000);
    const observer = new w.MutationObserver(() => {
      if (list.children.length !== count) return;
      clearTimeout(timeout);
      observer.disconnect();
      resolve();
    });
    observer.observe(list, { childList: true });
  });
  assert.equal(f.$("comment-images").hidden, false);
  assert.ok(f.$("comment-attach").querySelector('svg[aria-hidden="true"] path'));
  assert.equal(f.$("comment-attach").querySelector("svg rect"), null, "annotation attachment control uses a paperclip");
  assert.equal(f.$("comment-attach").parentElement, f.$("save-annotation").parentElement, "paperclip sits beside Add annotation");
  f.$("chat-input").value = "Leave this draft alone";
  f.select(9, 16, f.$("response").querySelector("[data-response-id]"));
  const pasted = waitForCount(1);
  const event = new w.Event("paste", { cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: { files: [picture("pasted.png")] } });
  f.$("comment").dispatchEvent(event);
  assert.equal(event.defaultPrevented, true);
  await pasted;
  assert.match(list.querySelector("img").src, /^data:image\/png;base64,/);
  assert.equal(f.$("comment-file-status").textContent, "", "successful attachment shows no status text");
  const picked = waitForCount(2);
  const input = f.$("comment-file");
  Object.defineProperty(input, "files", { value: [picture("picked.png")] });
  input.dispatchEvent(new w.Event("change"));
  await picked;
  f.add("What is this?");
  assert.equal(f.$("annotations").querySelectorAll("img").length, 2);
  f.$("annotations").querySelector('[aria-label="Edit annotation"]').click();
  list.querySelector('[aria-label="Remove picked.png"]').click();
  f.add("See the image.");
  f.$("send").click();
  await tick();
  assert.equal(f.$("annotations").querySelectorAll("img").length, 1);
  f.$("send").click();
  await tick();
  assert.deepEqual(posts[0], posts[1]);
  assert.deepEqual(posts[0].annotations[0], {
    start: 9, end: 16, quote: "passage", responseId: "a1", comment: "See the image.",
    images: [{ name: "pasted.png", mimeType: "image/png", data: png }],
  });
  assert.equal(f.$("annotations").children.length, 0);
  assert.equal(f.$("chat-input").value, "Leave this draft alone");
});

test("a chat server without multi-file support cannot receive messages from the new page", async (t) => {
  const f = await fixture(t, { chatFetch: async () => ({ ok: true, json: async () => ({ mode: "chat", messages: [], busy: false }) }) });
  assert.equal(f.$("chat-form").hidden, true);
  assert.match(f.$("status").textContent, /chat server is outdated/);
});

test("an old server with new browser assets reports a reload/version error", async (t) => {
  const f = await fixture(t, { markdown: "**Bold** response", legacyServer: true });
  assert.match(f.$("status").textContent, /server is outdated/);
  assert.doesNotMatch(f.$("status").textContent, /did not match/);
  assert.equal(f.$("response").textContent.trim(), "");
  assert.equal(f.$("send").disabled, true);
  assert.equal(f.posts.length, 0);
});

test("a rendered-text mismatch fails closed instead of returning the wrong quote", async (t) => {
  const f = await fixture(t, { markdown: "**Bold** response", corruptText: true });
  assert.match(f.$("status").textContent, /did not match/);
  assert.equal(f.$("response").textContent, "");
  assert.equal(f.$("send").disabled, true);
  assert.equal(f.posts.length, 0);
});
