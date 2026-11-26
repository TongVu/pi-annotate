import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setImmediate as turn, setTimeout as delay } from "node:timers/promises";
import { JSDOM } from "jsdom";
import { createAgentTeam, prepareTeamWorktrees, resolveTeamModel, teamThinkingLevel, teamWritePath } from "../src/agent-team.ts";
import { teamReportType } from "../src/chat-transcript.ts";
import { startChatServer } from "../src/server.ts";
import { startChatPage } from "../web/app.js";
import { mountAgentTeam } from "../web/chat/team.js";
import { mountTranscript } from "../web/chat/transcript.js";

test("team model is exactly OpenAI GPT-6 Luna at high effort, with no fallback", () => {
  const models = [{ provider: "openai", id: "gpt-6.2-sol" }, { provider: "openai", id: "gpt-5.6-luna" }];
  const luna = { provider: "openai", id: "gpt-6-luna" };
  assert.equal(teamThinkingLevel, "high");
  assert.equal(resolveTeamModel([...models, luna], () => ["medium", "high"]), luna);
  assert.throws(() => resolveTeamModel(models, () => ["high"]), /require GPT-6 Luna/);
  assert.throws(() => resolveTeamModel([luna], () => ["medium"]), /must support high/);
});

const paths = { backend: "/tmp/back", frontend: "/tmp/front", head: "base" };
function mockTeam({ prepare = async () => paths, saveAttachments } = {}) {
  const calls = [];
  const disposed = [];
  const completed = [];
  const team = createAgentTeam({ prepare, saveAttachments, onComplete: (result) => completed.push(result), openWorker: async (opts) => {
    let listener, resolve;
    const abort = () => { resolve?.(); return Promise.resolve(); };
    return {
      subscribe(fn) { listener = fn; return () => { listener = undefined; }; },
      dispose() { disposed.push(opts); void abort(); },
      abort,
      prompt(text, options) {
        return new Promise((done) => {
          resolve = done;
          calls.push({ ...opts, text, options,
            event: (event) => listener(event),
            finish(status, report) {
              listener?.({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: JSON.stringify({ status, report }) }] } });
              resolve();
            },
          });
        });
      },
    };
  } });
  return { team, calls, disposed, completed };
}

test("hands off reports, runs both implementers, pauses after two attempts, and resumes only on direction", async () => {
  const { team, calls, disposed, completed } = mockTeam();
  team.start("Split the UI and server responsibility.");
  await turn();
  assert.equal(calls[0].writable, false);
  assert.equal(calls.length, 1);
  calls[0].finish("done", "Acceptance criteria");
  await turn();
  assert.match(calls[1].text, /Acceptance criteria/);
  calls[1].finish("done", "Backend owns API; frontend owns the panel.");
  await turn();
  assert.deepEqual(calls.slice(2).map(({ cwd, writable }) => [cwd, writable]), [[paths.backend, true], [paths.frontend, true]]);
  assert.match(calls[2].text, /Backend owns API/);
  calls[2].finish("retry", "First approach failed");
  await turn();
  calls[4].finish("retry", "No change after reading the loader");
  calls[3].finish("done", "Panel is ready");
  await turn();
  const backend = team.snapshot("backend").roles.find(({ id }) => id === "backend");
  assert.equal(backend.status, "paused");
  assert.match(backend.report, /Two attempts.*No change/);
  assert.equal(calls.length, 5, "review must not start while the backend is paused");
  assert.throws(() => team.resume("backend", backend.pause + 1, "Use the old route"), /not waiting/);
  team.resume("backend", backend.pause, "Use the old route");
  assert.throws(() => team.resume("backend", backend.pause, "Duplicate direction"), /not waiting/);
  assert.match(calls[5].text, /User direction: Use the old route/);
  calls[5].finish("done", "API is ready");
  await turn();
  assert.match(calls[6].text, /backend: API is ready/);
  assert.match(calls[6].text, /frontend: Panel is ready/);
  assert.deepEqual(completed, [], "there is no final report before the architect finishes review");
  calls[6].finish("done", "Manual integration and tests remain");
  await turn();
  assert.equal(team.snapshot().phase, "done");
  assert.equal(disposed.length, 4);
  team.close();
  assert.deepEqual(completed, [{ review: "Manual integration and tests remain", worktrees: paths }]);
});

test("two identical tool errors pause without making another model turn", async () => {
  const { team, calls } = mockTeam();
  team.start("Inspect storage");
  await turn();
  for (const id of ["one", "two"]) {
    calls[0].event({ type: "tool_execution_start", toolCallId: id, toolName: "read", args: { path: "missing.md" } });
    calls[0].event({ type: "tool_execution_end", toolCallId: id, toolName: "read", isError: true, result: { content: [{ type: "text", text: "Missing file" }] } });
  }
  await turn();
  assert.equal(calls.length, 1);
  assert.match(team.snapshot().roles[0].report, /read failed twice.*Missing file/);
  team.close();
});

test("Git worktrees share only committed HEAD and reject writes outside their own tree", async (t) => {
  const repo = await mkdtemp(join(tmpdir(), "team-test-repo-"));
  t.after(() => rm(repo, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  git("init");
  await writeFile(join(repo, "app.txt"), "base");
  git("add", "app.txt");
  git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "feat: add fixture");
  await writeFile(join(repo, "app.txt"), "unstaged user changes");
  const { backend, frontend } = await prepareTeamWorktrees(repo);
  t.after(() => rm(dirname(backend), { recursive: true, force: true }));
  const root = await realpath(backend);
  const other = await realpath(frontend);
  await writeFile(await teamWritePath(root, "app.txt"), "backend edits");
  assert.equal(await readFile(join(other, "app.txt"), "utf8"), "base");
  assert.equal(await readFile(join(repo, "app.txt"), "utf8"), "unstaged user changes");
  await symlink(other, join(root, "escape"), "dir");
  await symlink(join(other, "new.txt"), join(root, "dangling"));
  for (const path of ["../frontend/app.txt", ".git", "escape/new.txt", "dangling"]) await assert.rejects(teamWritePath(root, path), /worktree|symlink/);
});

test("team API requires the live chat token and same-origin POSTs; close disposes workers", async (t) => {
  const { team, calls, disposed } = mockTeam();
  const opened = await startChatServer({ chat: { getBranch: () => [], isIdle: () => true, team } });
  t.after(opened.close);
  const url = new URL(opened.url);
  const headers = { Authorization: `Bearer ${url.hash.slice(1)}`, Origin: url.origin, "Content-Type": "application/json" };
  const api = (path, options) => fetch(url.origin + path, options);
  const start = (headers) => api("/api/team", { method: "POST", headers, body: JSON.stringify({ action: "start", brief: "Test" }) });
  assert.equal((await api("/api/team")).status, 401);
  assert.equal((await start({ ...headers, Origin: "http://another.invalid" })).status, 403);
  assert.equal((await (await api("/api/response", { headers })).json()).team, true);
  assert.equal((await start(headers)).status, 202);
  assert.equal(calls.length, 1);
  assert.equal((await start(headers)).status, 400);
  opened.close();
  assert.equal(disposed.length, 1);
  assert.equal(team.snapshot().phase, "stopped");
});

const screenshot = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgZGIGAAAOAAfXb+R4AAAAAElFTkSuQmCC";
async function until(condition, message) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (condition()) return;
    await delay(10);
  }
  assert.fail(message);
}

test("served Teams view sends pasted images and dropped text through the authenticated runner", async (t) => {
  const prepared = [];
  const { team, calls } = mockTeam({ prepare: async (options) => {
    prepared.push(options);
    if (prepared.length === 1) throw new Error("Could not prepare the test worktrees.");
    return paths;
  } });
  const opened = await startChatServer({ chat: { getBranch: () => [], isIdle: () => true, team } });
  t.after(opened.close);
  const url = new URL(opened.url);
  for (const asset of ["/app.js", "/chat/page.js", "/chat/team.js", "/chat/team-pets.js", "/chat/team.css"]) {
    assert.equal((await fetch(url.origin + asset)).status, 200, `${asset} must be served`);
  }
  const dom = new JSDOM(await (await fetch(opened.url)).text(), { url: opened.url });
  const { window } = dom;
  t.after(() => window.close());
  window.fetch = (path, opts = {}) => fetch(url.origin + path, { ...opts,
    headers: { ...opts.headers, ...(opts.method === "POST" ? { Origin: url.origin } : {}) },
  });
  await startChatPage(window, { loadNotes: async () => undefined });
  const $ = (id) => window.document.getElementById(id);
  await until(() => !$("team-view-toggle").hidden, "Teams toggle not ready");
  $("chat-input").value = "Unsent main draft";
  $("team-view-toggle").click();
  assert.equal($("team-setup").hidden, false);
  $("team-brief").value = "Build the status screen";
  $("team-brief").dispatchEvent(new window.Event("input"));
  const drop = new window.Event("drop", { cancelable: true });
  Object.defineProperty(drop, "dataTransfer", { value: { files: [new window.File(["Use a teal outline."], "acceptance.md", { type: "text/markdown" })] } });
  $("team-start").dispatchEvent(drop);
  await until(() => $("team-attachments").children.length === 1 && !$("team-attach").disabled, "Text attachment not ready");
  const paste = new window.Event("paste", { cancelable: true });
  Object.defineProperty(paste, "clipboardData", { value: { files: [new window.File([Buffer.from(screenshot, "base64")], "reference.png", { type: "image/png" })] } });
  $("team-brief").dispatchEvent(paste);
  await until(() => $("team-attachments").children.length === 2 && !$("team-attach").disabled, "Image attachment not ready");

  $("team-setup-back").click();
  assert.equal($("team-setup").hidden, true);
  assert.equal($("chat-input").value, "Unsent main draft");
  $("team-toggle").click();
  assert.equal($("team-brief").value, "Build the status screen");
  assert.equal($("team-attachments").children.length, 2);
  $("team-submit").click();
  await until(() => $("team-setup-status").classList.contains("error") && !$("team-submit").disabled, "Preparation failure was not reported");
  assert.match($("team-setup-status").textContent, /Could not prepare/);
  assert.equal($("team-setup").hidden, false);
  assert.equal($("team-brief").value, "Build the status screen");
  assert.equal($("team-attachments").children.length, 2);
  assert.equal(calls.length, 0);
  $("team-submit").click();
  await until(() => calls.length === 1 && $("team-setup").hidden, "Start did not reach the runner and show team status");
  assert.deepEqual(prepared, [{ hasImages: true }, { hasImages: true }]);
  assert.equal($("team-roles").hidden, false);
  assert.equal($("chat-input").value, "Unsent main draft");
  calls[0].finish("done", "Scope approved");
  await turn();
  calls[1].finish("done", "Design ready");
  await turn();
  assert.equal(calls.length, 4);
  for (const call of calls) {
    assert.match(call.text, /Build the status screen/);
    assert.match(call.text, /Attached file: "acceptance\.md" ---\nUse a teal outline\./);
    assert.deepEqual(call.options.images, [{ type: "image", mimeType: "image/png", data: screenshot }]);
  }
  // Role transcripts stay small and don't retransmit attachment bytes.
  assert.doesNotMatch(JSON.stringify(team.snapshot("po").messages), /Use a teal outline|iVBORw0KGgo/);
});

test("invalid team attachments fail before preparation and large text uses a private local path", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "team-input-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { saveChatAttachments } = await import("../src/chat-attachments.ts");
  let prepared = false;
  const { team, calls } = mockTeam({
    prepare: async () => { prepared = true; return paths; },
    saveAttachments: (items) => saveChatAttachments(dir, "test-session", items),
  });
  t.after(team.close);
  assert.throws(() => team.start("Read this", [{ name: "bad.png", mimeType: "image/png", data: "dGV4dA==" }]), /expected a valid PNG/);
  assert.equal(prepared, false);
  assert.equal(team.snapshot().phase, "idle");
  const text = "x".repeat(513 * 1024);
  team.start("", [{ name: "build.log", mimeType: "text/plain", data: Buffer.from(text).toString("base64") }]);
  await until(() => calls.length === 1, "Large attachment did not reach the runner");
  const path = JSON.parse(calls[0].text.match(/Local path: (.+)/)[1]);
  assert.equal(await readFile(path, "utf8"), text);
  assert.ok(calls[0].text.length < 2000, "Large contents should not be sent inline");
});

test("a completed team report arrives in the main transcript as an attributed non-branchable message", async (t) => {
  const branch = [{ id: "previous", type: "message", message: { role: "assistant", content: "I’m ready." } }];
  const opened = await startChatServer({ chat: { getBranch: () => branch, isIdle: () => true } });
  t.after(opened.close);
  const url = new URL(opened.url);
  const headers = { Authorization: `Bearer ${url.hash.slice(1)}` };
  const get = async (suffix = "") => (await fetch(`${url.origin}/api/response${suffix}`, { headers })).json();
  assert.equal((await get()).cursor, "previous");
  branch.push({ id: "report", type: "custom_message", customType: teamReportType, display: true, content: "**Tests still needed.** <img src=x>" });
  branch.push({ id: "hidden", type: "custom_message", customType: "unrelated", display: true, content: "Do not show other custom messages." });
  const { messages, cursor } = await get("?after=previous");
  assert.deepEqual(messages.map(({ role }) => role), ["team-report"]);
  assert.equal(messages[0].canBranch, undefined);
  assert.deepEqual((await get(`?after=${cursor}`)).messages, []);

  const dom = new JSDOM(await readFile(new URL("../web/index.html", import.meta.url), "utf8"));
  t.after(() => dom.window.close());
  const transcript = mountTranscript(dom.window, { isViewingLive: () => true, isCommentOpen: () => false });
  transcript.appendLive(messages);
  const report = dom.window.document.querySelector("#response .team-report-turn");
  assert.equal(report.querySelector("h2").textContent, "Software architect · Team report");
  assert.equal(report.querySelector("strong").textContent, "Tests still needed.");
  assert.equal(report.querySelector("img, [data-response-id], .reply-branch"), null);
});

test("the sidebar opens a pet's transcript and routes direction only to its paused role", async (t) => {
  const dom = new JSDOM(await readFile(new URL("../web/index.html", import.meta.url), "utf8"));
  t.after(() => dom.window.close());
  const d = dom.window.document;
  const posts = [];
  const snapshot = { phase: "active", revision: 1, roles: [
    { id: "po", name: "Product owner", status: "paused", report: "Need a decision", pause: 1 },
    { id: "backend", name: "Backend implementer", status: "working" },
    { id: "frontend", name: "Frontend implementer", status: "working" },
    { id: "architect", name: "Software architect", status: "queued" },
  ] };
  const ui = mountAgentTeam(dom.window, { onViewChange() {}, api: async (path, body) => {
    if (body) { posts.push(body); return { ok: true }; }
    const role = new URL(path, "http://localhost").searchParams.get("role");
    return { ...snapshot, messages: role ? [{ who: "Agent", text: `Notes for ${role} <img src=x onerror=alert(1)>` }] : undefined };
  } });
  await ui.refresh();
  assert.equal(d.getElementById("team-attention").textContent, "1 role needs your input");
  d.getElementById("team-toggle").click();
  assert.equal(d.querySelectorAll(".team-card svg").length, 5);
  const [, po, backend] = d.querySelectorAll(".team-card");
  const thread = d.getElementById("team-transcript");
  backend.click();
  await turn();
  assert.match(thread.textContent, /Notes for backend/);
  po.click();
  assert.doesNotMatch(thread.textContent, /Notes for backend/);
  await turn();
  assert.match(thread.textContent, /Notes for po/);
  assert.equal(thread.querySelector("img"), null);
  assert.equal(d.getElementById("team-direction").hidden, false);
  d.getElementById("team-input").value = "Keep the smaller scope";
  d.getElementById("team-direction").dispatchEvent(new dom.window.Event("submit", { cancelable: true }));
  await turn();
  assert.deepEqual(posts, [{ action: "resume", role: "po", pause: 1, direction: "Keep the smaller scope" }]);
  d.getElementById("team-back").click();
  assert.equal(ui.viewingTeam(), false);
  assert.equal(d.getElementById("team-conversation").hidden, true);
});
