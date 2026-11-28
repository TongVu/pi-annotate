import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Script } from "node:vm";
import { JSDOM } from "jsdom";
import { renderMarkdown } from "../src/markdown.ts";
import { startChatPage } from "../web/app.js";
const logo = await readFile(new URL("../web/logo.png", import.meta.url));
// The dashboard still uses the classic shared tooltip script. Test it in the window's realm.
const tooltipScript = new Script(await readFile(new URL("../web/tooltips.js", import.meta.url), "utf8"), { filename: "web/tooltips.js" });
async function fixture(t, { chatFetch, loadNotes, setupWindow } = {}) {
  const html = await readFile(new URL("../web/index.html", import.meta.url), "utf8");
  const dom = new JSDOM(html, { url: "http://127.0.0.1:12345/?tab=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa#test-token", runScripts: "outside-only" });
  t.after(() => dom.window.close());
  const { window } = dom;
  setupWindow?.(window);
  const $ = (id) => window.document.getElementById(id);
  window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  window.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new window.Event("close")); };
  window.Range.prototype.getBoundingClientRect = () => ({ left: 100, top: 150, bottom: 170 });
  const timers = new Map();
  let timerId = 0;
  if (chatFetch) {
    window.setTimeout = (fn, delay) => {
      timers.set(++timerId, { fn, delay });
      return timerId;
    };
    window.clearTimeout = (id) => timers.delete(id);
  }
  const runTimer = (matches) => {
    const next = [...timers].find(([, { delay }]) => matches(delay));
    assert.ok(next, "expected a pending timer");
    const [id, { fn }] = next;
    timers.delete(id);
    return fn();
  };
  window.fetch = async (path, opts) => {
    if (path === "/logo.png") return { ok: true, arrayBuffer: async () => logo };
    assert.equal(opts.headers.Authorization, "Bearer test-token");
    if (!chatFetch) throw new Error(`Unexpected chat request: ${path}`);
    return chatFetch(path, opts.body && JSON.parse(opts.body), opts);
  };
  tooltipScript.runInContext(dom.getInternalVMContext());
  await startChatPage(window, { tooltipFactory: window.createTooltips, loadNotes });
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
  return { window, $, select, add, poll: () => runTimer((delay) => delay >= 1000), autosave: () => runTimer((delay) => delay < 1000) };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("the composer model picker shows supported efforts and only allows changes while idle", async (t) => {
  const sol = { key: "openai/sol", label: "Sol" };
  const luna = { key: "openai/luna", label: "Luna" };
  const models = [sol, luna];
  let current = { model: sol, models, effort: "medium", efforts: ["low", "medium", "high"] };
  let busy = true;
  const changes = [];
  const finish = Promise.withResolvers();
  const json = (data, code = 200) => ({ ok: code === 200, status: code, json: async () => data });
  const f = await fixture(t, { chatFetch: async (path, body) => {
    if (path === "/api/response") return json({ mode: "chat", protocol: 2, cursor: null, messages: [], busy });
    assert.equal(path, "/api/session/model");
    if (body) {
      changes.push(body);
      if (body.model === luna.key) {
        await finish.promise;
        current = { model: luna, models, effort: "high", efforts: ["low", "high", "xhigh", "max"] };
      } else if (current.efforts.includes(body.effort)) current = { ...current, effort: body.effort };
      else return json({ error: "Pi is busy" }, 409);
    }
    return json(current);
  } });
  const toggle = f.$("chat-model-toggle");
  const panel = f.$("chat-model-panel");
  const model = f.$("chat-model");
  const efforts = f.$("chat-effort");
  const effort = (level) => efforts.querySelector(`button[value="${level}"]`);
  const selectedEffort = () => efforts.querySelector('[aria-pressed="true"]')?.textContent;
  const options = f.$("chat-model-options");
  const noMatches = f.$("chat-model-no-matches");
  const type = (value) => {
    model.value = value;
    model.dispatchEvent(new f.window.Event("input"));
  };
  const key = (key) => {
    const event = new f.window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
    model.dispatchEvent(event);
    return event.defaultPrevented;
  };
  toggle.click();
  await tick();
  assert.equal(panel.hidden, false);
  assert.equal(model.labels[0].textContent, "👽");
  assert.equal(model.getAttribute("aria-label"), "Model");
  assert.equal(efforts.getAttribute("aria-label"), "Thinking effort");
  assert.equal(model.value, "Sol");
  assert.equal(selectedEffort(), "Medium");
  assert.equal(model.disabled, true);
  assert.ok([...efforts.children].every((button) => button.disabled));
  assert.match(f.$("chat-model-status").textContent, /Wait for Pi/);
  model.click();
  effort("high").click();
  assert.equal(options.hidden, true);
  assert.deepEqual(changes, []);
  busy = false;
  await f.poll();
  assert.equal(model.disabled, false);
  assert.ok([...efforts.children].every((button) => !button.disabled));
  const draft = f.$("chat-input");
  draft.value = "Draft for the next model";
  model.focus();
  assert.equal(model.selectionEnd, "Sol".length);
  model.click();
  assert.deepEqual([...options.children].map(({ textContent }) => textContent), ["Sol", "Luna"]);
  type("missing");
  assert.equal(noMatches.hidden, false);
  assert.equal(key("Enter"), true, "Enter with no results must not submit the chat form");
  assert.deepEqual(changes, []);
  assert.equal(key("Escape"), true);
  assert.equal(noMatches.hidden, true);
  assert.equal(panel.hidden, false);
  assert.equal(model.value, "Sol");
  type("OPENAI/");
  assert.equal(model.getAttribute("aria-expanded"), "true");
  key("ArrowDown");
  key("ArrowDown");
  assert.equal(model.getAttribute("aria-activedescendant"), options.lastElementChild.id);
  assert.equal(options.lastElementChild.getAttribute("aria-selected"), "true");
  assert.equal(key("Enter"), true);
  assert.equal(options.hidden, true);
  assert.equal(model.disabled, true);
  assert.equal(f.$("chat-send").disabled, true);
  finish.resolve();
  await tick();
  assert.equal(model.value, "Luna");
  assert.deepEqual([...efforts.children].map(({ textContent }) => textContent), ["Low", "High", "Extra high", "Max"]);
  assert.equal(selectedEffort(), "High");
  assert.equal(draft.value, "Draft for the next model");
  effort("max").focus();
  effort("max").click();
  assert.equal(effort("low").getAttribute("aria-disabled"), "true");
  effort("low").click(); // Ignore other choices while applying a change.
  await tick();
  assert.equal(selectedEffort(), "Max");
  assert.equal(f.window.document.activeElement, effort("max"));
  effort("max").click(); // Selecting the active choice is a no-op.
  effort("low").click();
  await tick();
  assert.equal(selectedEffort(), "Low");
  assert.equal(draft.value, "Draft for the next model");
  model.focus();
  type("so");
  effort("low").focus();
  assert.equal(options.hidden, true);
  assert.equal(model.value, "Luna", "leaving without choosing restores the active model");
  model.focus();
  type("so");
  assert.deepEqual([...options.children].map(({ textContent }) => textContent), ["Sol"]);
  options.firstElementChild.click();
  await tick();
  assert.equal(model.value, "Luna", "failed changes restore the active model");
  assert.equal(f.$("chat-model-error").textContent, "Pi is busy");
  assert.deepEqual(changes, [{ model: luna.key }, { effort: "max" }, { effort: "low" }, { model: sol.key }]);
  effort("low").dispatchEvent(new f.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  assert.equal(panel.hidden, true);
  assert.equal(f.window.document.activeElement, toggle);
});

test("composer shows live context usage and compacts only after confirmation while idle", async (t) => {
  const reply = { id: "a1", role: "assistant", ...renderMarkdown("An earlier reply.") };
  let busy = false;
  let usage = { tokens: 20000, contextWindow: 80000, percent: 25 };
  let posts = 0;
  const finish = Promise.withResolvers();
  const json = (data, code = 200) => ({ ok: code === 200, status: code, json: async () => data });
  const f = await fixture(t, { chatFetch: async (path, body) => {
    if (path === "/api/response" || path.startsWith("/api/response?")) {
      return json({ mode: "chat", protocol: 2, cursor: "a1", messages: path.includes("?") ? [] : [reply], busy, contextUsage: usage, canCompact: true });
    }
    assert.equal(path, "/api/session/compact");
    assert.deepEqual(body, {});
    if (++posts === 2) return json({ error: "Nothing to compact" }, 400);
    await finish.promise;
    return json({ ok: true });
  } });
  const context = f.$("chat-context");
  const details = f.$("chat-context-details");
  const compact = f.$("chat-compact");
  const dialog = f.$("compact-chat-dialog");
  const confirm = f.$("confirm-chat-compact");
  assert.equal(context.getAttribute("aria-label"), "Context usage: 25%");
  assert.equal(f.$("chat-context-ring").getAttribute("stroke-dasharray"), "25 100");
  context.click();
  assert.equal(details.hidden, false);
  assert.match(details.textContent, /Estimated .* tokens used \(25%\)/);
  context.dispatchEvent(new f.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  assert.equal(details.hidden, true);
  compact.click();
  assert.equal(dialog.open, true);
  assert.equal(posts, 0);
  f.$("cancel-chat-compact").click();
  assert.equal(dialog.open, false);
  assert.equal(posts, 0);
  compact.click();
  busy = true;
  await f.poll();
  assert.equal(compact.disabled, true);
  assert.equal(confirm.disabled, true);
  confirm.click();
  assert.equal(posts, 0);
  busy = false;
  await f.poll();
  f.$("chat-input").value = "Keep this draft";
  confirm.click();
  assert.equal(posts, 1);
  assert.equal(compact.disabled, true);
  assert.equal(f.$("chat-send").disabled, true);
  assert.match(f.$("status").textContent, /Compacting chat/);
  finish.resolve();
  await tick();
  assert.equal(f.$("status").textContent, "Chat compacted.");
  assert.equal(f.$("chat-input").value, "Keep this draft");
  assert.equal(f.$("chat-send").disabled, false);
  usage = { tokens: null, contextWindow: 80000, percent: null };
  await f.poll();
  context.click();
  assert.match(details.textContent, /Model limit: .* tokens\. Usage is unavailable/);
  assert.equal(f.$("chat-context-ring").getAttribute("stroke-dasharray"), "0 100");
  assert.ok(f.$("response").querySelector('[data-response-id="a1"]'));
  compact.click();
  confirm.click();
  await tick();
  assert.equal(f.$("status").textContent, "Nothing to compact");
  assert.equal(f.$("status").classList.contains("error"), true);
  assert.equal(compact.disabled, false);
});

test("chat dots jump to user turns; failed questions are kept, accepted questions clear, and new replies are annotatable", async (t) => {
  const user = { id: "u1", role: "user", ...renderMarkdown("A **question** <b>posted as text</b>") };
  const assistant = (id, text) => ({ id, role: "assistant", ...renderMarkdown(text) });
  const chatResponse = (cursor, messages, busy = false) => ({ mode: "chat", protocol: 2, cursor, messages, busy });
  const json = (data, status = 200) => ({ ok: status === 200, status, json: async () => data });
  const posts = [];
  const accept = Promise.withResolvers();
  const f = await fixture(t, { chatFetch: async (path, body) => {
    if (path === "/api/response") return json(chatResponse("a1", [user, assistant("a1", "**Old** reply")]));
    if (path === "/api/response?after=a1") {
      const questions = renderMarkdown("Questions about assistant response a1:\n\n### 1\n> Old\n\nWhy `old`?");
      return json(chatResponse("a2", [{ id: "u2", role: "user", ...questions }, assistant("a2", "**New** reply")]));
    }
    if (path === "/api/markdown") return json(renderMarkdown(body.markdown));
    assert.equal(path, "/api/chat");
    posts.push(body);
    if (posts.length === 1) return json({ error: "Pi is busy" }, 409);
    if (posts.length === 2) await accept.promise;
    return json({ ok: true });
  } });
  assert.equal(f.window.location.hash, "", "remove the chat token from the URL");
  assert.equal(f.window.location.search, "?tab=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "keep the dashboard tab locator");
  assert.equal(f.$("turns").children.length, 1);
  assert.equal(f.$("send").parentElement.id, "annotation-heading");
  assert.equal(f.$("send").dataset.tooltip, "Send questions");
  assert.equal(f.$("send").getAttribute("aria-label"), "Send 0 questions");
  assert.equal(f.$("count").textContent, "0");
  assert.equal(f.$("send").classList.contains("chat-question-send"), true);
  assert.equal(f.$("send").querySelector(".send-icon").textContent, "🚀");
  const currentDot = () => f.$("turns").querySelector('[aria-current="location"]');
  assert.equal(currentDot(), f.$("turns").firstElementChild);
  const firstUser = f.$("response").querySelector(".user-turn");
  assert.equal(firstUser.textContent, user.text);
  assert.equal(firstUser.getAttribute("aria-label"), "Your message");
  assert.equal(firstUser.querySelector("b"), null);
  assert.equal(firstUser.querySelector("strong").textContent, "question");
  assert.equal(firstUser.querySelector("[data-response-id]"), null);
  firstUser.getBoundingClientRect = () => ({ top: 300 });
  f.$("response").getBoundingClientRect = () => ({ top: 50 });
  f.$("response").scrollTop = 20;
  f.$("turns").scrollTop = 10;
  const dot = f.$("turns").firstElementChild;
  const list = f.$("turn-list");
  const row = list.firstElementChild;
  assert.equal(list.hidden, true);
  f.$("turns").dispatchEvent(new f.window.MouseEvent("mouseenter"));
  assert.equal(list.hidden, false);
  assert.equal(row.textContent, "A question <b>posted as text</b>");
  assert.equal(row.querySelector("b"), null);
  assert.equal(row.getAttribute("aria-current"), "location");
  f.$("chat-rail").dispatchEvent(new f.window.MouseEvent("mouseleave"));
  assert.equal(list.hidden, true);
  dot.click();
  assert.equal(f.$("response").scrollTop, 270);
  assert.equal(f.$("turns").scrollTop, 10);
  assert.equal(list.hidden, false, "tapping a dot also opens the navigator");
  f.$("response").dispatchEvent(new f.window.Event("pointerdown", { bubbles: true }));
  assert.equal(list.hidden, true);
  dot.focus();
  dot.dispatchEvent(new f.window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
  assert.equal(f.window.document.activeElement, row);
  row.dispatchEvent(new f.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  assert.equal(f.window.document.activeElement, dot);
  assert.equal(list.hidden, true);
  dot.blur();
  const oldReply = f.$("response").querySelector('[data-response-id="a1"]');
  f.select(0, 3, oldReply);
  f.$("annotate-selection").click();
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
  const sentQuestions = transcript.querySelectorAll(".user-turn")[1];
  assert.equal(sentQuestions.querySelector("h3").textContent, "1");
  assert.equal(sentQuestions.querySelector("blockquote").textContent.trim(), "Old");
  assert.equal(sentQuestions.querySelector("code").textContent, "old");
  sentQuestions.getBoundingClientRect = () => ({ top: 500 - transcript.scrollTop });
  assert.equal(list.children.length, 2);
  for (const [scrollTop, index] of [[120, 0], [450, 1]]) {
    transcript.scrollTop = scrollTop;
    transcript.dispatchEvent(new f.window.Event("scroll"));
    assert.equal(currentDot(), f.$("turns").children[index]);
    assert.deepEqual([...list.querySelectorAll("[aria-current]")], [list.children[index]]);
  }
  list.getBoundingClientRect = () => ({ top: 0, bottom: 32 });
  list.lastElementChild.getBoundingClientRect = () => ({ top: 32, bottom: 64 });
  f.$("turns").dispatchEvent(new f.window.MouseEvent("mouseenter"));
  assert.equal(list.scrollTop, 32, "opening the list reveals the current row");
  assert.equal(transcript.scrollTop, 450, "opening the list does not move the transcript");
  row.click();
  assert.equal(transcript.scrollTop, 12);
  assert.equal(currentDot(), dot);
  assert.equal(list.hidden, true);
  assert.equal(f.window.document.activeElement, transcript);
  assert.equal(transcript.querySelector('[data-response-id="a1"]'), oldReply);
  const newReply = f.$("response").querySelector('[data-response-id="a2"]');
  f.select(0, 3, newReply);
  f.$("annotate-selection").click();
  assert.equal(f.$("selected-quote").textContent, "New");
  f.add("Why new?");
  f.$("send").click();
  await tick();
  assert.notEqual(posts[2].requestId, posts[1].requestId);
  assert.equal(posts[2].annotations[0].responseId, "a2");
});

test("selecting a reply offers an annotation without blocking copy or opening the dialog", async (t) => {
  const f = await fixture(t, { chatFetch: async () => ({ ok: true, json: async () => ({
    mode: "chat", protocol: 2, cursor: "a1", busy: false,
    messages: [{ id: "u1", role: "user", ...renderMarkdown("Your prompt") }, { id: "a1", role: "assistant", ...renderMarkdown("Read **this passage**.") }],
  }) }) });
  const transcript = f.$("response");
  const reply = transcript.querySelector('[data-response-id="a1"]');
  const action = f.$("annotate-selection");
  const dialog = f.$("comment-dialog");
  const selection = f.window.getSelection();
  assert.equal(action.hidden, true);
  f.select(0, 4, transcript.querySelector(".user-turn"));
  assert.equal(action.hidden, true, "user messages are not annotatable");
  f.select(5, 17, reply);
  assert.equal(action.hidden, false);
  assert.equal(action.style.left, "100px");
  assert.equal(dialog.open, false);
  assert.equal(selection.toString(), "this passage");
  const copy = new f.window.Event("copy", { bubbles: true, cancelable: true });
  reply.dispatchEvent(copy);
  assert.equal(copy.defaultPrevented, false);
  assert.equal(selection.toString(), "this passage");
  f.$("chat-input").dispatchEvent(new f.window.MouseEvent("pointerdown", { bubbles: true }));
  assert.equal(action.hidden, true);
  assert.equal(dialog.open, false);
  f.window.document.dispatchEvent(new f.window.Event("selectionchange"));
  assert.equal(action.hidden, true, "clicking away dismisses even if the selection is still present");
  f.select(5, 17, reply);
  selection.removeAllRanges();
  f.window.document.dispatchEvent(new f.window.Event("selectionchange"));
  assert.equal(action.hidden, true, "clearing the selection also dismisses the action");
  f.select(5, 17, reply);
  f.window.document.dispatchEvent(new f.window.KeyboardEvent("keyup", { key: "Escape" }));
  assert.equal(action.hidden, true);
  f.window.document.dispatchEvent(new f.window.KeyboardEvent("keyup", { key: "Shift" }));
  assert.equal(action.hidden, false, "keyboard selection can offer the action");
  const down = new f.window.MouseEvent("mousedown", { bubbles: true, cancelable: true });
  action.dispatchEvent(down);
  assert.equal(down.defaultPrevented, true, "pressing the action keeps the selection intact until activation");
  action.click();
  assert.equal(action.hidden, true);
  assert.equal(dialog.open, true);
  assert.equal(f.$("selected-quote").textContent, "this passage");
  assert.equal(f.window.document.activeElement, f.$("comment"));
});

test("copy response uses original Markdown, copy code omits fences, and annotations use rendered text", async (t) => {
  const highlighted = "  const html = '<tag>&';\n";
  const plain = "    second block  \n";
  const user = { id: "u1", role: "user", ...renderMarkdown("```\nuser code\n```") };
  const markdown = `Copy **this reply**.\n\n\`\`\`js\n${highlighted}\`\`\`\n\n\`\`\`text\n${plain}\`\`\``;
  const reply = { id: "a1", role: "assistant", canBranch: true, markdown, ...renderMarkdown(markdown) };
  const copied = [];
  const clipboard = { writeText: async (text) => copied.push(text) };
  const f = await fixture(t, { chatFetch: async () => ({ ok: true, json: async () => ({
    mode: "chat", protocol: 2, cursor: "a1", busy: false, messages: [user, reply],
  }) }) });
  Object.defineProperty(f.window.navigator, "clipboard", { value: clipboard });
  const response = f.$("response");
  const turn = response.querySelector(".assistant-turn");
  const content = turn.querySelector('[data-response-id="a1"]');
  const footer = turn.lastElementChild;
  const copy = footer.querySelector('[aria-label="Copy response"]');
  const code = [...content.querySelectorAll('[aria-label="Copy code"]')];
  assert.ok(footer.querySelector(".reply-branch"));
  assert.equal(response.querySelector(".user-turn button"), null);
  assert.equal(content.textContent, reply.text);
  assert.equal(content.querySelector("pre button"), null);
  assert.ok(content.querySelector(".hljs-keyword"));
  assert.equal(code.length, 2);
  assert.equal(copy.querySelector("svg").innerHTML, f.$("chat-note-copy").querySelector("svg").innerHTML);
  copy.click();
  code[0].click();
  code[1].click();
  await tick();
  assert.deepEqual(copied, [markdown, highlighted, plain]);
  assert.equal(f.$("status").textContent, "Code copied.");
  clipboard.writeText = async () => { throw new Error("Clipboard unavailable"); };
  copy.click();
  await tick();
  assert.match(f.$("status").textContent, /Could not copy to clipboard/);

  const start = reply.text.indexOf("<tag>&");
  f.select(start, start + 6, content);
  f.$("annotate-selection").click();
  assert.equal(f.$("selected-quote").textContent, "<tag>&");
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
  const favicon = () => decodeURIComponent(f.$("app-favicon").href);
  const titleStatus = f.$("session-title-status");
  const expectStatus = (label, color, title) => {
    assert.equal(titleStatus.textContent, label);
    assert.equal(titleStatus.style.getPropertyValue("--title-status-color"), color);
    assert.ok(favicon().includes(`r="8" fill="${color}" stroke="white"`));
    assert.equal(f.window.document.title, `Pi Chat · ${title}`);
  };
  assert.ok(favicon().includes(`data:image/png;base64,${logo.toString("base64")}`), "the status badge is drawn over the supplied logo");
  expectStatus("Ready", "#2f9b69", "✓ Ready");
  busy = true;
  await f.poll();
  assert.equal(indicator.dataset.state, "working");
  assert.match(indicator.textContent, /working/);
  expectStatus("Working", "#dc4141", "🏗️ Working");
  busy = false;
  await f.poll();
  assert.equal(indicator.dataset.state, "ready");
  expectStatus("Ready", "#2f9b69", "✓ Ready");
  failed = true;
  await f.poll();
  assert.equal(indicator.dataset.state, "stopped");
  expectStatus("Stopped", "#d99b25", "🚫 Stopped");
  offline = true;
  await f.poll();
  assert.equal(indicator.dataset.state, "disconnected");
  expectStatus("Offline", "#858b91", "🔌 Offline");
});

test("the tab shows working from send through the next fresh Pi status", async (t) => {
  let post;
  let response;
  const chat = (busy = false) => ({ mode: "chat", protocol: 2, cursor: null, messages: [], busy });
  const json = (data, status = 200) => ({ ok: status === 200, status, json: async () => data });
  const f = await fixture(t, { chatFetch: async (path) => {
    if (path === "/api/chat") return post.promise;
    assert.equal(path, "/api/response");
    return response ? response.promise : json(chat());
  } });
  const title = () => f.window.document.title;
  const readyTitle = "Pi Chat · ✓ Ready";
  const workingTitle = "Pi Chat · 🏗️ Working";
  const submit = () => f.$("chat-form").dispatchEvent(new f.window.Event("submit", { cancelable: true }));
  const input = f.$("chat-input");
  const workingComposer = () => input.closest('.chat-composer:has(#chat-state[data-state="working"])');
  assert.equal(title(), readyTitle);
  assert.equal(workingComposer(), null);
  input.value = "Hello Pi";
  post = Promise.withResolvers();
  submit();
  assert.equal(title(), workingTitle, "working is visible before Pi acknowledges the send");
  assert.equal(workingComposer(), input.closest(".chat-composer"));
  await f.poll();
  assert.equal(title(), workingTitle, "idle polls during the send do not clear working");
  post.resolve(json({ error: "Send rejected" }, 409));
  await tick();
  assert.equal(title(), readyTitle);
  assert.equal(input.value, "Hello Pi");
  assert.equal(workingComposer(), null);

  post = Promise.withResolvers();
  submit();
  response = Promise.withResolvers();
  const stalePoll = f.poll();
  post.resolve(json({ ok: true }));
  await tick();
  assert.equal(title(), workingTitle);
  response.resolve(json(chat()));
  await stalePoll;
  assert.equal(title(), workingTitle, "a poll from before acknowledgement cannot clear working");
  response = { promise: Promise.resolve(json(chat(true))) };
  await f.poll();
  assert.equal(title(), workingTitle);
  assert.ok(workingComposer());
  response = undefined;
  await f.poll();
  assert.equal(title(), readyTitle);
  assert.equal(workingComposer(), null);
});

test("two live chats keep their session name first regardless of shared status", async (t) => {
  let secondBusy = false;
  const response = (sessionName, busy) => ({
    ok: true, json: async () => ({ mode: "chat", protocol: 2, cursor: null, messages: [], sessionName, busy }),
  });
  const first = await fixture(t, { chatFetch: async () => response("Fix markdown overflow", false) });
  const second = await fixture(t, { chatFetch: async () => response("Merging renovate PRs", secondBusy) });
  assert.equal(first.window.document.title, "Fix markdown overflow · ✓ Ready");
  assert.equal(second.window.document.title, "Merging renovate PRs · ✓ Ready");
  secondBusy = true;
  await second.poll();
  assert.equal(first.window.document.title, "Fix markdown overflow · ✓ Ready");
  assert.equal(second.window.document.title, "Merging renovate PRs · 🏗️ Working");
});

test("chat tab follows the Pi session name and moves chat controls out of the header", async (t) => {
  let sessionName = "Live browser chat feature";
  const f = await fixture(t, { chatFetch: async () => ({
    ok: true, json: async () => ({ mode: "chat", protocol: 2, cursor: null, messages: [], busy: false, sessionName }),
  }) });
  assert.equal(f.window.document.title, `${sessionName} · ✓ Ready`);
  assert.equal(f.$("page-intro").hidden, true);
  assert.equal(f.$("chat-state").hidden, false);
  assert.equal(f.$("chat-state").parentElement, f.$("chat-form").querySelector(".actions"));
  assert.equal(f.$("chat-state").nextElementSibling, f.$("chat-status-actions"));
  assert.equal(f.$("status").parentElement, f.$("chat-status-actions"));
  assert.equal(f.$("explorer-toggle").parentElement, f.$("session-title-pill"));
  assert.equal(f.$("turns").parentElement, f.$("chat-rail"));
  assert.equal(f.$("status").textContent, "");

  sessionName = "Renamed <em>chat</em>";
  await f.poll();
  assert.equal(f.window.document.title, `${sessionName} · ✓ Ready`);

  sessionName = undefined;
  await f.poll();
  assert.equal(f.window.document.title, "Pi Chat · ✓ Ready");
});

test("the chat controls logo opens the dashboard with both sidebars closed and keeps the chat draft", async (t) => {
  const calls = [];
  const result = Promise.withResolvers();
  const f = await fixture(t, { chatFetch: async (path, body) => {
    if (path === "/api/dashboard/open") {
      calls.push(body);
      return result.promise;
    }
    assert.equal(path, "/api/response");
    return { ok: true, json: async () => ({ mode: "chat", protocol: 2, messages: [], busy: false }) };
  } });
  const button = f.$("open-dashboard");
  const original = f.window.location.href;
  const controls = f.$("session-title-pill");
  assert.equal(controls.firstElementChild, button);
  assert.equal(button.querySelector("img").getAttribute("src"), "/logo.png");
  f.$("chat-tools-toggle").click();
  assert.equal(f.$("chat-tools-toggle").getAttribute("aria-expanded"), "false");
  assert.equal(f.$("chat-explorer").hidden, true);
  assert.equal(controls.hidden, false);
  assert.equal(button.hidden, false);
  f.$("chat-input").value = "Keep my draft";
  button.click();
  assert.equal(button.disabled, true);
  assert.deepEqual(calls, [{}]);
  result.resolve({ ok: true, json: async () => ({ ok: true }) });
  await tick();
  assert.equal(button.disabled, false);
  assert.equal(f.window.location.href, original);
  assert.equal(f.$("chat-input").value, "Keep my draft");
});

test("the icon-only terminal button requests focus for the live chat and reports errors", async (t) => {
  const result = Promise.withResolvers();
  const requests = [];
  const f = await fixture(t, { chatFetch: async (path, body) => {
    if (path === "/api/session/focus-terminal") {
      requests.push(body);
      return result.promise;
    }
    assert.equal(path, "/api/response");
    return { ok: true, json: async () => ({ mode: "chat", protocol: 2, cursor: null, messages: [], busy: true }) };
  } });
  const focus = f.$("focus-terminal");
  assert.equal(focus.parentElement, f.$("session-title-pill"));
  assert.ok(focus.querySelector('svg[aria-hidden="true"]'));
  assert.equal(focus.getAttribute("aria-label"), "Switch to Terminal");
  focus.click();
  assert.equal(focus.disabled, true);
  assert.deepEqual(requests, [{}]);
  result.resolve({ ok: false, status: 400, json: async () => ({ error: "Kitty needs a local remote-control socket." }) });
  await tick();
  assert.equal(focus.disabled, false);
  assert.match(f.$("status").textContent, /Kitty needs a local remote-control socket/);
});

test("chat shortcuts toggle the panels and switch to Terminal without changing the composer draft", async (t) => {
  const terminal = Promise.withResolvers();
  const requests = [];
  const json = (data) => ({ ok: true, json: async () => data });
  const f = await fixture(t, { chatFetch: async (path, body) => {
    if (path === "/api/response") return json({ mode: "chat", protocol: 2, cursor: null, messages: [] });
    if (path === "/api/sessions") return json({ current: { id: "live", cwd: "/work" }, sessions: [] });
    if (path === "/api/activity") return json({ sessions: [] });
    assert.equal(path, "/api/session/focus-terminal");
    requests.push(body);
    return terminal.promise;
  } });
  const { document } = f.window;
  const press = (digit, options = {}) => {
    const event = new f.window.KeyboardEvent("keydown", {
      key: "!@#"[digit - 1], code: `Digit${digit}`, ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true, ...options,
    });
    document.activeElement.dispatchEvent(event);
    return event.defaultPrevented;
  };
  const input = f.$("chat-input");
  const left = f.$("chat-tools-toggle");
  const right = f.$("explorer-toggle");
  input.focus();
  input.value = "Keep my draft";
  assert.equal(press(2, { ctrlKey: false }), false);
  assert.equal(left.getAttribute("aria-expanded"), "true");
  assert.equal(press(2), true);
  assert.equal(left.getAttribute("aria-expanded"), "false");
  assert.equal(press(2, { repeat: true }), true);
  assert.equal(left.getAttribute("aria-expanded"), "false");
  assert.equal(press(2), true);
  assert.equal(left.getAttribute("aria-expanded"), "true");
  assert.equal(press(3), true);
  assert.equal(f.$("chat-explorer").hidden, false);
  assert.equal(document.activeElement, f.$("session-search-toggle"));
  assert.equal(press(3), true);
  assert.equal(f.$("chat-explorer").hidden, true);
  assert.equal(document.activeElement, right);
  const dialog = f.$("comment-dialog");
  dialog.showModal();
  f.$("comment").focus();
  assert.equal(press(1), false);
  dialog.close();
  input.focus();
  assert.equal(press(1, { isComposing: true }), false);
  assert.deepEqual(requests, []);
  assert.equal(press(1), true);
  press(1);
  assert.deepEqual(requests, [{}], "the terminal action cannot run twice while in progress");
  assert.equal(input.value, "Keep my draft");
  assert.equal(document.activeElement, input);
  terminal.resolve(json({}));
  await tick();
});

test("composer, sidebar, and dialog controls share the Switch to Terminal tooltip", async (t) => {
  const f = await fixture(t, { chatFetch: async () => ({ ok: true, json: async () => ({
    mode: "chat", protocol: 2, cursor: null, messages: [],
  }) }) });
  const hover = (id) => f.$(id).dispatchEvent(new f.window.MouseEvent("mouseenter"));
  const preview = () => f.$("message-preview");
  hover("focus-terminal");
  const tooltipClass = preview().className;
  const expand = f.$("chat-expand");
  const bottom = f.window.innerHeight;
  expand.getBoundingClientRect = () => ({ left: 60, right: 86, top: bottom - 40, bottom: bottom - 8 });
  hover("chat-expand");
  assert.equal(preview().className, tooltipClass);
  assert.equal(preview().textContent, "Expand message composer");
  assert.equal(preview().style.top, `${bottom - 48}px`, "near the bottom the tooltip opens above the control");
  expand.click();
  assert.equal(preview(), null);
  hover("chat-expand");
  assert.equal(preview().textContent, "Collapse message composer");
  assert.equal(expand.hasAttribute("title"), false);
  hover("chat-note-preview-toggle");
  assert.equal(preview().className, tooltipClass);
  assert.equal(preview().textContent, "Preview Markdown note");
  assert.equal(f.window.document.querySelectorAll("[title]").length, 0, "no native tooltips remain");
  const dialog = f.$("comment-dialog");
  dialog.showModal();
  f.$("comment-close").focus();
  assert.equal(preview().className, tooltipClass);
  assert.equal(preview().textContent, "Close annotation");
  assert.equal(preview().parentElement, dialog, "dialog tooltips render in the modal layer");
  f.window.document.dispatchEvent(new f.window.KeyboardEvent("keydown", { key: "Escape" }));
  assert.equal(preview(), null);
});

test("clicking the live chat title opens renaming and updates the browser tab", async (t) => {
  let sessionName = "Live browser chat feature with a long name that can be truncated in the sticky session pill";
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
  const title = f.$("session-title-text");
  const terminal = f.$("focus-terminal");
  assert.equal(pill.hidden, false);
  assert.equal(f.$("team-view-toggle").hidden, true, "servers without team support do not expose the Teams control");
  assert.deepEqual([...pill.querySelectorAll("button:not([hidden])")], [f.$("open-dashboard"), title, terminal, f.$("chat-tools-toggle"), f.$("explorer-toggle")]);
  assert.equal(title.getAttribute("aria-haspopup"), "dialog");
  assert.equal(title.getAttribute("aria-label"), `Rename ${sessionName}`);
  assert.equal(title.textContent, sessionName);
  assert.equal(f.window.document.title, `${sessionName} · ✓ Ready`);
  const preview = () => f.$("message-preview");
  title.dispatchEvent(new f.window.MouseEvent("mouseenter"));
  assert.equal(title.title, "");
  assert.equal(preview().className, "message-preview");
  assert.equal(preview().textContent, `${sessionName}\nClick to rename`);
  title.dispatchEvent(new f.window.MouseEvent("mouseleave"));
  assert.equal(preview(), null);
  assert.equal(terminal.hasAttribute("title"), false);
  terminal.getBoundingClientRect = () => ({ left: 60, right: 86, top: 14, bottom: 40 });
  terminal.focus();
  assert.equal(preview().textContent, "Switch to Terminal (Ctrl+Shift+1)");
  assert.equal(preview().className, "message-preview");
  assert.equal(preview().style.top, "48px");
  assert.equal(terminal.getAttribute("aria-describedby"), preview().id);
  terminal.blur();
  assert.equal(preview(), null);
  title.focus();
  title.click();
  const input = f.$("rename-session-input");
  assert.equal(f.$("rename-session-dialog").open, true);
  assert.equal(f.window.document.activeElement, input);
  assert.equal(input.value, sessionName);
  assert.equal(preview(), null);
  input.value = "Personal repository cleanup";
  const submitRename = () => f.$("rename-session-form").dispatchEvent(new f.window.Event("submit", { cancelable: true }));
  submitRename();
  await tick();
  assert.match(f.$("rename-session-status").textContent, /run \/reload/i, "a stale server explains how to enable renaming inside the dialog");
  submitRename();
  await tick();
  assert.equal(renamed, input.value);
  assert.equal(title.textContent, renamed);
  assert.equal(title.getAttribute("aria-label"), `Rename ${renamed}`);
  assert.equal(f.window.document.title, `${renamed} · ✓ Ready`);
  assert.equal(f.$("status").textContent, "Chat renamed.");
  title.focus();
  assert.equal(preview().textContent, `${renamed}\nClick to rename`);
  assert.equal(title.getAttribute("aria-describedby"), preview().id);
  title.blur();
  assert.equal(preview(), null);
});

test("a reply can start a named subchat without changing the parent draft", async (t) => {
  const submissions = [];
  const f = await fixture(t, { chatFetch: async (path, body) => {
    if (path === "/api/session/branch") {
      submissions.push(body);
      if (submissions.length === 1) return { ok: false, status: 409, json: async () => ({ error: "Try again." }) };
      return { ok: true, json: async () => ({ launched: true }) };
    }
    if (path === "/api/sessions") return { ok: true, json: async () => ({
      current: { id: "parent", cwd: "/work", name: "Stage Aura changes" },
      sessions: [
        { id: "child", cwd: "/work", name: "Fix Aura compile error", parentId: "parent" },
        { id: "nested", cwd: "/work", name: "Check the import", parentId: "child" },
        { id: "sibling", cwd: "/work", name: "Review staged changes", parentId: "parent" },
      ],
    }) };
    if (path === "/api/activity") return { ok: true, json: async () => ({ sessions: [] }) };
    return { ok: true, json: async () => ({ mode: "chat", protocol: 2, cursor: "later", busy: false, sessionName: "Stage Aura changes", messages: [
      { id: "target", role: "assistant", canBranch: true, ...renderMarkdown("Fix the missing import.") },
      { id: "later", role: "assistant", ...renderMarkdown("An intermediate reply without a branch action.") },
    ] }) };
  } });
  const input = f.$("chat-input");
  input.value = "Unsent draft";
  input.dispatchEvent(new f.window.Event("input"));
  const buttons = f.$("response").querySelectorAll('button[aria-label="Branch from here"]');
  assert.equal(buttons.length, 1);
  assert.ok(buttons[0].querySelector('svg[aria-hidden="true"]'));
  assert.equal(buttons[0].dataset.tooltip, "Branch from here");
  buttons[0].click();
  const dialog = f.$("branch-chat-dialog");
  const tryCancel = () => dialog.dispatchEvent(new f.window.Event("cancel", { cancelable: true }));
  assert.equal(dialog.open, true);
  assert.equal(dialog.querySelector("button"), null);
  assert.equal(dialog.querySelectorAll("input").length, 1, "Enter implicitly submits a single-input form");
  assert.equal(f.window.document.activeElement, f.$("branch-chat-name"));
  assert.equal(tryCancel(), true, "native Escape dismissal is allowed while idle");
  f.$("branch-chat-name").value = " Fix Aura compile error ";
  const submit = () => f.$("branch-chat-form").dispatchEvent(new f.window.Event("submit", { cancelable: true }));
  submit();
  submit();
  assert.equal(tryCancel(), false, "keep the dialog open while the create request is in flight");
  await tick();
  assert.equal(f.$("branch-chat-status").textContent, "Try again.");
  assert.equal(f.$("branch-chat-dialog").open, true);
  submit();
  await tick();
  assert.equal(f.$("branch-chat-dialog").open, false);
  assert.deepEqual(submissions, [{ replyId: "target", name: "Fix Aura compile error" }, { replyId: "target", name: "Fix Aura compile error" }]);
  const parentNode = f.$("session-list").querySelector(".session-tree-node");
  assert.equal(parentNode.querySelector(":scope > .session-row .session-open").textContent, "Stage Aura changes");
  const branches = parentNode.querySelector(":scope > .session-tree-children");
  assert.deepEqual([...branches.children].map((node) => node.querySelector(":scope > .session-row .session-open").textContent),
    ["Fix Aura compile error", "Review staged changes"]);
  assert.equal(branches.firstElementChild.querySelector(":scope > .session-tree-children .session-open").textContent, "Check the import");
  assert.equal(f.$("session-title-text").textContent, "Stage Aura changes");
  assert.equal(f.$("subchat-origin").hidden, true, "unbranched chats do not show the subtitle");
  assert.equal(input.value, "Unsent draft");
});

test("a subchat marks its fork point and opens the original reply in the parent transcript", async (t) => {
  const target = { id: "target", role: "assistant", ...renderMarkdown("Original reply") };
  const followup = { id: "followup", role: "user", ...renderMarkdown("Subchat follow-up") };
  const f = await fixture(t, { chatFetch: async (path) => {
    if (path === "/api/sessions") return { ok: true, json: async () => ({
      current: { id: "child", cwd: "/work", parentId: "parent" },
      sessions: [{ id: "parent", cwd: "/work", name: "Stage Aura changes" }],
    }) };
    if (path === "/api/session?id=parent") return { ok: true, json: async () => ({ messages: [target,
      { id: "later", role: "assistant", ...renderMarkdown("Later parent reply") },
    ] }) };
    return { ok: true, json: async () => ({ mode: "chat", protocol: 2, sessionName: "Fix Aura compile error", cursor: "followup", busy: false,
      messages: [target, followup], subchatOrigin: { replyId: "target", parentName: "Stage Aura changes" },
    }) };
  } });
  const divider = f.$("response").querySelector(".subchat-divider");
  assert.equal(divider.textContent, "Subchat starts here");
  assert.equal(divider.previousElementSibling.dataset.entryId, "target");
  assert.equal(divider.nextElementSibling.dataset.entryId, "followup");
  const subtitle = f.$("subchat-origin");
  const parentButton = f.$("subchat-parent");
  assert.equal(f.$("session-title-pill").nextElementSibling, subtitle);
  assert.equal(subtitle.hidden, false);
  assert.equal(subtitle.firstElementChild.textContent, "Branched from");
  assert.equal(f.$("subchat-parent-name").textContent, "Stage Aura changes");
  assert.equal(parentButton.querySelector('[aria-hidden="true"]').textContent, "↗");
  parentButton.click();
  await tick();
  assert.equal(subtitle.hidden, true);
  assert.equal(f.$("saved-title").textContent, "Stage Aura changes");
  assert.equal(f.window.document.activeElement.dataset.entryId, "target");
  assert.match(f.$("saved-response").textContent, /Later parent reply/);
  assert.equal(f.$("saved-response").querySelector(".reply-branch"), null);
  f.$("back-to-live").click();
  assert.equal(f.$("saved-conversation").hidden, true);
  assert.equal(subtitle.hidden, false);
  assert.equal(f.$("response").querySelector(".subchat-divider"), divider);
});

test("explorer groups chat branches and filters chats, then opens a saved transcript without losing the live draft", async (t) => {
  const calls = [];
  const longTitle = "Renovate updates for the important project with an extremely descriptive title";
  const f = await fixture(t, { chatFetch: async (path) => {
    calls.push(path);
    if (path === "/api/activity") return { ok: true, json: async () => ({ sessions: [{ id: "a", name: "Earlier live work", cwd: "/work/alpha" }] }) };
    if (path === "/api/sessions") return { ok: true, json: async () => ({
      current: { id: "current", name: "Live chat", cwd: "/work/alpha", canClone: true },
      sessions: [{ id: "a", name: "Earlier live work", cwd: "/work/alpha", parentId: "current", canClone: true }, { id: "b", name: longTitle, cwd: "/work/beta" }],
    }) };
    if (path === "/api/session/resume?id=b") return { ok: true, json: async () => ({ command: "cd -- '/work/beta' && pi --session '/store/b.jsonl'" }) };
    if (path === "/api/session/clone") return { ok: true, json: async () => ({ ok: true }) };
    if (path === "/api/session?id=b") return { ok: true, json: async () => ({
      messages: [{ id: "r1", role: "assistant", markdown: "**Saved reply**", ...renderMarkdown("**Saved reply**") }],
    }) };
    assert.match(path, /^\/api\/response/);
    return { ok: true, json: async () => ({
      mode: "chat", protocol: 2, sessionName: "Live chat", cursor: path.includes("?") ? "u2" : "u1", busy: false,
      messages: [{ id: path.includes("?") ? "u2" : "u1", role: "user", text: path.includes("?") ? "New live message" : "Live message" }],
    }) };
  } });
  assert.equal(f.$("chat-tools").hidden, false);
  const css = await readFile(new URL("../web/style.css", import.meta.url), "utf8");
  assert.match(css, /\.chat-page #chat-tools\[hidden\],[^{]+\{\s*display:\s*none;\s*\}/);
  assert.match(css, /\.chat-page \{[^}]*\/ minmax\(0, 1fr\) var\(--explorer-width, 0px\)/);
  assert.match(css, /#chat-explorer:not\(\[hidden\]\) \{ grid-area: 1 \/ 2;/);
  assert.match(css, /#chat-explorer:not\(\[hidden\]\) \{ grid-area: 2 \/ 1; justify-self: end;/);
  const input = f.$("chat-input");
  input.value = "Unsent live draft";
  input.dispatchEvent(new f.window.Event("input"));
  assert.deepEqual(calls, ["/api/response"], "the catalog is not fetched until the explorer opens");
  const explorerToggle = f.$("explorer-toggle");
  assert.equal(explorerToggle.textContent.trim(), "");
  assert.equal(explorerToggle.getAttribute("aria-label"), "Toggle chat explorer");
  assert.equal(explorerToggle.title, "");
  assert.equal(explorerToggle.dataset.tooltip, "Toggle chat explorer (Ctrl+Shift+3)");
  assert.ok(explorerToggle.querySelector('svg[aria-hidden="true"] rect'));
  assert.equal(explorerToggle.getAttribute("aria-controls"), "chat-explorer");
  assert.equal(explorerToggle.querySelector("svg path").getAttribute("d"), "M15 4v16");
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
  assert.ok(live.parentElement.querySelector('.session-indicator.live[aria-label="Live session"]'));
  const clone = live.parentElement.querySelector(".session-clone");
  assert.equal(clone.textContent, "🧬");
  assert.equal(clone.getAttribute("aria-label"), "Clone chat session Live chat");
  clone.dispatchEvent(new f.window.MouseEvent("mouseenter"));
  assert.equal(f.window.document.getElementById("message-preview").textContent, "Clone chat session Live chat");
  clone.dispatchEvent(new f.window.MouseEvent("mouseleave"));
  clone.click();
  await tick();
  assert.ok(calls.includes("/api/session/clone"));
  assert.equal(live.parentElement.querySelector(".session-copy"), null);
  const alphaGroup = list.querySelector('summary[data-tooltip="/work/alpha"]').parentElement;
  assert.equal(alphaGroup.querySelector(".session-tree-children .session-open").textContent, "Earlier live work");

  const refresh = f.$("refresh-sessions");
  assert.equal(refresh.textContent.trim(), "");
  assert.equal(refresh.getAttribute("aria-label"), "Refresh chats");
  assert.ok(refresh.querySelector("svg"));
  assert.equal(refresh.parentElement, f.$("project-view-controls"));
  const beta = list.querySelector('summary[data-tooltip="/work/beta"]');
  beta.click();
  await tick();
  assert.equal(beta.parentElement.open, false);
  const controls = f.$("project-view-controls");
  assert.equal(controls.parentElement.querySelector("label"), null);
  assert.ok(controls.parentElement.firstElementChild === controls, "view-mode pill replaces the old heading position");
  assert.equal(f.$("session-filter").getAttribute("aria-label"), "Search chats by name or directory");
  assert.ok(f.$("session-filter").closest(".session-search").querySelector('svg[aria-hidden="true"]'));
  assert.deepEqual([...controls.querySelectorAll("button")].map((button) => button.getAttribute("aria-label")), ["Collapse all", "Show current chat in explorer", "Expand all", "Refresh chats", "Search chats"]);
  assert.ok(controls.querySelector('[data-action="show-current"] svg path'));
  assert.ok(controls.querySelector('[data-action="show-current"] svg circle'));
  assert.equal(controls.querySelectorAll('svg[aria-hidden="true"]').length, 5);
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
  const searchToggle = f.$("session-search-toggle");
  const searchPanel = f.$("session-search");
  assert.equal(searchPanel.hidden, true);
  assert.equal(searchToggle.getAttribute("aria-expanded"), "false");
  assert.equal(searchToggle.getAttribute("aria-controls"), searchPanel.id);
  searchToggle.click();
  assert.equal(searchPanel.hidden, false);
  assert.equal(searchToggle.getAttribute("aria-expanded"), "true");
  assert.equal(f.window.document.activeElement, filter);
  const search = (value) => {
    filter.value = value;
    filter.dispatchEvent(new f.window.Event("input"));
  };
  search("BETA renovate");
  assert.equal(list.querySelector("details").open, true, "search reveals matches in a collapsed project");
  searchToggle.click();
  assert.equal(searchPanel.hidden, true);
  assert.equal(searchToggle.getAttribute("aria-expanded"), "false");
  assert.equal(filter.value, "");
  assert.equal(list.querySelector('summary[data-tooltip="/work/beta"]').parentElement.open, false);
  searchToggle.click();
  search("beta renovate");
  filter.dispatchEvent(new f.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  assert.equal(f.$("chat-explorer").hidden, false);
  assert.equal(searchPanel.hidden, true);
  assert.equal(filter.value, "");
  assert.equal(f.window.document.activeElement, searchToggle);
  searchToggle.click();
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
  assert.ok(copy.querySelector('svg[viewBox="0 0 24 24"] rect[x="8"][y="8"][width="13"][height="13"]'));
  assert.equal(copy.querySelector("svg path").getAttribute("d"), "M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3");
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
  f.$("chat-tools-toggle").click();
  saved.click();
  await tick();
  assert.equal(f.window.document.title, longTitle);
  assert.match(f.$("saved-directory").textContent, /Read-only · \/work\/beta/);
  assert.equal(f.$("saved-response").querySelector("strong").textContent, "Saved reply");
  assert.equal(f.$("saved-response").querySelector("[data-response-id]"), null);
  clipboard.writeText = async (text) => copied.push(text);
  f.$("saved-response").querySelector('[aria-label="Copy response"]').click();
  await tick();
  assert.equal(copied.at(-1), "**Saved reply**");
  assert.equal(f.$("saved-status").textContent, "Response copied.");
  assert.equal(f.$("conversation").hidden, true);
  assert.equal(f.$("chat-tools").hidden, true);
  const heading = f.$("session-title-pill").parentElement;
  assert.equal(f.$("session-title-pill").hidden, false);
  assert.equal(heading.parentElement, f.window.document.querySelector("main"), "saved chat keeps its title above the transcript");
  assert.equal(f.$("saved-title").textContent, longTitle);
  assert.equal(f.$("saved-title").hidden, false);
  for (const id of ["session-title-text", "focus-terminal", "chat-tools-toggle"]) assert.equal(f.$(id).hidden, true);
  explorerToggle.click();
  assert.equal(f.$("chat-explorer").hidden, true);
  explorerToggle.click();
  assert.equal(f.$("chat-explorer").hidden, false);
  assert.equal(searchPanel.hidden, true);
  assert.equal(filter.value, "");
  assert.equal(f.window.document.querySelector("main").classList.contains("chat-tools-collapsed"), true);
  assert.equal(f.$("chat-send").disabled, true);
  await f.poll();
  assert.equal(f.window.document.title, longTitle);
  assert.match(f.$("response").textContent, /New live message/);

  f.$("back-to-live").click();
  assert.equal(f.window.document.title, "Live chat · ✓ Ready");
  assert.equal(f.$("conversation").hidden, false);
  assert.equal(f.$("chat-tools").hidden, false);
  assert.equal(f.window.document.querySelector("main").classList.contains("chat-tools-collapsed"), true);
  assert.equal(f.$("saved-conversation").hidden, true);
  assert.equal(f.$("saved-title").hidden, true);
  assert.equal(f.$("chat-form").previousElementSibling, heading, "the live controls return to the message side of the composer divider");
  for (const id of ["session-title-text", "focus-terminal", "chat-tools-toggle"]) assert.equal(f.$(id).hidden, false);
  assert.equal(input.value, "Unsent live draft");
  assert.equal(f.$("chat-send").disabled, false);
  assert.equal(calls.some((path) => path === "/api/chat"), false);
});

test("saved-chat launch leaves the live composer alone and refresh drops a deleted duplicate", async (t) => {
  const cwd = "/work/pi-chat";
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

test("both chat panels resize independently and restore their preferred widths", async (t) => {
  const chatFetch = async (path) => ({ ok: true, json: async () => path === "/api/response"
    ? { mode: "chat", protocol: 2, cursor: null, messages: [], busy: false }
    : { current: { id: "current", cwd: "/project" }, sessions: [] } });
  const f = await fixture(t, { chatFetch, setupWindow: (window) => { window.innerWidth = 1600; } });
  const { window, $ } = f;
  const left = $("chat-tools-resize");
  const right = $("chat-explorer-resize");
  const width = (panel) => window.document.body.style.getPropertyValue(`--${panel}-size`);
  const pointer = (handle, type, clientX, pointerId = 1) => {
    const event = new window.MouseEvent(type, { clientX, cancelable: true });
    Object.defineProperty(event, "pointerId", { value: pointerId });
    handle.dispatchEvent(event);
  };
  const drag = (handle, from, to) => {
    handle.setPointerCapture = (id) => assert.equal(id, 1);
    pointer(handle, "pointerdown", from);
    pointer(handle, "pointermove", 0, 2);
    pointer(handle, "pointermove", to);
    pointer(handle, "pointerup", to);
  };
  assert.equal($("chat-explorer").hidden, true);
  $("explorer-toggle").click();
  assert.equal($("chat-explorer").hidden, false);
  drag(left, 339, 419);
  assert.equal(width("chat-tools"), "420px");
  assert.equal(width("chat-explorer"), "280px");
  drag(right, 1321, 1121);
  assert.equal(width("chat-explorer"), "480px");
  assert.equal(right.getAttribute("aria-valuenow"), "480");
  right.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowRight", cancelable: true }));
  assert.equal(width("chat-explorer"), "464px");
  $("chat-tools-toggle").click();
  $("chat-tools-toggle").click();
  assert.equal(width("chat-tools"), "420px");
  window.innerWidth = 800;
  window.dispatchEvent(new window.Event("resize"));
  assert.equal(width("chat-tools"), "240px");
  assert.equal(width("chat-explorer"), "240px");

  const restored = await fixture(t, { chatFetch, setupWindow(restoredWindow) {
    restoredWindow.innerWidth = 1600;
    for (const panel of ["chat-tools", "chat-explorer"]) {
      const key = `pi-chat:${panel}-width`;
      restoredWindow.localStorage.setItem(key, window.localStorage.getItem(key));
    }
  } });
  assert.equal(restored.$("chat-tools-resize").getAttribute("aria-valuenow"), "420");
  assert.equal(restored.$("chat-explorer-resize").getAttribute("aria-valuenow"), "464");
});

test("Markdown notes persist per chat, preview safely, and copy their source", async (t) => {
  const sessionId = "note-session";
  const notes = new Map([[sessionId, "# Saved snippet"]]);
  const fetchForSession = (id) => async (path, body) => {
    if (path === "/api/response") return { ok: true, json: async () => ({ mode: "chat", protocol: 2, sessionId: id, cursor: null, messages: [], busy: false }) };
    if (path === "/api/note") {
      if (body !== undefined) { notes.set(id, body.markdown); return { ok: true, json: async () => ({ ok: true }) }; }
      return { ok: true, json: async () => ({ markdown: notes.get(id) ?? "" }) };
    }
    if (path === "/api/markdown") return { ok: true, json: async () => renderMarkdown(body.markdown) };
    throw new Error(`Unexpected chat request: ${path}`);
  };
  const fetchChat = fetchForSession(sessionId);
  const f = await fixture(t, { chatFetch: fetchChat });
  await tick();
  const note = f.$("chat-note-input");
  assert.equal(f.$("chat-note").hidden, false);
  assert.equal(f.$("chat-note").parentElement, f.$("annotations-panel").parentElement);
  assert.notEqual(f.$("chat-note").parentElement, f.$("annotations-panel"));
  assert.equal(f.$("chat-note-preview-toggle").textContent.trim(), "");
  assert.equal(f.$("chat-note-copy").textContent.trim(), "");
  const panelToggle = f.$("chat-tools-toggle");
  assert.equal(panelToggle.getAttribute("aria-controls"), "chat-tools");
  assert.equal(panelToggle.querySelector("svg path").getAttribute("d"), "M9 4v16");
  assert.equal(panelToggle.getAttribute("aria-expanded"), "true");
  panelToggle.click();
  assert.equal(panelToggle.getAttribute("aria-expanded"), "false");
  assert.equal(panelToggle.getAttribute("aria-label"), "Expand notes and annotations");
  assert.equal(panelToggle.dataset.tooltip, "Expand notes and annotations (Ctrl+Shift+2)");
  assert.equal(f.window.document.querySelector("main").classList.contains("chat-tools-collapsed"), true);
  assert.equal(f.$("annotations-panel").hidden, false);
  assert.equal(note.value, "# Saved snippet", "collapsing preserves the note draft");
  panelToggle.click();
  assert.equal(f.window.document.querySelector("main").classList.contains("chat-tools-collapsed"), false);
  const expandNote = f.$("chat-note-expand");
  const noteBox = f.$(expandNote.getAttribute("aria-controls"));
  const preview = f.$("chat-note-preview");
  assert.ok(noteBox.contains(note) && noteBox.contains(preview));
  assert.equal(expandNote.closest(".chat-note-actions"), f.$("chat-note-preview-toggle").parentElement);
  expandNote.click();
  assert.equal(expandNote.getAttribute("aria-expanded"), "true");
  assert.equal(expandNote.getAttribute("aria-label"), "Collapse Markdown note");
  assert.equal(f.$("chat-note-dialog").open, true);
  assert.equal(f.$("chat-note").parentElement, f.$("chat-note-dialog"));
  expandNote.click();
  assert.equal(f.$("chat-note-dialog").open, false);
  assert.equal(f.$("chat-note").parentElement, f.$("chat-tools-content"));
  assert.equal(expandNote.getAttribute("aria-expanded"), "false");
  const css = await readFile(new URL("../web/style.css", import.meta.url), "utf8");
  assert.match(css, /main\.chat-tools-collapsed #chat-tools\s*\{\s*display:\s*none;/);
  assert.match(css, /\.chat-page main \{[^}]*grid-template-columns: \[tools\][^;]+\[rail\][^;]+\[transcript\]/);
  assert.match(css, /\.chat-page #chat-tools \{[^}]*grid-area: 1 \/ tools \/ -1 \/ rail;/);
  assert.match(css, /\.chat-page #chat-tools \{ grid-area: 5 \/ 1 \/ auto \/ -1;/);
  assert.match(css, /#chat-note-dialog \{[^}]*width: 80vw; height: 80dvh/);
  assert.match(css, /#chat-tools-content \{[^}]*grid-template-columns: minmax\(0, 1fr\)/);
  assert.equal(note.value, "# Saved snippet");
  const longLine = "wide code ".repeat(200).trimEnd();
  note.value = `# Reusable\n\n**Prompt text** <script>bad()</script>\n\n\`\`\`\n${longLine}\n\`\`\`\n\n${"More text.\n\n".repeat(80)}End of note.`;
  note.dispatchEvent(new f.window.Event("input"));
  note.dispatchEvent(new f.window.Event("blur"));
  await tick();
  assert.equal(notes.get(sessionId), note.value);
  f.$("chat-note-preview-toggle").click();
  await tick();
  assert.equal(note.hidden, true);
  assert.ok(preview.querySelector("h1"));
  assert.equal(preview.querySelector("script"), null);
  assert.equal(preview.querySelector("pre code").textContent.trimEnd(), longLine);
  assert.equal(expandNote.hidden, false);
  expandNote.click();
  assert.equal(f.$("chat-note-dialog").open, true);
  assert.equal(preview.hidden, false, "expansion retains preview mode");
  assert.equal(preview.lastElementChild.textContent, "End of note.");
  expandNote.click();
  assert.equal(f.$("chat-note-dialog").open, false);
  assert.equal(preview.hidden, false, "collapsing retains preview mode");
  f.$("chat-note-preview-toggle").click();
  assert.equal(note.hidden, false);
  const copied = [];
  Object.defineProperty(f.window.navigator, "clipboard", { value: { writeText: async (text) => copied.push(text) } });
  f.$("chat-note-copy").click();
  await tick();
  assert.deepEqual(copied, [note.value]);

  const reopened = await fixture(t, { chatFetch: fetchChat });
  await tick();
  assert.equal(reopened.$("chat-note-input").value, note.value);
  assert.equal(reopened.$("chat-input").value, "", "the note is separate from the message draft");
  const isolated = await fixture(t, { chatFetch: fetchForSession("another-session") });
  await tick();
  assert.equal(isolated.$("chat-note-input").value, "", "notes are scoped to their Pi session ID");
});

test("Markdown notes paste images and pick files, then reopen with saved attachments", async (t) => {
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgZGIGAAAOAAfXb+R4AAAAAElFTkSuQmCC";
  const firstSave = Promise.withResolvers();
  let attachments = [];
  let rejectRemoval = true;
  const chatFetch = async (path, body) => {
    const json = (data, ok = true) => ({ ok, json: async () => data });
    if (path === "/api/response") return json({ mode: "chat", protocol: 2, sessionId: "note-session", cursor: null, messages: [] });
    if (path === "/api/note" && !body) return json({ markdown: "Notes", attachments });
    if (path === "/api/note/attachments") {
      if (attachments.length === 0) await firstSave.promise;
      if (body.attachments.length < attachments.length && rejectRemoval) return json({ error: "Could not remove file." }, false);
      attachments = body.attachments;
      return json({ ok: true });
    }
    assert.fail(`Unexpected chat request: ${path}`);
  };
  const f = await fixture(t, { chatFetch });
  await tick();
  const { window: w, $ } = f;
  const input = $("chat-note-input");
  const file = $("chat-note-file");
  const list = $("chat-note-attachments");
  const waitForCount = (count) => new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { observer.disconnect(); reject(new Error(`Expected ${count} note attachments`)); }, 1000);
    const observer = new w.MutationObserver(() => {
      if (list.children.length !== count) return;
      clearTimeout(timeout);
      observer.disconnect();
      resolve();
    });
    observer.observe(list, { childList: true });
  });
  const textPaste = new w.Event("paste", { cancelable: true });
  input.dispatchEvent(textPaste);
  assert.equal(textPaste.defaultPrevented, false);
  const pasted = waitForCount(1);
  const imagePaste = new w.Event("paste", { cancelable: true });
  Object.defineProperty(imagePaste, "clipboardData", { value: { files: [new w.File([Buffer.from(png, "base64")], "screenshot.png", { type: "image/png" })] } });
  input.dispatchEvent(imagePaste);
  assert.equal(imagePaste.defaultPrevented, true);
  assert.equal($("chat-note-attach").disabled, true);
  const unload = new w.Event("beforeunload", { cancelable: true });
  w.dispatchEvent(unload);
  assert.equal(unload.defaultPrevented, true);
  firstSave.resolve();
  await pasted;
  $("chat-note-expand").click();
  list.querySelector('[aria-label="Preview screenshot.png"]').click();
  assert.equal($("image-preview").open, true);
  assert.equal($("preview-image").src, `data:image/png;base64,${png}`);
  $("close-preview").click();
  assert.equal($("chat-note-dialog").open, true);

  let pickerOpens = 0;
  file.addEventListener("click", (event) => { pickerOpens++; event.preventDefault(); });
  $("chat-note-attach").click();
  assert.equal(pickerOpens, 1);
  const picked = waitForCount(2);
  Object.defineProperty(file, "files", { value: [new w.File(["code"], "Example.java")] });
  file.dispatchEvent(new w.Event("change"));
  await picked;
  assert.equal(input.value, "Notes");
  assert.equal($("chat-attachments").hidden, true);
  assert.equal($("chat-send").disabled, true);
  const settled = new w.Event("beforeunload", { cancelable: true });
  w.dispatchEvent(settled);
  assert.equal(settled.defaultPrevented, false);

  const reopened = await fixture(t, { chatFetch });
  await tick();
  const saved = reopened.$("chat-note-attachments");
  const download = saved.querySelector('[aria-label="Download Example.java"]');
  assert.equal(download.download, "Example.java");
  assert.equal(download.href, "data:application/octet-stream;base64,Y29kZQ==");
  assert.equal(saved.children.length, 2);
  const remove = saved.querySelector('[aria-label="Remove screenshot.png"]');
  remove.click();
  await tick();
  assert.equal(saved.children.length, 2, "a failed save leaves the attachment intact");
  assert.match(reopened.$("chat-note-attachments-status").textContent, /Could not remove/);
  rejectRemoval = false;
  remove.click();
  await tick();
  assert.equal(saved.querySelector("img"), null);
  assert.deepEqual(attachments.map(({ name }) => name), ["Example.java"]);
  const trash = saved.querySelector('[aria-label="Remove Example.java"]');
  assert.ok(trash.querySelector('svg[aria-hidden="true"]'));
  assert.equal(trash.textContent.trim(), "");
  trash.click();
  await tick();
  assert.equal(saved.hidden, true);
  assert.deepEqual(attachments, []);
});

test("Markdown note autosave coalesces edits and serializes writes; close includes the current draft", async (t) => {
  const firstSave = Promise.withResolvers();
  const saves = [];
  const closes = [];
  const f = await fixture(t, { chatFetch: async (path, body, { keepalive }) => {
    const json = (data) => ({ ok: true, json: async () => data });
    if (path === "/api/response") return json({ mode: "chat", protocol: 2, sessionId: "session-1", cursor: null, messages: [] });
    if (path === "/api/note") {
      if (!body) return json({ markdown: "Saved" });
      saves.push(body.markdown);
      if (saves.length === 1) await firstSave.promise;
    } else if (path === "/api/close") closes.push({ body, keepalive });
    else assert.fail(`Unexpected path: ${path}`);
    return json({ ok: true });
  } });
  await tick();
  const note = f.$("chat-note-input");
  const edit = (markdown) => {
    note.value = markdown;
    note.dispatchEvent(new f.window.Event("input"));
  };
  edit("First keystroke");
  edit("First draft");
  f.autosave();
  await tick();
  assert.deepEqual(saves, ["First draft"]);
  edit("Second draft");
  f.autosave();
  await tick();
  assert.deepEqual(saves, ["First draft"], "wait for the preceding write");
  firstSave.resolve();
  await tick();
  assert.deepEqual(saves, ["First draft", "Second draft"]);

  edit("Draft not yet autosaved");
  f.window.dispatchEvent(new f.window.Event("pagehide"));
  assert.deepEqual(closes, [{ body: { markdown: "Draft not yet autosaved" }, keepalive: true }]);
});

test("chat stays usable and leaves saved notes untouched if an older listener cannot serve the notes module", async (t) => {
  const posts = [];
  const f = await fixture(t, {
    loadNotes: async () => { throw new TypeError("Failed to fetch dynamically imported module"); },
    chatFetch: async (path, body) => {
      if (path === "/api/response") return { ok: true, json: async () => ({ mode: "chat", protocol: 2, sessionId: "session-1", cursor: null, messages: [] }) };
      posts.push({ path, body });
      return { ok: true, json: async () => ({ ok: true }) };
    },
  });
  assert.equal(f.$("chat-form").hidden, false);
  assert.equal(f.$("chat-note-box").hidden, true);
  assert.match(f.$("chat-note-status").textContent, /\/reload/);
  const composer = f.$("chat-input");
  composer.value = "Message still works";
  composer.dispatchEvent(new f.window.Event("input"));
  f.$("chat-send").click();
  await tick();
  f.window.dispatchEvent(new f.window.Event("pagehide"));
  assert.deepEqual(posts.map(({ path }) => path), ["/api/chat", "/api/close"]);
  assert.equal(posts[0].body.text, "Message still works");
  assert.deepEqual(posts[1].body, {});
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
  assert.equal(f.$("chat-send").textContent, "💬");
  assert.equal(f.$("save-annotation").querySelector("svg path").getAttribute("d"), "m5 12 4 4L19 6");
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

test("the composer stops its active reply and restores text and attachments before resending", async (t) => {
  const calls = [];
  const json = (data) => ({ ok: true, json: async () => data });
  let busy = false;
  let stoppableRequestId;
  let completeStop;
  const f = await fixture(t, { chatFetch: async (path, body) => {
    if (path.startsWith("/api/response")) return json({ mode: "chat", protocol: 2, cursor: null, messages: [], busy, stoppableRequestId });
    assert.ok(["/api/chat", "/api/chat/stop"].includes(path), path);
    calls.push({ path, body });
    if (path === "/api/chat/stop") return new Promise((resolve) => {
      completeStop = () => { stoppableRequestId = undefined; resolve(json({ ok: true })); };
    });
    busy = true;
    stoppableRequestId = body.requestId;
    return json({ ok: true, stoppableRequestId });
  } });
  const { window, $ } = f;
  const input = $("chat-input");
  const action = $("chat-send");
  const original = "  First draft\nwith a file.  ";
  const enter = () => input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", cancelable: true }));
  const list = $("chat-attachments");
  const attached = new Promise((resolve) => {
    const observer = new window.MutationObserver(() => {
      if (list.children.length) { observer.disconnect(); resolve(); }
    });
    observer.observe(list, { childList: true });
  });
  const paste = new window.Event("paste", { cancelable: true });
  Object.defineProperty(paste, "clipboardData", { value: { files: [new window.File(["note"], "note.txt")] } });
  input.dispatchEvent(paste);
  await attached;
  input.value = original;
  input.dispatchEvent(new window.Event("input"));
  action.click();
  await tick();
  const first = calls[0].body;
  assert.equal(first.text, original.trim());
  assert.equal(action.textContent, "✍️");
  assert.equal(action.type, "button");
  action.focus();
  assert.equal(window.document.querySelector('[role="tooltip"]').textContent, "Stop and edit");
  assert.equal(input.readOnly, true);
  enter();
  assert.equal(calls.length, 1, "Enter in the composer is not a stop shortcut");
  action.click();
  assert.equal(action.disabled, true);
  assert.equal(input.value, "", "the draft isn't restored until Pi acknowledges the stop");
  assert.deepEqual(calls[1], { path: "/api/chat/stop", body: { requestId: first.requestId } });
  completeStop();
  await tick();
  assert.equal(calls.length, 2, "restoring a draft never submits it");
  assert.equal(input.value, original);
  assert.equal(window.document.activeElement, input);
  assert.equal(input.selectionStart, original.length);
  assert.ok(list.querySelector('[aria-label="Remove note.txt"]'));
  assert.equal(action.textContent, "💬");
  assert.equal(action.disabled, true, "wait for the idle poll before resending");
  assert.equal(input.readOnly, false);

  busy = false;
  await f.poll();
  input.value = "Revised draft";
  enter();
  await tick();
  assert.equal(calls[2].body.text, "Revised draft");
  assert.deepEqual(calls[2].body.attachments, first.attachments);
  assert.notEqual(calls[2].body.requestId, first.requestId);
  busy = false;
  stoppableRequestId = undefined;
  await f.poll();
  assert.equal(action.textContent, "💬");
  assert.equal(input.value, "", "a normally completed reply does not restore its draft");
});

test("queued annotation questions render Markdown without changing their quote or source", async (t) => {
  const quote = "<b>Passage</b>";
  const question = "Why `Downloads`?\n\n- **First**\n- Second\n\n<script>bad()</script>";
  const fallback = "`Still editable`";
  const sent = [];
  const f = await fixture(t, { chatFetch: async (path, body) => {
    if (path === "/api/response") return { ok: true, json: async () => ({
      mode: "chat", protocol: 2, cursor: "a1", busy: false,
      messages: [{ id: "a1", role: "assistant", ...renderMarkdown(quote) }],
    }) };
    if (path === "/api/markdown") return body.markdown === fallback
      ? { ok: false, status: 503, json: async () => ({ error: "Unavailable" }) }
      : { ok: true, json: async () => renderMarkdown(body.markdown) };
    assert.equal(path, "/api/chat");
    sent.push(body.annotations[0]);
    return { ok: true, json: async () => ({ ok: true }) };
  } });
  const list = f.$("annotations");
  const preview = () => list.querySelector(".annotation-comment");
  f.select(0, quote.length, f.$("response").querySelector("[data-response-id]"));
  f.$("annotate-selection").click();
  f.add(question);
  await tick();
  assert.equal(list.querySelector("blockquote").textContent, quote);
  assert.equal(list.querySelector("blockquote b"), null);
  assert.equal(preview().querySelector("code").textContent, "Downloads");
  assert.equal(preview().querySelector("li strong").textContent, "First");
  assert.match(preview().textContent, /<script>bad\(\)<\/script>/);
  assert.equal(preview().querySelector("script"), null);
  assert.equal(sent.length, 0);
  list.querySelector('[aria-label="Edit annotation"]').click();
  assert.equal(f.$("comment").value, question);
  f.add(fallback);
  await tick();
  assert.equal(preview().textContent, fallback, "a render failure leaves the source readable");
  f.$("send").click();
  await tick();
  assert.deepEqual(sent, [{ responseId: "a1", start: 0, end: quote.length, quote, comment: fallback }]);
  assert.equal(list.children.length, 0);
});

test("sending either draft leaves the other one unsent", async (t) => {
  const posts = [];
  const reply = { id: "a1", role: "assistant", ...renderMarkdown("Some answer.") };
  const f = await fixture(t, { chatFetch: async (path, body) => {
    if (path === "/api/markdown") return { ok: true, json: async () => renderMarkdown(body.markdown) };
    if (body) posts.push(body);
    return { ok: true, json: async () => body ? { ok: true } : {
      mode: "chat", protocol: 2, cursor: reply.id, messages: path.includes("?") ? [] : [reply], busy: false,
    } };
  } });
  const input = f.$("chat-input");
  const write = (text) => { input.value = text; input.dispatchEvent(new f.window.Event("input")); };
  write("Ordinary message");
  f.select(0, 4, f.$("response").querySelector('[data-response-id="a1"]'));
  f.$("annotate-selection").click();
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

test("browser chat previews pasted SVGs as PNG and retains mixed attachments on send failure", async (t) => {
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
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="4096" height="2048"/>';
  w.Image = class {
    naturalWidth = 4096;
    naturalHeight = 2048;
    async decode() {
      assert.equal(this.src, `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`);
    }
  };
  w.HTMLCanvasElement.prototype.getContext = () => ({ drawImage() {} });
  const src = `data:image/png;base64,${png}`;
  w.HTMLCanvasElement.prototype.toDataURL = function (type) {
    assert.equal(type, "image/png");
    assert.deepEqual([this.width, this.height], [2048, 1024]);
    return src;
  };
  const pasted = waitForFileCount(1);
  const event = new w.Event("paste", { cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: { files: [new w.File([svg], "diagram.SVG")] } });
  input.dispatchEvent(event);
  assert.equal(event.defaultPrevented, true);
  await pasted;
  assert.deepEqual(filenames(), ["diagram.SVG"]);
  const preview = list.querySelector('[aria-label="Preview diagram.SVG"]');
  assert.equal(preview.querySelector("img").src, src);
  preview.click();
  assert.equal(f.$("image-preview").open, true);
  assert.equal(f.$("preview-image").src, src);
  const closePreview = f.$("close-preview");
  assert.equal(closePreview.parentElement, f.$("preview-title").parentElement);
  assert.equal(closePreview.getAttribute("aria-label"), "Close image preview");
  assert.ok(closePreview.querySelector('svg[aria-hidden="true"]'));
  assert.equal(f.$("image-preview").querySelectorAll("button").length, 1);
  closePreview.click();
  assert.equal(f.$("image-preview").open, false);
  assert.equal(f.$("preview-image").hasAttribute("src"), false);
  const picked = waitForFileCount(4);
  Object.defineProperty(file, "files", { value: [
    new w.File(["picked"], "picked.png", { type: "image/png" }),
    new w.File(["draft"], "draft.txt"),
    new w.File(["code"], "Example.java"),
  ] });
  file.dispatchEvent(new w.Event("change"));
  await picked;
  assert.deepEqual(filenames(), ["diagram.SVG", "picked.png", "draft.txt", "Example.java"]);
  const removeFile = list.querySelector('.file-attachment [aria-label="Remove draft.txt"]');
  assert.equal(removeFile.textContent, "×");
  removeFile.click();
  assert.deepEqual(filenames(), ["diagram.SVG", "picked.png", "Example.java"]);
  const removeImage = list.querySelector('[aria-label="Remove picked.png"]');
  assert.equal(removeImage.textContent, "×");
  removeImage.click();
  assert.equal(f.$("image-preview").open, false);
  assert.deepEqual(filenames(), ["diagram.SVG", "Example.java"]);
  assert.equal(list.querySelectorAll("img").length, 1);
  assert.equal(posts.length, 0);
  assert.equal(f.$("chat-send").disabled, false);
  f.$("chat-send").click();
  await tick();
  assert.match(f.$("status").textContent, /Pi is busy/);
  assert.deepEqual(filenames(), ["diagram.SVG", "Example.java"]);
  f.$("chat-send").click();
  await tick();
  assert.equal(posts[0].text, "", "attachment-only sends are allowed");
  assert.deepEqual(posts[0].attachments, [
    { name: "diagram.SVG", mimeType: "image/png", data: png },
    { name: "Example.java", mimeType: "", data: "Y29kZQ==" },
  ]);
  assert.deepEqual(posts[0], posts[1]);
  assert.equal(list.hidden, true);
});

test("dropping a log on the composer keeps the draft and waits for Send", async (t) => {
  const posts = [];
  const f = await fixture(t, { chatFetch: async (path, body) => {
    if (path === "/api/response") return { ok: true, json: async () => ({ mode: "chat", protocol: 2, cursor: null, messages: [], busy: false }) };
    posts.push(body);
    return { ok: true, json: async () => ({ ok: true }) };
  } });
  const w = f.window;
  const input = f.$("chat-input");
  const list = f.$("chat-attachments");
  input.value = "Find the first failure";
  input.setSelectionRange(8, 8);
  const attachmentsReady = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { observer.disconnect(); reject(new Error("Dropped file was not attached")); }, 1000);
    const observer = new w.MutationObserver(() => {
      if (!list.children.length) return;
      clearTimeout(timeout);
      observer.disconnect();
      resolve();
    });
    observer.observe(list, { childList: true });
  });
  const log = "a".repeat(513 * 1024);
  const dispatchDrag = (type, dataTransfer) => {
    const event = new w.Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
    input.dispatchEvent(event);
    return event;
  };
  assert.equal(dispatchDrag("dragover", { types: ["text/plain"] }).defaultPrevented, false);
  const dragOver = { types: ["Files"], files: [] };
  assert.equal(dispatchDrag("dragover", dragOver).defaultPrevented, true);
  assert.equal(dragOver.dropEffect, "copy");
  assert.equal(dispatchDrag("drop", { types: ["Files"], files: [new w.File([log], "consoleText")] }).defaultPrevented, true);
  await attachmentsReady;
  assert.match(list.textContent, /consoleText/);
  assert.equal(input.value, "Find the first failure");
  assert.equal(w.document.activeElement, input);
  assert.equal(input.selectionStart, 8);
  assert.equal(posts.length, 0);
  input.value += " and summarize it";
  input.dispatchEvent(new w.Event("input"));
  f.$("chat-send").click();
  await tick();
  assert.equal(posts.length, 1);
  assert.equal(posts[0].text, "Find the first failure and summarize it");
  assert.deepEqual(posts[0].attachments, [{ name: "consoleText", mimeType: "", data: Buffer.from(log).toString("base64") }]);
});

test("rejected composer drops explain the problem without changing the draft", async (t) => {
  const f = await fixture(t, { chatFetch: async (path) => {
    assert.equal(path, "/api/response");
    return { ok: true, json: async () => ({ mode: "chat", protocol: 2, cursor: null, messages: [], busy: false }) };
  } });
  const w = f.window;
  const input = f.$("chat-input");
  const alert = f.$("chat-attachment-error");
  const list = f.$("chat-attachments");
  input.value = "Edit the original SVG";
  assert.equal(alert.getAttribute("role"), "alert");
  assert.ok(f.$("chat-form").contains(alert));

  function drop(files) {
    const event = new w.Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", { value: { types: ["Files"], files } });
    input.dispatchEvent(event);
    assert.equal(event.defaultPrevented, true);
  }

  drop([]);
  assert.match(alert.textContent, /No file was available from the drop/);
  drop([new w.File([new Uint8Array(5 * 1024 * 1024 + 1)], "components.svg", { type: "image/svg+xml" })]);
  await tick();
  assert.match(alert.textContent, /components\.svg exceeds the 5 MiB per-file limit/);
  assert.match(alert.textContent, /paste its full path/);
  assert.equal(input.value, "Edit the original SVG");
  assert.equal(list.hidden, true);
  assert.equal(f.$("chat-send").disabled, false);

  const attachmentReady = new Promise((resolve, reject) => {
    const observer = new w.MutationObserver(() => {
      if (!list.children.length) return;
      clearTimeout(timeout);
      observer.disconnect();
      resolve();
    });
    const timeout = setTimeout(() => {
      observer.disconnect();
      reject(new Error("Dropped reference was not attached"));
    }, 1000);
    observer.observe(list, { childList: true });
  });
  drop([new w.File(["notes"], "reference.txt")]);
  assert.equal(alert.textContent, "");
  await attachmentReady;
  assert.match(list.textContent, /reference\.txt/);
});

test("live annotations can paste and pick images, edit them, and retry without touching the composer", async (t) => {
  const posts = [];
  const f = await fixture(t, { chatFetch: async (path, body) => {
    if (path === "/api/response") return { ok: true, json: async () => ({
      mode: "chat", protocol: 2, annotationImages: true, cursor: "a1", busy: false,
      messages: [{ id: "a1", role: "assistant", ...renderMarkdown("Choose a **passage**.") }],
    }) };
    if (path === "/api/markdown") return { ok: true, json: async () => renderMarkdown(body.markdown) };
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
  f.$("annotate-selection").click();
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
  const comment = f.$("comment");
  comment.value = "What is this?";
  const enter = (modifiers = {}) => comment.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Enter", cancelable: true, ...modifiers }));
  assert.equal(enter({ shiftKey: true }), true, "Shift+Enter remains available for newlines");
  assert.equal(enter({ isComposing: true }), true, "Enter can finish composing text without saving");
  assert.equal(enter({ repeat: true }), false, "holding Enter must not save a draft");
  assert.equal(f.$("annotations").children.length, 0);
  assert.equal(enter(), false);
  assert.equal(f.$("comment-dialog").open, false);
  assert.equal(f.$("annotations").querySelectorAll("img").length, 2);
  assert.equal(posts.length, 0, "saving the annotation does not send the batch");
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

test("mismatched assistant HTML fails closed as inert text", async (t) => {
  const f = await fixture(t, { chatFetch: async () => ({ ok: true, json: async () => ({
    mode: "chat", protocol: 2, cursor: "reply", busy: false,
    messages: [{ id: "reply", role: "assistant", text: "Expected reply", html: "<script>bad()</script>" }],
  }) }) });
  assert.match(f.$("response").textContent, /could not be rendered safely/);
  assert.equal(f.$("response").querySelector("script"), null);
});
