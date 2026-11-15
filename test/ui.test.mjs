import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
import { renderMarkdown } from "../src/markdown.ts";
import { validateAnnotations } from "../src/annotations.ts";

async function fixture(t, { failFirst = false, markdown = "A reactor module.\n<script>alert('bad')</script>", corruptText = false, legacyServer = false } = {}) {
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
  window.fetch = async (path, opts) => {
    assert.equal(opts.headers.Authorization, "Bearer test-token");
    if (path === "/api/response") return { ok: true, json: async () => ({ response: legacyServer ? { id: "test", text: markdown } : { id: "test", ...rendered, ...(corruptText ? { text: "mismatch" } : {}) }, submitted: false }) };
    const body = JSON.parse(opts.body);
    validateAnnotations(body.annotations, rendered.text);
    posts.push(body);
    return { ok: !(failFirst && posts.length === 1), json: async () => failFirst && posts.length === 1 ? { error: "Pi is busy" } : { ok: true } };
  };
  await window.eval(`(async () => { ${source}\n})()`);
  const select = (start, end) => {
    const range = window.document.createRange();
    const locate = (offset) => {
      const nodes = window.document.createTreeWalker($("response"), window.NodeFilter.SHOW_TEXT);
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
  return { window, $, posts, select, add, rendered };
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
