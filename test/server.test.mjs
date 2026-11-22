import test from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createChatPresence } from "../src/chat-presence.ts";
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
  assert.match(page.headers.get("content-security-policy"), /img-src 'self';/);
  assert.equal(page.headers.get("cache-control"), "no-store");
  const html = await page.text();
  assert.doesNotMatch(html, /A reactor module/);
  assert.match(html, /rel="icon" href="\/favicon\.ico"/);
  const icon = await fetch(`${f.base}/favicon.ico`);
  assert.equal(icon.status, 200);
  assert.equal(icon.headers.get("content-type"), "image/x-icon");
  assert.equal(Buffer.from(await icon.arrayBuffer()).readUInt32LE(0), 0x00010000);
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

test("chat session rename validates names and updates Pi through the authenticated route", async (t) => {
  let sessionName = "Before rename";
  const f = await fixture(t, { chat: {
    getBranch: () => [],
    getSessionName: () => sessionName,
    setSessionName: (name) => { sessionName = name; },
    isIdle: () => true,
  } });
  const rename = (body, headers = f.headers) => fetch(`${f.base}/api/session/name`, {
    method: "POST", headers, body: JSON.stringify(body),
  });
  assert.equal((await rename({ name: "   " })).status, 400);
  assert.equal((await rename({ name: "x".repeat(101) })).status, 400);
  assert.equal((await rename({ name: "bad\nname" })).status, 400);
  assert.equal((await rename({ name: "bad\\nname" })).status, 200, "literal backslash-n is valid name text");
  assert.equal(sessionName, "bad\\nname");
  const result = await rename({ name: "  New chat name  " });
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), { sessionName: "New chat name" });
  assert.equal(sessionName, "New chat name");
  assert.equal((await rename({ name: "No token" }, {})).status, 401);
  assert.equal((await rename({ name: "No cross origin" }, { ...f.headers, Origin: "https://other.example" })).status, 403);
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
    getSessionId: () => "session-current",
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
  assert.equal(state.sessionId, "session-current");
  assert.equal(state.cursor, "a2");
  assert.deepEqual(state.messages.map((message) => message.id), ["user", "a1", "a2"]);
  assert.doesNotMatch(JSON.stringify(state), /System prompt|image data|Private reasoning|Tool output/);
  assert.match(state.messages[1].html, /<strong>One<\/strong>/);
  assert.equal((await fetch(`${f.base}/api/image?id=missing&index=0`, { headers: f.headers })).status, 404);
  assert.equal((await fetch(`${f.base}/api/image?id=a1&index=0`, { headers: f.headers })).status, 404);
  assert.equal((await fetch(`${f.base}/api/markdown`, { method: "POST", headers: { Origin: f.base, "Content-Type": "application/json" }, body: JSON.stringify({ markdown: "**note**" }) })).status, 401);
  const preview = await fetch(`${f.base}/api/markdown`, { method: "POST", headers: f.headers, body: JSON.stringify({ markdown: "# Reuse\n\n**note**\n\n<script>bad()</script>" }) });
  assert.equal(preview.status, 200);
  const renderedNote = await preview.json();
  assert.match(renderedNote.html, /<strong>note<\/strong>/);
  assert.doesNotMatch(renderedNote.html, /<script/);
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

test("chat explorer lists limited metadata and reads only catalogued sessions with the chat token", async (t) => {
  let opened = 0;
  let current = true;
  const live = { id: "live", name: "Live project", cwd: "/projects/live", path: "/private/store/live.jsonl" };
  const saved = { id: "saved", cwd: "/projects/other's repo", path: "/private/store/user's session.jsonl", parentSessionPath: live.path, firstMessage: "First question", allMessagesText: "Unlisted transcript" };
  const f = await fixture(t, {
    isCurrent: () => current,
    chat: {
      getBranch: () => [], isIdle: () => true,
      explorer: {
        current: () => live,
        list: async () => [live, saved],
        read: async (session) => {
          assert.deepEqual(session, { id: saved.id, cwd: saved.cwd, path: saved.path, name: saved.firstMessage });
          opened++;
          return [
            { type: "message", id: "system", message: { role: "system", content: "Hidden prompt" } },
            { type: "message", id: "reply", message: { role: "assistant", content: [{ type: "text", text: "**Saved reply**" }] } },
          ];
        },
      },
    },
  });
  const read = (path, headers = f.headers) => fetch(f.base + path, { headers });
  assert.equal((await read("/api/sessions", {})).status, 401);
  assert.equal((await read("/api/session?id=saved")).status, 404, "the catalog has not been loaded");
  const list = await (await read("/api/sessions")).json();
  assert.deepEqual(list, {
    current: { id: live.id, cwd: live.cwd, name: live.name },
    sessions: [{ id: "saved", cwd: saved.cwd, name: "First question", parentId: "live" }],
  });
  assert.equal((await read("/api/session?id=saved", { ...f.headers, Origin: "https://other.example" })).status, 403);
  assert.equal((await read(`/api/session?id=${encodeURIComponent(saved.path)}`)).status, 404);
  assert.equal((await read("/api/session?id=live")).status, 404);
  assert.equal((await read("/api/session/resume?id=saved", {})).status, 401);
  assert.equal((await read("/api/session/resume?id=live")).status, 404);
  assert.deepEqual(await (await read("/api/session/resume?id=saved")).json(), {
    command: String.raw`cd -- '/projects/other'\''s repo' && pi --session '/private/store/user'\''s session.jsonl'`,
  });
  assert.equal(opened, 0);
  const transcript = await (await read("/api/session?id=saved")).json();
  assert.equal(opened, 1);
  assert.deepEqual(transcript.messages.map(({ id }) => id), ["reply"]);
  assert.match(transcript.messages[0].html, /<strong>Saved reply<\/strong>/);
  assert.deepEqual((await (await read("/api/response")).json()).messages, []);
  current = false;
  assert.equal((await read("/api/session?id=saved")).status, 410);
});

test("opening a saved chat requires the catalogued ID and refuses an active or pending session", async (t) => {
  const live = { id: "live", name: "Live chat", cwd: "/projects/live" };
  const saved = { id: "saved", name: "Saved chat", cwd: "/projects/other", path: "/store/saved.jsonl" };
  let peers = [{ id: saved.id }];
  const childStarting = Promise.withResolvers();
  const childAccepted = Promise.withResolvers();
  const launches = [];
  const f = await fixture(t, { chat: {
    getBranch: () => [], isIdle: () => true,
    presence: { list: async () => peers, close: () => {} },
    explorer: {
      current: () => live, list: async () => [saved],
      launch: async (session) => { launches.push(session); childStarting.resolve(); await childAccepted.promise; return "attached"; },
    },
  } });
  t.after(childAccepted.resolve);
  const open = (body, headers = f.headers) => fetch(`${f.base}/api/session/open`, { method: "POST", headers, body: JSON.stringify(body) });
  assert.equal((await open({ id: "saved" })).status, 404);
  const catalog = await (await fetch(`${f.base}/api/sessions`, { headers: f.headers })).json();
  assert.equal(catalog.canOpen, true);
  assert.equal((await open({ id: "saved" }, { ...f.headers, Origin: "https://other.example" })).status, 403);
  assert.equal((await open({ id: "saved" }, { ...f.headers, Authorization: "Bearer wrong" })).status, 401);
  assert.equal((await open({ id: saved.path })).status, 404);
  assert.equal((await open({ id: "saved" })).status, 409, "never launch a green session again");
  assert.equal(launches.length, 0);
  peers = [];
  const starting = open({ id: "saved", path: "/browser-supplied/path" });
  await childStarting.promise;
  assert.equal((await open({ id: "saved" })).status, 409);
  childAccepted.resolve();
  const result = await starting;
  assert.equal(result.status, 202);
  assert.deepEqual(await result.json(), { ok: true, attached: true });
  assert.deepEqual(launches, [saved]);
});

test("separate browser chat servers discover active peers and remove them on disconnect", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-annotate-presence-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const a = { id: "a", cwd: "/first", name: "First chat" };
  const b = { id: "b", cwd: "/second", name: "Second chat" };
  const open = (identity) => fixture(t, { chat: {
    getBranch: () => [], isIdle: () => true, presence: createChatPresence(() => dir, () => identity),
  } });
  const [one, two] = await Promise.all([open(a), open(b)]);
  const get = (f, path) => fetch(f.base + path, { headers: f.headers });
  const peers = async (f) => (await (await get(f, "/api/activity")).json()).sessions;
  assert.equal((await fetch(`${one.base}/api/activity`)).status, 401);
  assert.deepEqual(await peers(one), [], "an unopened link is not announced");
  assert.equal((await get(one, "/api/response")).status, 200);
  assert.equal((await get(two, "/api/response")).status, 200);
  assert.deepEqual(await peers(one), [b]);
  assert.deepEqual(await peers(two), [a]);
  const closed = await fetch(`${two.base}/api/close`, { method: "POST", headers: two.headers, body: "{}" });
  assert.equal(closed.status, 200);
  for (let retry = 0; retry < 20 && (await peers(one)).length; retry++) await delay(10);
  assert.deepEqual(await peers(one), []);
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

test("chat allows the local favicon and embedded previews but not external image sources", async (t) => {
  const f = await fixture(t, { chat: { getBranch: () => [], isIdle: () => true } });
  const page = await fetch(f.base);
  assert.match(page.headers.get("content-security-policy"), /img-src 'self' data: blob:;/);
});

test("a chat tab can disconnect its listener only with the same-origin token", async (t) => {
  const f = await fixture(t, { chat: { getBranch: () => [], isIdle: () => true } });
  const close = (headers) => fetch(`${f.base}/api/close`, { method: "POST", headers, body: "{}" });
  assert.equal((await close({ ...f.headers, Authorization: "Bearer wrong" })).status, 401);
  assert.equal((await close({ ...f.headers, Origin: "" })).status, 403);
  assert.equal((await close(f.headers)).status, 200);
  await assert.rejects(() => fetch(f.base));
});

test("chat annotation images stay associated with their questions and use separate attachment validation", async (t) => {
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgZGIGAAAOAAfXb+R4AAAAAElFTkSuQmCC";
  const largePng = Buffer.concat([Buffer.from(png, "base64"), Buffer.alloc(512 * 1024)]).toString("base64");
  const image = { name: "photo.png", mimeType: "image/png", data: png };
  const received = [];
  const f = await fixture(t, { chat: {
    getBranch: () => [{ id: "reply", type: "message", message: { role: "assistant", content: "One Two" } }],
    isIdle: () => true, onSend: async (prompt) => received.push(prompt),
  } });
  const post = (body) => fetch(`${f.base}/api/chat`, { method: "POST", headers: f.headers, body: JSON.stringify(body) });
  const body = { requestId: "00000000-0000-4000-8000-000000000001", annotations: [
    { responseId: "reply", start: 0, end: 3, quote: "One", comment: "First?", images: [image] },
    { responseId: "reply", start: 4, end: 7, quote: "Two", comment: "Second?", images: [{ ...image, data: largePng }] },
  ] };
  const annotatedWith = (patch) => ({ ...body, annotations: [{ ...body.annotations[0], ...patch }, body.annotations[1]] });
  assert.equal((await post(annotatedWith({ quote: "Bad" }))).status, 400);
  assert.equal((await post(annotatedWith({ images: [{ name: "text.txt", mimeType: "text/plain", data: "QQ==" }] }))).status, 400);
  assert.equal((await post(annotatedWith({ images: Array(10).fill(image) }))).status, 400);
  assert.equal(received.length, 0);
  assert.equal((await post(body)).status, 200);
  assert.equal((await post(body)).status, 200, "unchanged retry is acknowledged without another send");
  assert.equal((await post(annotatedWith({ images: [{ ...image, name: "different.png" }] }))).status, 409);
  assert.equal(received.length, 1);
  assert.match(received[0][0].text, /> One\n\nFirst\?\n\nAttached: Image 1\.[\s\S]*> Two\n\nSecond\?\n\nAttached: Image 2\./);
  assert.deepEqual(received[0].slice(1).map(({ data }) => data), [png, largePng]);
  const draft = await fixture(t);
  assert.equal((await draft.post({ annotations: [{ ...draft.body.annotations[0], images: [image] }] })).status, 400);
  assert.deepEqual(draft.submissions, []);
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
