import test from "node:test";
import assert from "node:assert/strict";
import annotate from "../src/index.ts";

function fixture(t) {
  const handlers = new Map();
  let command;
  let draft = "My existing draft";
  let busy = false;
  let session = "session-1";
  let branch = [{ id: "response-1", type: "message", message: { role: "assistant", content: [{ type: "text", text: "A reactor module" }] } }];
  const notices = [];
  annotate({
    on: (event, callback) => handlers.set(event, callback),
    registerCommand: (name, options) => { assert.equal(name, "annotate"); command = options.handler; },
  });
  t.after(() => handlers.get("session_shutdown")());
  const ctx = {
    mode: "tui",
    isIdle: () => !busy,
    sessionManager: { getBranch: () => branch, getSessionId: () => session },
    ui: {
      notify: (message) => notices.push(message),
      getEditorText: () => draft,
      setEditorText: (text) => { draft = text; },
    },
  };
  return {
    handlers, notices, ctx,
    run: (args = "link") => command(args, ctx),
    draft: () => draft,
    setDraft: (text) => { draft = text; },
    setBusy: (value) => { busy = value; },
    setSession: (value) => { session = value; },
    setBranch: (value) => { branch = value; },
    url: () => new URL(notices.findLast((text) => text.includes("http://127.0.0.1:")).split(": ").at(-1)),
  };
}
async function submit(url) {
  return fetch(`${url.origin}/api/annotations`, {
    method: "POST",
    headers: { Origin: url.origin, Authorization: `Bearer ${url.hash.slice(1)}`, "Content-Type": "application/json" },
    body: JSON.stringify({ annotations: [{ start: 2, end: 9, quote: "reactor", comment: "Why?" }] }),
  });
}

test("extension appends to the draft at return time; never submits a model message", async (t) => {
  const f = fixture(t);
  await f.run();
  f.setDraft("Draft edited while annotating");
  const url = f.url();
  assert.equal((await submit(url)).status, 200);
  assert.match(f.draft(), /^Draft edited while annotating\n\nQuestions about assistant response response-1/);
  const after = f.draft();
  await submit(url);
  assert.equal(f.draft(), after);
  // Mock exposes no sendMessage/sendUserMessage: either accidental use would fail this test.
});

test("busy state refuses transfer without consuming the batch", async (t) => {
  const f = fixture(t);
  await f.run();
  f.setBusy(true);
  assert.equal((await submit(f.url())).status, 400);
  assert.equal(f.draft(), "My existing draft");
  f.setBusy(false);
  assert.equal((await submit(f.url())).status, 200);
});

test("changed session or missing source entry invalidates the connection", async (t) => {
  const f = fixture(t);
  await f.run();
  f.setSession("session-2");
  assert.equal((await submit(f.url())).status, 410);
  assert.equal(f.draft(), "My existing draft");
  f.setSession("session-1");
  f.setBranch([]);
  assert.equal((await submit(f.url())).status, 410);
});

test("close, branch navigation and shutdown close the listener", async (t) => {
  const f = fixture(t);
  for (const action of [() => f.run("close"), () => f.handlers.get("session_before_tree")(), () => f.handlers.get("session_shutdown")()]) {
    await f.run();
    const url = f.url();
    await action();
    await assert.rejects(() => fetch(url.origin));
  }
});

test("non-TUI mode, busy agent and missing responses do not start a server", async (t) => {
  const f = fixture(t);
  f.ctx.mode = "rpc";
  await f.run();
  assert.match(f.notices.at(-1), /terminal UI/);
  f.ctx.mode = "tui";
  f.setBusy(true);
  await f.run();
  assert.match(f.notices.at(-1), /Wait/);
  f.setBusy(false);
  f.setBranch([]);
  await f.run();
  assert.match(f.notices.at(-1), /No assistant response/);
});
