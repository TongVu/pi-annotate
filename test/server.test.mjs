import test from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
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

test("invalid JSON and oversized bodies do not reach the draft", async (t) => {
  const f = await fixture(t);
  for (const body of ["{", JSON.stringify({ huge: "x".repeat(513 * 1024) })]) {
    const res = await fetch(`${f.base}/api/annotations`, { method: "POST", headers: f.headers, body });
    assert.equal(res.status, 400);
  }
  assert.equal(f.submissions.length, 0);
});
