import test from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { startAnnotationServer } from "../src/server.ts";

async function fixture(t, options = {}) {
  const submissions = [];
  const server = await startAnnotationServer({
    response: { id: "message-1", text: "A reactor module" },
    onSubmit: (text) => submissions.push(text),
    ...options,
  });
  t.after(server.close);
  const url = new URL(server.url);
  const base = url.origin;
  const headers = { Authorization: `Bearer ${url.hash.slice(1)}`, Origin: base, "Content-Type": "application/json" };
  const body = { annotations: [{ start: 2, end: 9, quote: "reactor", comment: "What is this?" }] };
  const post = (value = body, extra = {}) => fetch(`${base}/api/annotations`, { method: "POST", headers: { ...headers, ...extra }, body: JSON.stringify(value) });
  return { base, headers, body, post, submissions };
}

test("loopback app requires token for response, serves safe static assets", async (t) => {
  const f = await fixture(t);
  assert.match(f.base, /^http:\/\/127\.0\.0\.1:\d+$/);
  const page = await fetch(f.base);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  assert.equal(page.headers.get("cache-control"), "no-store");
  assert.doesNotMatch(await page.text(), /A reactor module/);
  assert.equal((await fetch(`${f.base}/api/response`)).status, 401);
  const authorized = await fetch(`${f.base}/api/response`, { headers: f.headers });
  assert.equal((await authorized.json()).response.id, "message-1");
  for (const path of ["/app.js", "/style.css"]) assert.equal((await fetch(f.base + path)).status, 200);
  assert.equal((await fetch(`${f.base}/not-a-file`, { headers: f.headers })).status, 404);
});

test("submissions validate quotes, append only once, and tolerate a lost-response retry", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.post({ annotations: [{ ...f.body.annotations[0], quote: "forged" }] })).status, 400);
  assert.equal(f.submissions.length, 0);
  assert.equal((await f.post()).status, 200);
  assert.equal((await f.post()).status, 200);
  assert.equal(f.submissions.length, 1);
  assert.match(f.submissions[0], /> reactor\n\nWhat is this\?/);
  assert.equal((await f.post({ annotations: [{ ...f.body.annotations[0], comment: "Different" }] })).status, 409);
});

test("rendered quotes validate against server-owned visible text, not raw Markdown", async (t) => {
  const f = await fixture(t, { response: { id: "rendered-1", text: "**Bold** and [docs](https://example.com) &amp; `code`." } });
  const res = await fetch(`${f.base}/api/response`, { headers: f.headers });
  const { response } = await res.json();
  assert.match(response.html, /<strong>Bold<\/strong>/);
  assert.match(response.text, /^Bold and docs & code\./);
  const quote = "Bold and docs & code";
  assert.equal((await f.post({ annotations: [{ start: 0, end: quote.length, quote, comment: "Why?" }] })).status, 200);
  assert.match(f.submissions[0], /> Bold and docs & code\n\nWhy\?/);
  assert.equal((await f.post({ annotations: [{ start: 0, end: 8, quote: "**Bold**", comment: "Wrong basis" }] })).status, 400);
});

test("rejects cross-origin requests, invalid Host, missing origin and invalid token", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.post(f.body, { Origin: "https://evil.example" })).status, 403);
  // fetch may normalize/ignore Host overrides; use a raw HTTP request for rebinding coverage.
  const invalidHostStatus = await new Promise((resolve, reject) => {
    const req = request(f.base, { headers: { Host: "evil.example" } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on("error", reject);
    req.end();
  });
  assert.equal(invalidHostStatus, 403);
  assert.equal((await f.post(f.body, { Authorization: "Bearer wrong" })).status, 401);
  assert.equal((await f.post(f.body, { Origin: "" })).status, 403);
  assert.equal((await f.post(f.body, { "Content-Type": "text/plain" })).status, 403);
  assert.equal(f.submissions.length, 0);
});

test("session/branch invalidation prevents reads and writes", async (t) => {
  let current = true;
  const f = await fixture(t, { isCurrent: () => current });
  current = false;
  assert.equal((await f.post()).status, 410);
  assert.equal((await fetch(`${f.base}/api/response`, { headers: f.headers })).status, 410);
  assert.equal(f.submissions.length, 0);
});

test("busy editor preserves annotations for a later retry", async (t) => {
  let busy = true;
  let appended = 0;
  const f = await fixture(t, { onSubmit: () => {
    if (busy) throw new Error("Pi is busy");
    appended++;
  } });
  assert.equal((await f.post()).status, 400);
  assert.equal(appended, 0);
  busy = false;
  assert.equal((await f.post()).status, 200);
  assert.equal(appended, 1);
});

test("chat protects the active transcript and validates quotes from each assistant message", async (t) => {
  const entry = (id, role, content) => ({ id, type: "message", message: { role, content } });
  const text = (value) => ({ type: "text", text: value });
  const branch = [
    entry("system", "system", "System prompt"),
    entry("user", "user", [text("First question"), { type: "image", data: "image data" }]),
    entry("a1", "assistant", [text("**One**"), { type: "thinking", thinking: "Private reasoning" }]),
    entry("tool", "toolResult", [text("Tool output")]),
    entry("a2", "assistant", [text("Two")]),
  ];
  let busy = false;
  let accept;
  const started = Promise.withResolvers();
  const prompts = [];
  const f = await fixture(t, { chat: {
    getBranch: () => branch,
    isIdle: () => !busy,
    onSend: async (prompt) => {
      prompts.push(prompt);
      await new Promise((resolve) => { accept = resolve; started.resolve(); });
    },
  } });
  const url = `${f.base}/api/response`;
  const read = (after = "") => fetch(url + after, { headers: f.headers });
  const post = (body, headers = f.headers) => fetch(`${f.base}/api/chat`, { method: "POST", headers, body: JSON.stringify(body) });
  assert.equal((await fetch(url)).status, 401);
  assert.equal((await read("?after=missing")).status, 410);
  const state = await (await read()).json();
  assert.equal(state.mode, "chat");
  assert.equal(state.cursor, "a2");
  assert.deepEqual(state.messages.map((message) => message.id), ["user", "a1", "a2"]);
  assert.doesNotMatch(JSON.stringify(state), /System prompt|image data|Private reasoning|Tool output/);
  assert.match(state.messages[1].html, /<strong>One<\/strong>/);
  assert.equal((await f.post()).status, 404);

  const annotation = (responseId, quote) => ({ responseId, start: 0, end: quote.length, quote, comment: `Explain ${quote}.` });
  const batch = { requestId: "00000000-0000-4000-8000-000000000001", annotations: [annotation("a1", "One"), annotation("a2", "Two")] };
  assert.equal((await post(batch, { ...f.headers, Origin: "https://other.example" })).status, 403);
  assert.equal((await post(batch, { ...f.headers, Authorization: "Bearer wrong" })).status, 401);
  for (const item of [annotation("a1", "Two"), annotation("user", "First"), annotation("missing", "One")]) {
    assert.equal((await post({ ...batch, annotations: [item] })).status, 400);
  }
  busy = true;
  assert.equal((await post(batch)).status, 409);
  assert.deepEqual(prompts, []);
  busy = false;

  const first = post(batch);
  await started.promise;
  const retry = post(batch);
  const plain = { requestId: "00000000-0000-4000-8000-000000000002", text: "Another question" };
  assert.equal((await post(plain)).status, 409);
  accept();
  assert.equal((await first).status, 200);
  assert.equal((await retry).status, 200);
  assert.equal((await post({ ...plain, requestId: batch.requestId })).status, 409);
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /response a1:\n[\s\S]*> One[\s\S]*response a2:\n[\s\S]*> Two/);

  branch.push(entry("a3", "assistant", [text("New reply")]));
  const delta = await (await read("?after=a2")).json();
  assert.deepEqual(delta.messages.map((message) => message.id), ["a3"]);
  assert.equal(delta.busy, false);
});

test("authenticated polling keeps chat alive beyond its original deadline, then idle chat expires", async (t) => {
  const ttlMs = 750;
  const f = await fixture(t, { ttlMs, chat: { getBranch: () => [], isIdle: () => true } });
  const draft = await fixture(t, { ttlMs });
  const poll = async ({ base, headers }) => {
    const res = await fetch(`${base}/api/response`, { headers });
    await res.json();
    return res.status;
  };
  assert.equal(await poll(draft), 200);
  for (let i = 0; i < 3; i++) {
    assert.equal(await poll(f), 200);
    await delay(280);
  }
  await assert.rejects(() => poll(draft), "draft-only polling doesn't renew its original timeout");
  assert.equal(await poll(f), 200, "chat survives more than the original TTL");
  await delay(ttlMs + 25);
  await assert.rejects(() => poll(f), "abandoned chat closes after the idle timeout");
});

test("a chat tab can disconnect its listener only with the same-origin token", async (t) => {
  const f = await fixture(t, { chat: { getBranch: () => [], isIdle: () => true } });
  const close = (headers) => fetch(`${f.base}/api/close`, { method: "POST", headers, body: "{}" });
  assert.equal((await close({ ...f.headers, Authorization: "Bearer wrong" })).status, 401);
  assert.equal((await close({ ...f.headers, Origin: "" })).status, 403);
  assert.equal((await close(f.headers)).status, 200);
  await assert.rejects(() => fetch(f.base));
});

test("chat validates mixed attachments and includes every file in duplicate detection", async (t) => {
  const sent = [];
  const f = await fixture(t, { chat: {
    getBranch: () => [], isIdle: () => true, onSend: async (prompt) => sent.push(prompt),
  } });
  const post = (body) => fetch(`${f.base}/api/chat`, { method: "POST", headers: f.headers, body: JSON.stringify(body) });
  const image = { name: "photo.png", mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgZGIGAAAOAAfXb+R4AAAAAElFTkSuQmCC" };
  const file = { name: "Example.java", mimeType: "", data: Buffer.from("class Example {}\n").toString("base64") };
  const requestId = "00000000-0000-4000-8000-000000000003";
  for (const invalid of [
    { ...image, mimeType: "image/svg+xml" },
    { ...image, mimeType: "image/jpeg" },
    { ...image, data: image.data + "!" },
    { ...image, data: "A".repeat(Math.ceil(5 * 1024 * 1024 / 3) * 4 + 4) },
    { ...file, name: "../../Example.java" },
    { ...file, name: "binary.zip", data: Buffer.from([0x50, 0x4b, 0x03, 0x04]).toString("base64") },
    { ...file, name: "doc.pdf", data: Buffer.from("%PDF-1.4").toString("base64") },
    { ...file, data: Buffer.alloc(129 * 1024, 0x61).toString("base64") },
  ]) {
    assert.equal((await post({ requestId, text: "", attachments: [file, invalid] })).status, 400);
  }
  assert.equal((await post({ requestId, text: "", attachments: Array(11).fill(file) })).status, 400);
  assert.equal((await post({ requestId, annotations: [], attachments: [image] })).status, 400);
  assert.equal(sent.length, 0);
  const message = { requestId, text: "", attachments: [file, image, { ...image, name: "another.png", mimeType: "" }] };
  assert.equal((await post(message)).status, 200);
  assert.equal((await post(message)).status, 200);
  assert.equal((await post({ ...message, attachments: [file, image] })).status, 409);
  assert.equal(sent.length, 1);
  assert.match(sent[0][0].text, /Attached file: "Example.java" ---\nclass Example/);
  assert.deepEqual(sent[0].slice(1), Array(2).fill({ type: "image", mimeType: image.mimeType, data: image.data }));
});

test("invalid JSON and oversized bodies do not reach the draft", async (t) => {
  const f = await fixture(t);
  for (const body of ["{", JSON.stringify({ huge: "x".repeat(513 * 1024) })]) {
    const res = await fetch(`${f.base}/api/annotations`, { method: "POST", headers: f.headers, body });
    assert.equal(res.status, 400);
  }
  assert.equal(f.submissions.length, 0);
});
