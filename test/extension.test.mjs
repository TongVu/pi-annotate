import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { createAgentTeam } from "../src/agent-team.ts";
import { teamHandoffType } from "../src/chat-transcript.ts";
import { registerChatExtension } from "../src/index.ts";
import { AUTO_CHAT_SESSION, NEW_CHAT_TARGET } from "../src/resume-chat.ts";

function fixture(t, { dashboard = false, launchPage = async () => {}, sendUserMessage = () => {}, sendMessage = () => {}, ...options } = {}) {
  const handlers = new Map();
  const commands = new Map();
  const flags = new Map();
  const tools = new Map();
  const notices = [];
  const statuses = new Map();
  registerChatExtension({
    on: (event, callback) => handlers.set(event, callback),
    registerCommand: (name, options) => commands.set(name, options),
    registerFlag: (name, options) => flags.set(name, options),
    registerTool: (tool) => tools.set(tool.name, tool),
    getFlag: (name) => name === "dashboard" && dashboard,
    setSessionName: () => {},
    getSettings: () => ({}),
    sendUserMessage,
    sendMessage,
  }, launchPage, options);
  const ctx = {
    mode: "tui",
    isIdle: () => true,
    getContextUsage: () => undefined,
    sessionManager: {
      getBranch: () => [],
      getSessionDir: () => "/tmp/pi-chat-extension-tests",
      getSessionId: () => "session-1",
      getSessionName: () => undefined,
      getCwd: () => process.cwd(),
      getSessionFile: () => undefined,
    },
    ui: {
      notify: (message) => notices.push(message),
      setStatus: (key, text) => text === undefined ? statuses.delete(key) : statuses.set(key, text),
    },
  };
  const close = () => handlers.get("session_shutdown")({}, ctx);
  t.after(close);
  return { handlers, notices, statuses, ctx, commands, flags, tools, close, run: (args = "link") => commands.get("chat").handler(args, ctx) };
}

function openedUrl(notices) {
  return new URL(notices.findLast((message) => message.includes("http://127.0.0.1:")).split(": ").at(-1));
}

test("/chat is the sole registered browser command and opens a live session", async (t) => {
  const f = fixture(t);
  assert.deepEqual([...f.commands.keys()], ["chat"]);
  assert.equal(f.flags.get("dashboard").type, "boolean");
  assert.deepEqual(f.commands.get("chat").getArgumentCompletions("").map(({ value }) => value), ["link", "close", "dashboard"]);
  await f.run();
  const url = openedUrl(f.notices);
  const response = await fetch(`${url.origin}/api/response`, { headers: { Authorization: `Bearer ${url.hash.slice(1)}` } });
  assert.equal((await response.json()).mode, "chat");
  await f.run("close");
  await assert.rejects(() => fetch(url.origin));
});

test("Main chat can prepare and confirm a note brief without forwarding unrelated messages or later note edits", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-chat-delegation-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const starts = [], branch = [];
  const f = fixture(t, { createTeam: () => ({
    snapshot: () => ({ phase: starts.length ? "active" : "idle", revision: starts.length, roles: [] }),
    start: (...args) => starts.push(args), close() {},
  }) });
  f.ctx.sessionManager.getSessionDir = () => dir;
  f.ctx.sessionManager.getBranch = () => branch;
  const user = (id, content) => branch.push({ id, type: "message", message: { role: "user", content } });
  const delegate = (params) => f.tools.get("pi_chat_delegate").execute("call", params, undefined, undefined, f.ctx);
  await f.run();
  const url = openedUrl(f.notices);
  const headers = { Authorization: `Bearer ${url.hash.slice(1)}`, Origin: url.origin, "Content-Type": "application/json" };
  const api = async (path, body) => {
    const response = await fetch(url.origin + path, { headers, ...(body && { method: "POST", body: JSON.stringify(body) }) });
    assert.ok(response.ok);
    return response.json();
  };
  const original = { name: "reference.txt", mimeType: "text/plain", data: Buffer.from("Apply a muted blue border.").toString("base64") };
  await api("/api/note", { markdown: "## Requirement\nChange the borders." });
  await api("/api/note/attachments", { attachments: [original] });
  user("private", "Unrelated private conversation");
  await assert.rejects(delegate({ action: "read_note" }), /must specify the Markdown note/);
  user("prepare", "Send my Markdown note and its attachments to Teams");
  assert.equal((await api("/api/team")).autoDelegate, false);
  const note = await delegate({ action: "read_note" });
  assert.match(note.content[0].text, /Change the borders/);
  const brief = "Update the **panel border**. Keep `<img>` as literal text.";
  const draft = await delegate({ action: "prepare", brief, includeNoteAttachments: true });
  assert.deepEqual(draft.details.delegation, { started: false, brief, attachments: ["reference.txt"] });
  assert.deepEqual(starts, []);
  branch.push({ id: "draft", type: "message", message: { role: "toolResult", toolName: "pi_chat_delegate", ...draft } });
  const card = (await api("/api/response")).messages.at(-1);
  assert.equal(card.role, "team-delegation");
  assert.equal(card.html, undefined, "the brief is shown as literal text");
  assert.equal(card.text, `${brief}\n\nAttachments:\nreference.txt\n\nReply ‘Start team’ to send this brief and these attachments.`);
  await assert.rejects(delegate({ action: "confirm" }), /reply ‘Start team’/);
  await api("/api/note", { markdown: "Do not send this later change." });
  await api("/api/note/attachments", { attachments: [] });
  user("confirm", "Start team");
  await assert.rejects(delegate({ action: "prepare", brief: "Different work" }), /existing brief/);
  await delegate({ action: "confirm" });
  assert.deepEqual(starts, [[brief, [original]]]);
  await assert.rejects(delegate({ action: "confirm" }), /already started/);
});

test("Auto-delegate grants a scoped start only to a new user run and can be revoked", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-chat-delegation-fast-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const starts = [], branch = [];
  const f = fixture(t, { createTeam: () => ({
    snapshot: () => ({ phase: "idle", revision: 0, roles: [] }),
    start: (...args) => starts.push(args), close() {},
  }) });
  f.ctx.sessionManager.getBranch = () => branch;
  let session = "first";
  f.ctx.sessionManager.getSessionId = () => session;
  f.ctx.sessionManager.getSessionDir = () => dir;
  const user = (id, content) => branch.push({ id, type: "message", message: { role: "user", content } });
  const delegate = (params) => f.tools.get("pi_chat_delegate").execute("call", params, undefined, undefined, f.ctx);
  await f.run();
  const request = async (body, { origin = true, revision = "" } = {}) => {
    const url = openedUrl(f.notices);
    return fetch(url.origin + "/api/team" + revision, { headers: { Authorization: `Bearer ${url.hash.slice(1)}`,
      ...(origin && { Origin: url.origin }), "Content-Type": "application/json" }, ...(body && { method: "POST", body: JSON.stringify(body) }) });
  };
  const set = (enabled, options) => request({ action: "auto-delegate", enabled }, options);
  const begin = (messageType = "user") => {
    const sections = {};
    f.handlers.get("before_agent_start")({ messageType, systemPromptOptions: { sections } }, f.ctx);
    return sections.pi_chat_auto_delegation;
  };
  const end = () => f.handlers.get("agent_end")();
  const brief = "Add an inactive status to the API and Dashboard. Test both layers and review the combined change.";
  const auto = (extra = {}) => delegate({ action: "start", brief, ...extra });
  const requirement = "Implement inactive session status in the API and Dashboard, with tests.";
  assert.equal((await set(true, { origin: false })).status, 403);
  assert.equal((await set("true")).status, 400);
  assert.equal(begin(), undefined, "the default-off setting gives the model no auto-routing instructions");
  user("off", requirement);
  await assert.rejects(auto(), /not authorized/);
  assert.deepEqual(starts, []);
  assert.deepEqual(await (await set(true)).json(), { autoDelegate: true });
  await assert.rejects(auto(), /not authorized/, "turning on the setting does not authorize an already-running prompt");
  await f.run();
  assert.deepEqual(await (await request(undefined, { revision: "?revision=0" })).json(), { revision: 0, autoDelegate: true });

  assert.equal(begin("custom"), undefined);
  await assert.rejects(auto(), /not authorized/, "a custom follow-up cannot authorize a start");
  const guidance = begin();
  assert.match(guidance, /Answer questions and brainstorming/);
  assert.match(guidance, /Do small, focused changes yourself/);
  assert.match(guidance, /multiple roles and a separate review/);
  assert.match(guidance, /No special wording or confirmation/);
  user("question", "What's an inactive status?");
  end();
  await assert.rejects(auto(), /not authorized/, "a settled run cannot start a team later");
  assert.deepEqual(starts, []);

  begin();
  user("revoked", requirement);
  assert.equal((await set(false)).status, 200);
  assert.equal((await set(true)).status, 200);
  await assert.rejects(auto(), /not authorized/, "revoking the setting invalidates the current turn even if re-enabled");
  begin();
  user("normal", requirement);
  await assert.rejects(auto({ includeNoteAttachments: true }), /brief for review/);
  assert.deepEqual(starts, []);
  const result = await auto();
  assert.deepEqual(result.details.delegation, { started: true, brief, attachments: [] });
  assert.deepEqual(starts, [[brief, undefined]]);
  await assert.rejects(auto(), /already prepared or started/);

  f.handlers.get("session_before_tree")({}, f.ctx);
  await assert.rejects(auto(), /this Main chat branch/);
  assert.equal(begin(), undefined);
  await f.run();
  assert.equal((await (await request()).json()).autoDelegate, false, "the setting resets after moving branches");
  session = "second";
  await f.run();
  assert.equal((await (await request()).json()).autoDelegate, false);
});

test("completed Teams rounds hand off once to their Main chat, independent of the browser", async (t) => {
  const delivered = [];
  const assignments = [];
  const reviews = [];
  const main = [{ id: "private", type: "message", message: { role: "user", content: "Private Main chat text" } }];
  let branch = main;
  const f = fixture(t, {
    sendUserMessage: () => assert.fail("a team handoff must not impersonate a user"),
    sendMessage(message, options) {
      delivered.push({ message, options });
      branch.push({ ...message, id: `handoff-${delivered.length}`, type: "custom_message" });
    },
    createTeam: ({ captureHandoff }) => createAgentTeam({
      captureHandoff,
      prepare: async ({ workspace }) => workspace ?? { cwd: "/tmp/team-result", head: "base" },
      inspectWorkspace: async () => ({ files: " M ui.js", diff: "Raw patch content", truncated: false }),
      async openWorker() {
        let listener;
        return {
          subscribe(fn) { listener = fn; return () => { listener = undefined; }; },
          dispose() {},
          async prompt(text) {
            assignments.push(text);
            const review = text.includes("Read the combined changes");
            if (review) await new Promise((resolve) => reviews.push(resolve));
            const decision = text.includes("Define the smallest viable design") && !text.includes("\n\nUser direction:");
            const report = review ? "Review notes: preview not run" : decision ? "Choose the smaller UI" : "Stage handoff";
            listener?.({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: JSON.stringify({ status: decision ? "blocked" : "done", report }) }] } });
          },
        };
      },
    }),
  });
  f.ctx.sessionManager.getBranch = () => branch;
  function connect() {
    const url = openedUrl(f.notices);
    return async (path, body) => {
      const response = await fetch(url.origin + path, { headers: { Authorization: `Bearer ${url.hash.slice(1)}`, Origin: url.origin, "Content-Type": "application/json" },
        ...(body && { method: "POST", body: JSON.stringify(body) }) });
      assert.ok(response.ok, `${path}: ${response.status}`);
      return response.json();
    };
  }
  async function waitFor(read) {
    for (let i = 0; i < 100; i++) {
      const value = await read();
      if (value) return value;
      await delay(10);
    }
    assert.fail("Timed out waiting for the team");
  }
  const start = (request, action, brief, attachments) => request("/api/team", { action, brief, attachments });
  const direct = async (request, direction) => {
    const role = await waitFor(async () => (await request("/api/team")).roles.find(({ status }) => status === "paused"));
    return request("/api/team", { action: "resume", role: role.id, pause: role.pause, direction });
  };
  await f.run();
  let request = connect();
  const idle = (await request("/api/response")).teamPolling;
  assert.deepEqual(idle, { revision: 0, active: false });
  await start(request, "start", "Show the role conversation", [{ name: "spec.txt", mimeType: "text/plain", data: Buffer.from("Attachment payload").toString("base64") }]);
  await direct(request, "Keep only the reply composer");
  await waitFor(() => reviews.length === 1);
  const working = (await request("/api/response")).teamPolling;
  assert.equal(working.active, true);
  assert.ok(working.revision > idle.revision);
  assert.equal(delivered.length, 0, "nothing is sent before review");
  await f.run("close");
  reviews[0]();
  await waitFor(() => delivered.length === 1);
  assert.deepEqual(delivered[0].options, { triggerTurn: true, deliverAs: "followUp" });
  assert.match(delivered[0].message.content, /report back to the user now; do not wait/);
  assert.equal(delivered[0].message.customType, teamHandoffType);
  assert.equal(delivered[0].message.display, false);
  const info = ({ message }) => JSON.parse(message.content.split("\n\n").at(-1));
  assert.deepEqual(info(delivered[0]), {
    round: 1, brief: "Show the role conversation", feedback: "", directions: [{ role: "Software architect", text: "Keep only the reply composer" }],
    earlierDirectionsOmitted: false, workspace: { cwd: "/tmp/team-result", head: "base" }, changedFiles: " M ui.js", changesTruncated: false,
    reports: { scope: "Stage handoff", design: "Stage handoff", backend: "Stage handoff", frontend: "Stage handoff", review: "Review notes: preview not run" },
  });
  assert.match(assignments[0], /Attachment payload/);
  assert.doesNotMatch(delivered[0].message.content, /Attachment payload|Private Main chat text|Raw patch content/);
  assert.ok(assignments.every((text) => !text.includes("Private Main chat text")));
  await f.run();
  request = connect();
  const mainView = await request("/api/response?after=private");
  assert.equal(mainView.teamPolling.active, false);
  assert.ok(mainView.teamPolling.revision > working.revision);
  assert.deepEqual(mainView.messages.map(({ role }) => role), ["team-handoff"]);
  assert.match(mainView.messages[0].text, /Round 1 received.*will review the result and report back here/);
  assert.doesNotMatch(mainView.messages[0].text, /Show the role conversation|Review notes/);
  assert.equal(delivered.length, 1, "reopening does not re-deliver");

  await start(request, "feedback", "Clarify the send action");
  await direct(request, "Use a label");
  await waitFor(() => reviews.length === 2);
  reviews[1]();
  await waitFor(() => delivered.length === 2);
  assert.equal(info(delivered[1]).round, 2);
  assert.equal(info(delivered[1]).brief, "Show the role conversation");
  assert.equal(info(delivered[1]).feedback, "Clarify the send action");
  assert.deepEqual(info(delivered[1]).directions, [{ role: "Software architect", text: "Use a label" }]);

  await start(request, "feedback", "Try a smaller label");
  await direct(request, "Keep the icon too");
  await waitFor(() => reviews.length === 3);
  f.handlers.get("session_before_tree")();
  branch = [];
  reviews[2]();
  await f.run();
  request = connect();
  const result = await waitFor(async () => {
    const snapshot = await request("/api/team");
    return snapshot.phase === "done" && snapshot;
  });
  assert.match(result.issue, /Main chat changed.*available in Teams/);
  assert.ok(result.result);
  assert.deepEqual(branch, []);
  assert.equal(delivered.length, 2);
});

test("Main chat coordinates blockers and explicit feedback without forwarding the conversation", async (t) => {
  const delivered = [], assignments = [];
  const user = (id, content) => ({ id, type: "message", message: { role: "user", content } });
  const branch = [user("private", "Unrelated private conversation")];
  let attempts = 0;
  const f = fixture(t, {
    sendMessage(message, options) { delivered.push({ message, options }); },
    createTeam: ({ captureBlocker, captureHandoff }) => createAgentTeam({
      captureBlocker, captureHandoff,
      prepare: async ({ workspace }) => workspace ?? { cwd: "/tmp/team-result", head: "base" },
      inspectWorkspace: async () => ({ files: " M ui.js", diff: "patch", truncated: false }),
      async openWorker() {
        let listener;
        return {
          subscribe(fn) { listener = fn; return () => { listener = undefined; }; },
          dispose() {},
          async prompt(text) {
            assignments.push(text);
            const blocked = text.includes("Define the smallest viable design") && ++attempts < 3;
            listener({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: JSON.stringify({
              status: blocked ? "blocked" : "done", report: blocked ? "Which view should be the default?" : "Completed stage",
            }) }] } });
          },
        };
      },
    }),
  });
  f.ctx.sessionManager.getBranch = () => branch;
  const coordinate = (params) => f.tools.get("pi_chat_team").execute("call", params, undefined, undefined, f.ctx);
  const request = (url, body) => fetch(`${url.origin}/api/team`, { headers: { Authorization: `Bearer ${url.hash.slice(1)}`, Origin: url.origin, "Content-Type": "application/json" },
    ...(body && { method: "POST", body: JSON.stringify(body) }) });
  const waitFor = async (count) => {
    for (let i = 0; i < 100 && delivered.length < count; i++) await delay(10);
    assert.equal(delivered.length, count);
    return delivered[count - 1];
  };
  const blocker = ({ message }) => {
    assert.equal(message.customType, "pi-chat-team-blocker");
    const { round, role, pause } = JSON.parse(message.content.split("\n\n").at(-1));
    return { round, role, pause };
  };
  await f.run();
  const url = openedUrl(f.notices);
  assert.equal((await request(url, { action: "start", brief: "Improve the dashboard" })).status, 202);
  const first = await waitFor(1);
  const direction = blocker(first);
  assert.deepEqual(first.options, { triggerTurn: true, deliverAs: "followUp" });
  assert.match(first.message.content, /Which view should be the default/);
  assert.equal((await (await request(url)).json()).mainChatManaged, true);
  assert.equal((await request(url, { action: "resume", ...direction, direction: "Bypass Main chat" })).status, 400);
  await assert.rejects(() => coordinate({ ...direction, role: "frontend", text: "Wrong role" }), /no longer current/);
  await assert.rejects(() => coordinate({ ...direction, returnTo: "frontend", text: "Not a final review" }), /Only a paused final review/);
  await f.run("close");
  await coordinate({ ...direction, text: "Check the existing default" });
  const repeat = await waitFor(2);
  const second = blocker(repeat);
  assert.match(repeat.message.content, /Do not retry until the user responds/);
  await assert.rejects(() => coordinate({ ...second, text: "Try indefinitely" }), /already tried/);
  branch.push(user("answer", "Use the list view. Other private text."));
  await coordinate({ ...second, text: "Use the list view" });
  const completion = await waitFor(3);
  assert.equal(completion.message.customType, teamHandoffType);
  assert.match(completion.message.content, /Completed stage/);
  await assert.rejects(() => coordinate({ round: 1, text: "Invented feedback" }), /explicit new user request/);
  await f.run();
  assert.equal((await request(openedUrl(f.notices), { action: "feedback", brief: "Bypass Main chat" })).status, 400);
  branch.push(user("feedback", "Team feedback: make the list more compact"));
  await coordinate({ round: 1, text: "Make the list more compact" });
  await waitFor(4);
  assert.match(assignments.at(-1), /User feedback for round 2:\nMake the list more compact/);
  assert.match(assignments.join("\n"), /Main chat direction: Use the list view/);
  assert.doesNotMatch(assignments.join("\n"), /private|Bypass Main chat|Try indefinitely/);
  await assert.rejects(() => coordinate({ round: 2, finish: "discard" }), /exactly/);
  branch.push(user("unrelated", "Do not discard team result"));
  await assert.rejects(() => coordinate({ round: 2, finish: "discard" }), /exactly/);
  branch.push(user("discard", "Discard team result"));
  await coordinate({ round: 2, finish: "discard" });
  const stopped = await (await request(openedUrl(f.notices))).json();
  assert.equal(stopped.phase, "stopped");
  assert.equal(stopped.disposition, "discarded");
  f.handlers.get("session_before_tree")();
  branch.push(user("other-branch", "Another request"));
  await assert.rejects(() => coordinate({ round: 2, text: "Wrong branch" }), /No team to coordinate/);
});

for (const returnTo of ["frontend", "backend"]) test(`Main chat returns a review blocker to ${returnTo} for re-review in the same round`, async (t) => {
  const messages = [], stages = [], workers = [];
  let reviews = 0;
  const f = fixture(t, {
    sendMessage(message) { messages.push(message); },
    createTeam: ({ captureBlocker, captureHandoff }) => createAgentTeam({
      captureBlocker, captureHandoff,
      prepare: async () => ({ cwd: "/tmp/team-result", head: "base" }),
      inspectWorkspace: async () => ({ files: " M ui.js", diff: "patch", truncated: false }),
      async openWorker() {
        workers.push({});
        let listener;
        return {
          subscribe(fn) { listener = fn; return () => { listener = undefined; }; },
          dispose() {},
          async prompt(text) {
            const stage = text.includes("Read the combined changes") ? "review"
              : text.includes("Implement the backend") ? "backend"
              : text.includes("implement and wire the frontend") ? "frontend"
              : text.includes("smallest viable design") ? "design" : "scope";
            stages.push({ stage, text });
            const blocked = stage === "review" && ++reviews === 1;
            listener({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: JSON.stringify({
              status: blocked ? "blocked" : "done", report: blocked ? "Fix the implementation" : `Reviewed ${stage}`,
            }) }] } });
          },
        };
      },
    }),
  });
  await f.run();
  const url = openedUrl(f.notices);
  const response = await fetch(`${url.origin}/api/team`, { method: "POST", headers: { Authorization: `Bearer ${url.hash.slice(1)}`, Origin: url.origin, "Content-Type": "application/json" },
    body: JSON.stringify({ action: "start", brief: "Improve the dashboard" }) });
  assert.equal(response.status, 202);
  const waitFor = async (count) => {
    for (let i = 0; i < 100 && messages.length < count; i++) await delay(10);
    assert.equal(messages.length, count);
    return messages[count - 1];
  };
  const blocker = await waitFor(1);
  assert.equal(blocker.customType, "pi-chat-team-blocker");
  assert.match(blocker.content, /set returnTo to frontend/);
  const { round, role, pause } = JSON.parse(blocker.content.split("\n\n").at(-1));
  const coordinate = (params) => f.tools.get("pi_chat_team").execute("call", params, undefined, undefined, f.ctx);
  await assert.rejects(() => coordinate({ round, role, pause, returnTo: "review", text: "Invalid" }), /Only a paused final review/);
  await coordinate({ round, role, pause, returnTo, text: "Fix the specific review finding" });
  await assert.rejects(() => coordinate({ round, role, pause, returnTo, text: "Duplicate" }), /no longer current/);
  const result = await waitFor(2);
  assert.equal(result.customType, teamHandoffType);
  const handoff = JSON.parse(result.content.split("\n\n").at(-1));
  assert.equal(handoff.round, 1);
  assert.equal(handoff.workspace.cwd, "/tmp/team-result");
  assert.equal(workers.length, 4, "reuse all worker sessions");
  assert.deepEqual(stages.map(({ stage }) => stage), ["scope", "design", "backend", "frontend", "review", ...(returnTo === "backend" ? ["backend"] : []), "frontend", "review"]);
  assert.match(stages[5].text, /Main chat direction: Fix the specific review finding/);
  assert.equal(handoff.directions[0].role, returnTo === "backend" ? "Backend implementer" : "Frontend implementer");
});

test("stop targets the active browser message, not queued, terminal, or later prompts", async (t) => {
  const f = fixture(t, { sendUserMessage: (content) => {
    busy = true;
    start();
    userMessage(content);
  } });
  let busy = false;
  let queued = false;
  let aborts = 0;
  const start = () => f.handlers.get("agent_start")();
  const end = () => { f.handlers.get("agent_end")(); busy = false; };
  const userMessage = (content) => {
    const event = { message: { role: "user", content } };
    f.handlers.get("message_start")(event);
    f.handlers.get("message_end")(event);
  };
  f.ctx.isIdle = () => !busy;
  f.ctx.hasPendingMessages = () => queued;
  f.ctx.abort = () => { aborts++; };
  await f.run();
  const url = openedUrl(f.notices);
  const headers = { Authorization: `Bearer ${url.hash.slice(1)}`, Origin: url.origin, "Content-Type": "application/json" };
  const post = (path, body, requestHeaders = headers) => fetch(url.origin + path, { method: "POST", headers: requestHeaders, body: JSON.stringify(body) });
  const stop = (requestId, requestHeaders) => post("/api/chat/stop", { requestId }, requestHeaders);
  const state = async () => (await fetch(`${url.origin}/api/response`, { headers })).json();
  const first = "00000000-0000-4000-8000-000000000001";
  const second = "00000000-0000-4000-8000-000000000002";
  const third = "00000000-0000-4000-8000-000000000003";
  const send = async (requestId) => {
    const response = await post("/api/chat", { requestId, text: "A browser prompt" });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, stoppableRequestId: requestId });
  };

  await send(first);
  assert.equal((await state()).stoppableRequestId, first);
  assert.equal((await stop(first, { ...headers, Origin: "https://other.example" })).status, 403);
  assert.equal((await stop(first, { ...headers, Authorization: "invalid" })).status, 401);
  assert.equal((await post("/api/chat/stop", { requestId: first, extra: true })).status, 400);
  assert.equal((await stop(second)).status, 409);
  queued = true;
  assert.equal((await state()).stoppableRequestId, undefined);
  assert.equal((await stop(first)).status, 409);
  queued = false;
  assert.equal(aborts, 0);
  assert.equal((await stop(first)).status, 200);
  assert.equal((await state()).busy, true, "stopping must not pretend Pi has finished unwinding");
  assert.equal((await state()).stoppableRequestId, undefined);
  assert.equal(aborts, 1);

  end();
  await send(second);
  assert.equal((await stop(first)).status, 200, "retrying a confirmed stop is safe");
  assert.equal(aborts, 1, "the previous stop must not interrupt a new reply");
  userMessage("Terminal steering");
  assert.equal((await stop(second)).status, 409);
  end();

  await send(third);
  end();
  busy = true;
  start();
  userMessage("Terminal prompt");
  assert.equal((await state()).stoppableRequestId, undefined);
  assert.equal((await stop(third)).status, 409);
  assert.equal(aborts, 1);
});

test("the chat button opens a dashboard only when no existing tab can be focused", async (t) => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-chat-dashboard-tabs-"));
  t.after(() => rm(agentDir, { recursive: true, force: true }));
  const agent = "Chrome/156.0 Safari/537.36";
  const openTabs = new Set();
  let launches = 0;
  const launchPage = async (url, browser) => {
    assert.equal(browser, agent);
    assert.equal((await fetch(url)).status, 200, "the locator URL serves the dashboard page");
    launches++;
    openTabs.add(url.split("#")[0]);
  };
  const probes = [];
  const focusDashboard = async (tabs, browser) => {
    assert.equal(browser, agent);
    probes.push(tabs);
    return tabs.some((tab) => openTabs.has(tab));
  };
  const connect = async () => {
    const f = fixture(t, { launchPage, focusDashboard, getAgentDir: async () => agentDir });
    await f.run();
    const chat = openedUrl(f.notices);
    return {
      close: f.close,
      statuses: f.statuses,
      open: async () => {
        const response = await fetch(`${chat.origin}/api/dashboard/open`, {
          method: "POST", body: "{}", headers: { Authorization: `Bearer ${chat.hash.slice(1)}`,
            Origin: chat.origin, "Content-Type": "application/json", "User-Agent": agent },
        });
        assert.equal(response.status, 200, await response.text());
      },
    };
  };
  const first = await connect();
  await first.open();
  assert.equal(openTabs.size, 1);
  assert.deepEqual(probes, []);
  const [firstTab] = openTabs;
  const second = await connect();
  await second.open();
  assert.deepEqual(probes, [[firstTab]], "the other Pi discovers the locator without its bearer token");
  assert.equal(launches, 1, "focusing does not launch another tab");
  assert.equal(first.statuses.get("pi-chat-dashboard"), "Dashboard host");
  assert.equal(second.statuses.has("pi-chat-dashboard"), false, "focusing another Pi's dashboard does not make this Pi a host");
  openTabs.clear();
  await second.open();
  assert.equal(openTabs.size, 1, "a closed tab is replaced");
  const [secondTab] = openTabs;
  assert.notEqual(secondTab, firstTab);
  await first.close();
  await second.open();
  assert.deepEqual(probes.at(-1), [secondTab], "a shutdown dashboard is no longer a candidate");
  assert.equal(launches, 2);
});

test("an empty dashboard launcher is marked in the terminal without adding a chat card", async (t) => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-chat-dashboard-launcher-"));
  t.after(() => rm(agentDir, { recursive: true, force: true }));
  const f = fixture(t, { dashboard: true, getAgentDir: async () => agentDir, listSessions: async () => [] });
  await f.handlers.get("session_start")({ reason: "startup" }, f.ctx);
  assert.equal(f.statuses.get("pi-chat-dashboard"), "Dashboard host");
  const url = openedUrl(f.notices);
  const response = await fetch(`${url.origin}/api/dashboard`, { headers: { Authorization: `Bearer ${url.hash.slice(1)}` } });
  assert.deepEqual((await response.json()).sessions, []);
  await f.run("close");
  assert.equal(f.statuses.get("pi-chat-dashboard"), "Dashboard host", "closing a browser chat does not stop the dashboard");
  await f.close();
  assert.equal(f.statuses.has("pi-chat-dashboard"), false);
  await assert.rejects(() => fetch(url.origin));
});

test("--dashboard does not launch a browser from non-interactive Pi", async (t) => {
  const f = fixture(t, { dashboard: true, launchPage: async () => assert.fail("unexpected browser launch") });
  f.ctx.mode = "print";
  await f.handlers.get("session_start")({ reason: "startup" }, f.ctx);
  assert.deepEqual(f.notices, []);
});

async function fakeKitty(t) {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-launch-kitty-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const argsFile = join(root, "argv");
  const kitty = join(root, "kitty");
  const pi = join(root, "pi");
  await writeFile(pi, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  await writeFile(kitty, '#!/bin/sh\nprintf "%s\\n" "$@" > "$TEST_ARGS"\n', { mode: 0o755 });
  const env = { PATH: root, PI_MANAGED_INSTALL_ROOT: undefined, KITTY_CONFIG_DIRECTORY: root,
    KITTY_WINDOW_ID: "27", KITTY_LISTEN_ON: `unix:${join(root, "socket")}`, TEST_ARGS: argsFile,
    TMUX: undefined, STY: undefined, SSH_CONNECTION: undefined };
  for (const [key, value] of Object.entries(env)) {
    const previous = process.env[key];
    t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return { root, argsFile, kitty, pi, env };
}

test("a Linux dashboard launches a fresh Pi in its Kitty window", { skip: process.platform !== "linux" }, async (t) => {
  const { root, argsFile, kitty, pi, env } = await fakeKitty(t);
  const cwd = join(root, "new project's workspace");
  await mkdir(cwd);
  const f = fixture(t, { getAgentDir: async () => root, listSessions: async () => [] });
  f.ctx.sessionManager.getCwd = () => cwd;
  await f.run("dashboard");
  const url = openedUrl(f.notices);
  const create = () => fetch(`${url.origin}/api/session/new`, {
    method: "POST", body: JSON.stringify({ cwd }), headers: { Authorization: `Bearer ${url.hash.slice(1)}`,
      Origin: url.origin, "Content-Type": "application/json" },
  });
  const launched = await create();
  const result = await launched.json();
  assert.equal(launched.status, 202, result.error);
  assert.equal(result.command, undefined);
  assert.deepEqual((await readFile(argsFile, "utf8")).trimEnd().split("\n"), ["@", "--to", env.KITTY_LISTEN_ON, "--use-password", "never",
    "launch", "--type=tab", "--match", "window_id:27", "--cwd", cwd, "--env", `PATH=${root}`, "--env", `PI_CODING_AGENT_DIR=${root}`,
    "--env", `${AUTO_CHAT_SESSION}=${NEW_CHAT_TARGET}`, "--", pi, "--extension", fileURLToPath(new URL("../src/index.ts", import.meta.url))]);

  await writeFile(kitty, '#!/bin/sh\necho "disallowed by remote_control_password" >&2\nexit 1\n');
  const denied = await create();
  assert.equal(denied.status, 200);
  const fallback = await denied.json();
  assert.match(fallback.message, /launch permission/);
  assert.match(fallback.command, /^cd -- .* && pi$/);

  await writeFile(kitty, "#!/bin/sh\nexit 1\n");
  const unconfirmed = await create();
  assert.equal(unconfirmed.status, 400);
  const failure = await unconfirmed.json();
  assert.match(failure.error, /Could not confirm the Kitty launch/);
  assert.equal(failure.command, undefined, "do not suggest another launch when Kitty may already have started Pi");
});

test("the Linux explorer offers clone in Kitty and forks the saved live chat", { skip: process.platform !== "linux" }, async (t) => {
  const { root, argsFile, kitty, pi, env } = await fakeKitty(t);
  const path = join(root, "chat's $(literal).jsonl");
  const peerPath = join(root, "peer.jsonl");
  await writeFile(path, "saved transcript");
  await writeFile(peerPath, "other saved transcript");
  const f = fixture(t, { getAgentDir: async () => root, listSessions: async () => [
    { id: "session-1", cwd: root, path }, { id: "peer", cwd: root, path: peerPath },
  ] });
  f.ctx.sessionManager.getCwd = () => root;
  f.ctx.sessionManager.getSessionFile = () => path;
  const connect = async () => {
    await f.run();
    const url = openedUrl(f.notices);
    const headers = { Authorization: `Bearer ${url.hash.slice(1)}`, Origin: url.origin, "Content-Type": "application/json" };
    return {
      catalog: await (await fetch(`${url.origin}/api/sessions`, { headers })).json(),
      clone: (id) => fetch(`${url.origin}/api/session/clone`, { method: "POST", headers, body: JSON.stringify({ id }) }),
    };
  };
  const { catalog, clone } = await connect();
  assert.equal(catalog.current.canClone, true);
  assert.equal(catalog.canOpen, undefined, "clone does not enable Resume in browser");
  const launched = await clone("session-1");
  assert.equal(launched.status, 202, await launched.text());
  assert.deepEqual((await readFile(argsFile, "utf8")).trimEnd().split("\n"), ["@", "--to", env.KITTY_LISTEN_ON, "--use-password", "never",
    "launch", "--type=tab", "--match", "window_id:27", "--cwd", root, "--env", `PATH=${root}`, "--env", `PI_CODING_AGENT_DIR=${root}`,
    "--env", `${AUTO_CHAT_SESSION}=fork`, "--", pi, "--fork", path, "--extension", fileURLToPath(new URL("../src/index.ts", import.meta.url))]);
  assert.equal(await readFile(path, "utf8"), "saved transcript");

  await writeFile(kitty, '#!/bin/sh\necho "disallowed by remote_control_password" >&2\nexit 1\n');
  const denied = await clone("peer");
  assert.equal(denied.status, 400);
  assert.match((await denied.json()).error, /launch permission/);

  delete process.env.KITTY_LISTEN_ON;
  const unsupported = await connect();
  assert.equal(unsupported.catalog.current.canClone, undefined);
  assert.equal((await unsupported.clone("session-1")).status, 404);
});

test("a fresh Pi launched by the dashboard opens an empty browser chat on startup", async (t) => {
  const previous = process.env[AUTO_CHAT_SESSION];
  process.env[AUTO_CHAT_SESSION] = NEW_CHAT_TARGET;
  t.after(() => {
    if (previous === undefined) delete process.env[AUTO_CHAT_SESSION];
    else process.env[AUTO_CHAT_SESSION] = previous;
  });
  const opened = [];
  const f = fixture(t, { launchPage: async (url) => opened.push(url) });
  await f.handlers.get("session_start")({ reason: "startup" }, f.ctx);
  assert.equal(process.env[AUTO_CHAT_SESSION], undefined);
  assert.equal(opened.length, 1);
  const url = new URL(opened[0]);
  const res = await fetch(`${url.origin}/api/response`, { headers: { Authorization: `Bearer ${url.hash.slice(1)}` } });
  const chat = await res.json();
  assert.equal(chat.sessionId, "session-1");
  assert.deepEqual(chat.messages, []);
});

test("/chat rejects unsupported modes and non-TUI contexts", async (t) => {
  const f = fixture(t);
  await f.run("unknown");
  assert.match(f.notices.at(-1), /Usage: \/chat/);
  f.ctx.mode = "rpc";
  await f.run();
  assert.match(f.notices.at(-1), /terminal UI/);
});
