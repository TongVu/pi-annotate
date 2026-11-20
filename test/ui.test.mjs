import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
import { renderMarkdown } from "../src/markdown.ts";
import { validateAnnotations } from "../src/annotations.ts";

async function fixture(t, { failFirst = false, markdown = "A reactor module.\n<script>alert('bad')</script>", corruptText = false, legacyServer = false, chatFetch } = {}) {
  const html = await readFile(new URL("../web/index.html", import.meta.url), "utf8");
  const source = await readFile(new URL("../web/app.js", import.meta.url), "utf8");
  const dom = new JSDOM(html, { url: "http://127.0.0.1:12345/#test-token", runScripts: "outside-only" });
  t.after(() => dom.window.close());
  const { window } = dom;
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
  f.$("cancel").click();
  assert.equal(f.$("annotations").children.length, 0);
  f.select(2, 9);
  f.add("First question");
  f.select(10, 16);
  f.add("Second question");
  f.$("annotations").querySelector("button").click();
  assert.equal(f.$("comment").value, "First question");
  f.add("Edited question");
  f.$("annotations").lastElementChild.querySelectorAll("button")[1].click();
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
  assert.match(f.$("turns").firstElementChild.title, /A question/);
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
  assert.equal(f.$("count").textContent, "(0)");
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

test("chat composer works from an empty session and clears only its own draft", async (t) => {
  const posts = [];
  const f = await fixture(t, { chatFetch: async (path, body) => {
    if (path !== "/api/response") posts.push(body);
    return { ok: true, json: async () => body ? { ok: true } : { mode: "chat", protocol: 2, cursor: null, messages: [], busy: false } };
  } });
  assert.equal(f.$("chat-form").hidden, false);
  assert.equal(f.$("chat-form").querySelector('label[for="chat-input"]'), null);
  assert.equal(f.$("chat-input").getAttribute("aria-label"), "Message");
  assert.ok(f.$("chat-send").closest(".chat-composer").contains(f.$("chat-input")));
  assert.equal(f.$("chat-send").getAttribute("aria-label"), "Send message");
  assert.ok(f.$("chat-send").querySelector("svg"));
  assert.equal(f.$("chat-send").disabled, true);
  const input = f.$("chat-input");
  input.value = "Hello from the browser";
  input.dispatchEvent(new f.window.Event("input"));
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
  const pasted = waitForFileCount(1);
  const event = new w.Event("paste", { cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: { files: [new w.File(["pasted"], "clipboard.png", { type: "image/png" })] } });
  input.dispatchEvent(event);
  assert.equal(event.defaultPrevented, true);
  await pasted;
  assert.deepEqual(filenames(), ["clipboard.png"]);
  const picked = waitForFileCount(3);
  Object.defineProperty(file, "files", { value: [
    new w.File(["picked"], "picked.png", { type: "image/png" }),
    new w.File(["code"], "Example.java"),
  ] });
  file.dispatchEvent(new w.Event("change"));
  await picked;
  assert.deepEqual(filenames(), ["clipboard.png", "picked.png", "Example.java"]);
  list.querySelector('[aria-label="Remove picked.png"]').click();
  assert.deepEqual(filenames(), ["clipboard.png", "Example.java"]);
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
    { name: "clipboard.png", mimeType: "image/png", data: "cGFzdGVk" },
    { name: "Example.java", mimeType: "", data: "Y29kZQ==" },
  ]);
  assert.deepEqual(posts[0], posts[1]);
  assert.equal(list.hidden, true);
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
  assert.equal(f.$("response").textContent, "");
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
