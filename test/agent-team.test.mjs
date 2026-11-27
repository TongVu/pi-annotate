import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setImmediate as turn, setTimeout as delay } from "node:timers/promises";
import { JSDOM } from "jsdom";
import { createAgentTeam, inspectTeamWorkspace, prepareTeamWorkspace, resolveTeamModel, teamModelChoices, teamRoleDefaults, teamThinkingLevel, teamWritePath } from "../src/agent-team.ts";
import { teamReportType } from "../src/chat-transcript.ts";
import { startChatServer } from "../src/server.ts";
import { startChatPage } from "../web/app.js";
import { mountAgentTeam } from "../web/chat/team.js";
import { mountTranscript } from "../web/chat/transcript.js";

test("role model defaults and selected models/efforts are validated without fallback", () => {
  const sol = { provider: "openai", id: "gpt-6.2-sol" };
  const luna = { provider: "openai", id: "gpt-6-luna" };
  assert.deepEqual(teamRoleDefaults, {
    po: { model: "openai/gpt-6.2-sol", effort: "medium" },
    architect: { model: "openai/gpt-6.2-sol", effort: "medium" },
    backend: { model: "openai/gpt-6-luna", effort: "high" },
    frontend: { model: "openai/gpt-6-luna", effort: "high" },
  });
  assert.deepEqual(teamModelChoices([sol, luna], (model) => model === sol ? ["low", "medium"] : ["medium", "high"]), [
    { key: "openai/gpt-6.2-sol", label: "gpt-6.2-sol (openai)", efforts: ["low", "medium"] },
    { key: "openai/gpt-6-luna", label: "gpt-6-luna (openai)", efforts: ["medium", "high"] },
  ]);
  assert.equal(teamThinkingLevel, "high");
  assert.equal(resolveTeamModel([sol, luna], () => ["medium", "high"], "openai/gpt-6-luna", "high"), luna);
  assert.throws(() => resolveTeamModel([sol], () => ["medium"], "openai/gpt-6-luna", "high"), /unavailable/);
  assert.throws(() => resolveTeamModel([luna], () => ["medium"], "openai/gpt-6-luna", "high"), /not supported/);
});

test("role settings can change only before start and are applied to that role's worker", async () => {
  const choices = [
    { key: "openai/gpt-6.2-sol", label: "Sol", efforts: ["medium"] },
    { key: "openai/gpt-6-luna", label: "Luna", efforts: ["high"] },
  ];
  const { team, calls } = mockTeam({ modelChoices: choices, resolveRoleSettings: (role, selected) => {
    const choice = choices.find(({ key }) => key === selected.model);
    if (!choice) throw new Error(`Model ${selected.model} unavailable.`);
    if (!choice.efforts.includes(selected.effort)) throw new Error(`${selected.effort} unsupported for ${selected.model}.`);
    return { model: { provider: "openai", id: selected.model.split("/")[1] }, thinkingLevel: selected.effort };
  } });
  assert.deepEqual(team.snapshot().settings.po, { model: "openai/gpt-6.2-sol", effort: "medium" });
  assert.deepEqual(team.snapshot().settings.backend, { model: "openai/gpt-6-luna", effort: "high" });
  assert.throws(() => team.updateSettings("po", { model: "openai/nope", effort: "medium" }), /unavailable/);
  assert.throws(() => team.updateSettings("po", { model: "openai/gpt-6-luna", effort: "medium" }), /unsupported/);
  team.updateSettings("po", { model: "openai/gpt-6-luna", effort: "high" });
  assert.deepEqual(team.snapshot().roles.find(({ id }) => id === "po").model, "openai/gpt-6-luna");
  team.start("Run the task");
  await turn();
  assert.equal(calls[0].model.id, "gpt-6-luna");
  assert.equal(calls[0].thinkingLevel, "high");
  assert.throws(() => team.updateSettings("backend", { effort: "medium" }), /only be changed before/);
  team.close();
});

const paths = { cwd: "/tmp/shared-team", head: "base" };
const exampleChanges = { files: " M api.js\n?? ui.js", diff: "diff --git a/api.js b/api.js\n+<img src=x>\n+renderPanel()", truncated: false };
function mockTeam({ prepare = async ({ workspace }) => workspace ?? paths, saveAttachments, inspectWorkspace = async () => exampleChanges, modelChoices, resolveRoleSettings } = {}) {
  const calls = [];
  const disposed = [];
  let openedWorkers = 0;
  const team = createAgentTeam({ prepare, saveAttachments, inspectWorkspace, modelChoices, resolveRoleSettings, openWorker: async (opts) => {
    const worker = ++openedWorkers;
    let listener, resolve;
    const abort = () => { resolve?.(); return Promise.resolve(); };
    return {
      subscribe(fn) { listener = fn; return () => { listener = undefined; }; },
      dispose() { disposed.push(opts); void abort(); },
      abort,
      prompt(text, options) {
        return new Promise((done) => {
          resolve = done;
          calls.push({ ...opts, worker, text, options,
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
  return { team, calls, disposed };
}

test("hands off one shared workspace, pauses after two attempts, and resumes before the next implementer", async () => {
  const { team, calls, disposed } = mockTeam();
  team.start("Split the UI and server responsibility.");
  await turn();
  assert.equal(calls[0].writable, false);
  assert.equal(calls.length, 1);
  calls[0].finish("done", "Acceptance criteria");
  await turn();
  assert.match(calls[1].text, /Acceptance criteria/);
  calls[1].finish("done", "Backend owns API; frontend owns the panel.");
  await turn();
  assert.deepEqual(calls.map(({ cwd, writable }) => [cwd, writable]), [[paths.cwd, false], [paths.cwd, false], [paths.cwd, true]]);
  assert.match(calls[2].text, /Backend owns API/);
  calls[2].finish("retry", "First approach failed");
  await turn();
  calls[3].finish("retry", "No change after reading the loader");
  await turn();
  const backend = team.snapshot("backend").roles.find(({ id }) => id === "backend");
  assert.equal(backend.status, "paused");
  assert.match(backend.report, /Two attempts.*No change/);
  assert.equal(calls.length, 4, "frontend must not start while the backend is paused");
  assert.throws(() => team.resume("backend", backend.pause + 1, "Use the old route"), /not waiting/);
  team.resume("backend", backend.pause, "Use the old route");
  assert.throws(() => team.resume("backend", backend.pause, "Duplicate direction"), /not waiting/);
  await turn();
  assert.match(calls[4].text, /User direction: Use the old route/);
  calls[4].finish("done", "API is ready");
  await turn();
  assert.match(calls[5].text, /backend: API is ready/);
  assert.match(calls[5].text, /Current workspace changes \(Git status\):\n M api\.js/);
  calls[5].finish("done", "Panel is ready");
  await turn();
  assert.match(calls[6].text, /frontend: Panel is ready/);
  assert.equal(team.snapshot().result, undefined, "the combined result is not ready without review");
  calls[6].finish("done", "Tests still need to run");
  await turn();
  assert.equal(team.snapshot().phase, "done");
  assert.deepEqual(team.snapshot().result, exampleChanges);
  assert.equal(disposed.length, 0, "keep role sessions available for feedback");
  team.close();
  assert.equal(disposed.length, 4);
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

test("the shared worktree starts from committed HEAD, exposes the combined diff, and limits writes", async (t) => {
  const repo = await mkdtemp(join(tmpdir(), "team-test-repo-"));
  t.after(() => rm(repo, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  git("init");
  await writeFile(join(repo, "app.txt"), "base");
  git("add", "app.txt");
  git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "feat: add fixture");
  await writeFile(join(repo, "app.txt"), "unstaged user changes");
  const workspace = await prepareTeamWorkspace(repo);
  t.after(() => rm(dirname(workspace.cwd), { recursive: true, force: true }));
  const root = await realpath(workspace.cwd);
  const other = await realpath(repo);
  assert.equal(await readFile(join(root, "app.txt"), "utf8"), "base");
  await writeFile(await teamWritePath(root, "app.txt"), "backend edits");
  await writeFile(await teamWritePath(root, "ui.txt"), "frontend uses backend edits");
  const result = await inspectTeamWorkspace(workspace, true);
  assert.match(result.files, / M app\.txt\n\?\? ui\.txt/);
  assert.match(result.diff, /\+backend edits/);
  assert.match(result.diff, /\+frontend uses backend edits/);
  assert.equal(result.truncated, false);
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
  const initial = await (await api("/api/team", { headers })).json();
  assert.equal(initial.settings.po.model, "openai/gpt-6.2-sol");
  assert.equal(initial.settings.backend.effort, "high");
  assert.ok(Array.isArray(initial.modelChoices));
  const update = await api("/api/team", { method: "POST", headers, body: JSON.stringify({ action: "settings", role: "po", settings: { model: "openai/gpt-6-luna", effort: "medium" } }) });
  assert.equal(update.status, 200);
  assert.equal((await update.json()).settings.po.model, "openai/gpt-6-luna");
  assert.equal((await start(headers)).status, 202);
  assert.equal(calls.length, 1);
  assert.equal((await start(headers)).status, 400);
  opened.close();
  assert.equal(disposed.length, 1);
  assert.equal(team.snapshot().phase, "stopped");
});

test("closing and reopening the browser view keeps the running team and workspace", async (t) => {
  const { team, calls, disposed } = mockTeam();
  t.after(team.close);
  const chat = { getBranch: () => [], isIdle: () => true, team };
  const open = async () => {
    const listener = await startChatServer({ chat, closeTeamOnClose: false });
    t.after(listener.close);
    const url = new URL(listener.url);
    return (path, body) => fetch(url.origin + path, {
      headers: { Authorization: `Bearer ${url.hash.slice(1)}`, Origin: url.origin, "Content-Type": "application/json" },
      ...(body && { method: "POST", body: JSON.stringify(body) }),
    });
  };
  const first = await open();
  assert.equal((await first("/api/team", { action: "start", brief: "One task" })).status, 202);
  assert.equal((await first("/api/close", {})).status, 200);
  const second = await open();
  const snapshot = await (await second("/api/team?role=po")).json();
  assert.equal(snapshot.phase, "active");
  assert.equal(snapshot.round, 1);
  assert.deepEqual(snapshot.workspace, paths);
  assert.match(snapshot.messages[0].text, /One task/);
  assert.equal(calls.length, 1);
  assert.equal(disposed.length, 0);
});

const screenshot = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgZGIGAAAOAAfXb+R4AAAAAElFTkSuQmCC";
async function until(condition, message) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (condition()) return;
    await delay(10);
  }
  assert.fail(message);
}

function assertPreStartRoster(document) {
  const roster = document.getElementById("team-roles");
  const cards = [...roster.querySelectorAll(".team-card:not([hidden])")];
  assert.equal(roster.closest("#team-panel").hidden, false);
  assert.equal(roster.hidden, false);
  assert.deepEqual(cards.map((card) => card.querySelector("strong").textContent), [
    "Product owner", "Backend implementer", "Frontend implementer", "Software architect",
  ]);
  for (const card of cards) {
    assert.equal(card.querySelector(".team-card-state").textContent, "Not started");
    assert.equal(card.disabled, true, "there is no role transcript to open yet");
  }
}

test("served Teams view sends attachments, shows the combined result, and gives feedback to the same workers", async (t) => {
  const prepared = [];
  const { team, calls } = mockTeam({ prepare: async (options) => {
    prepared.push(options);
    if (prepared.length === 1) throw new Error("Could not prepare the test worktrees.");
    return options.workspace ?? paths;
  } });
  const branch = [{ id: "main-user", type: "message", message: { role: "user", content: "Private unrelated Main chat text" } }];
  const opened = await startChatServer({ chat: { getBranch: () => branch, isIdle: () => true, team } });
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
  const polls = [];
  const originalSetTimeout = window.setTimeout.bind(window);
  window.setTimeout = (fn, ms, ...args) => ms === 1000 && fn.name === "poll" ? polls.push(fn) : originalSetTimeout(fn, ms, ...args);
  await startChatPage(window, { loadNotes: async () => undefined });
  const $ = (id) => window.document.getElementById(id);
  await until(() => !$("team-view-toggle").hidden, "Teams toggle not ready");
  const toggle = $("team-view-toggle");
  const composer = $("chat-input");
  composer.value = "Unsent main draft";
  assert.equal(toggle.parentElement.id, "session-title-pill");
  const heading = toggle.closest(".chat-heading");
  assert.equal($("chat-form").previousElementSibling, heading);
  assert.equal(toggle.getAttribute("aria-label"), "Open Teams");
  for (const id of ["team-toggle", "team-back", "team-setup-back"]) assert.equal($(id), null);
  assert.equal(toggle.querySelector(".team-mode-icon[aria-hidden=true]").textContent, "🎮");
  assert.ok(toggle.querySelector("svg.chat-mode-icon[aria-hidden=true]"));
  for (const [id, label] of [["team-attach", "Attach files"], ["team-submit", "Start team"]]) {
    assert.equal($(id).getAttribute("aria-label"), label);
    assert.equal($(id).textContent.trim(), "");
    assert.ok($(id).querySelector("svg[aria-hidden=true]"));
  }
  toggle.click();
  assert.equal(toggle.getAttribute("aria-label"), "Return to main chat");
  assert.equal(toggle.getAttribute("aria-expanded"), "true");
  assert.equal($("team-setup").hidden, false);
  assert.equal(heading.parentElement.tagName, "MAIN", "Teams must not hide the toolbar with the live composer");
  assertPreStartRoster(window.document);
  assert.equal($("team-submit").parentElement.parentElement, $("team-attach").parentElement);
  assert.equal($("team-attach").nextElementSibling, $("team-submit").parentElement, "Attach files sits immediately before the start/stop action slot");
  assert.ok($("team-brief").rows >= 10);
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

  toggle.click();
  assert.equal(toggle.getAttribute("aria-label"), "Open Teams");
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  assert.equal($("team-setup").hidden, true);
  assert.equal($("team-panel").hidden, true);
  assert.equal($("chat-form").previousElementSibling, heading);
  assert.equal($("chat-input"), composer, "the same main composer remains mounted");
  assert.equal(composer.value, "Unsent main draft");
  toggle.click();
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
  assert.deepEqual(prepared, [{ hasImages: true, workspace: undefined }, { hasImages: true, workspace: undefined }]);
  assert.equal($("team-panel").hidden, false);
  assert.deepEqual([...$("team-roles").querySelectorAll(".team-card:not([hidden]):not(:disabled) strong")].map((name) => name.textContent), [
    "Main chat", "Product owner", "Backend implementer", "Frontend implementer", "Software architect",
  ]);
  assert.equal(composer.value, "Unsent main draft");
  calls[0].finish("done", "Scope approved");
  await turn();
  calls[1].finish("done", "Design ready");
  await turn();
  assert.equal(calls.length, 3);
  calls[2].finish("done", "Backend edited");
  await turn();
  assert.equal(calls.length, 4);
  for (const call of calls) {
    assert.doesNotMatch(call.text, /Private unrelated Main chat text|Unsent main draft/);
    assert.match(call.text, /Build the status screen/);
    assert.match(call.text, /Attached file: "acceptance\.md" ---\nUse a teal outline\./);
    assert.deepEqual(call.options.images, [{ type: "image", mimeType: "image/png", data: screenshot }]);
  }
  // Role transcripts stay small and don't retransmit attachment bytes.
  assert.doesNotMatch(JSON.stringify(team.snapshot("po").messages), /Use a teal outline|iVBORw0KGgo/);
  calls[3].finish("done", "Frontend wired");
  await turn();
  calls[4].finish("done", "Reviewed both changes");
  await turn();
  await polls.shift()();
  await until(() => !$("team-result").hidden, "Combined result did not open");
  assert.equal(heading.parentElement.tagName, "MAIN");
  assert.match($("team-result-workspace").textContent, /shared-team/);
  assert.match($("team-result-files").textContent, /api\.js[\s\S]+ui\.js/);
  assert.match($("team-result-diff").textContent, /<img src=x>/);
  assert.equal($("team-result-diff").querySelector("img"), null);
  toggle.click();
  assert.equal($("team-result").hidden, true, "main chat view replaces the team result without discarding it");
  toggle.click();
  assert.equal($("team-result").hidden, false, "returning to Teams restores the completed result");
  assert.match($("team-result-diff").textContent, /<img src=x>/);
  $("team-feedback").click();
  assert.equal($("team-result").hidden, true);
  assert.equal($("team-setup").hidden, false);
  assert.equal($("team-submit").getAttribute("aria-label"), "Send feedback");
  $("team-brief").value = "Make the status easier to read";
  $("team-brief").dispatchEvent(new window.Event("input"));
  $("team-submit").click();
  await until(() => calls.length === 6 && $("team-setup").hidden, "Feedback did not reach the runner");
  assert.deepEqual(prepared[2], { hasImages: false, workspace: paths });
  assert.equal(calls[5].worker, calls[0].worker);
  assert.match(calls[5].text, /Build the status screen[\s\S]+User feedback for round 2:\nMake the status easier to read/);
  assert.equal(calls[5].options.images, undefined, "do not resend past round attachments");
  assert.match(JSON.stringify(team.snapshot("po").messages), /Scope approved/, "the role transcript is retained");
});

test("the composer shows its stop icon while the team is preparing worktrees", async (t) => {
  const dom = new JSDOM(await readFile(new URL("../web/index.html", import.meta.url), "utf8"));
  t.after(() => dom.window.close());
  const { window } = dom;
  const $ = (id) => window.document.getElementById(id);
  const prep = Promise.withResolvers();
  const { team, calls } = mockTeam({ prepare: () => prep.promise });
  t.after(() => { team.close(); prep.resolve(paths); });
  const ui = mountAgentTeam(window, { onViewChange() {}, async api(_path, body) {
    if (body?.action === "start") team.start(body.brief, body.attachments);
    if (body?.action === "stop") team.close();
    return team.snapshot();
  } });
  await ui.refresh();
  $("team-view-toggle").click();
  $("team-brief").value = "Build the status screen";
  $("team-brief").dispatchEvent(new window.Event("input"));
  $("team-submit").click();
  await turn();
  assert.equal($("team-submit").hidden, true);
  assert.equal($("team-cancel-start").hidden, false);
  assertPreStartRoster(window.document);
  $("team-cancel-start").click();
  await turn();
  prep.resolve(paths);
  await turn();
  assert.equal(team.snapshot().phase, "stopped");
  assert.equal(calls.length, 0);
  assert.match($("team-status").textContent, /Team stopped/);
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

test("legacy team reports remain readable in the main transcript without becoming branchable", async (t) => {
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

test("team role controls show backend choices, update a role, and lock after start", async (t) => {
  const dom = new JSDOM(await readFile(new URL("../web/index.html", import.meta.url), "utf8"));
  t.after(() => dom.window.close());
  const d = dom.window.document;
  const modelChoices = [
    { key: "openai/gpt-6.2-sol", label: "Sol", efforts: ["medium", "high"] },
    { key: "openai/gpt-6-luna", label: "Luna", efforts: ["high"] },
  ];
  const settings = { po: { model: modelChoices[0].key, effort: "medium" }, architect: { model: modelChoices[0].key, effort: "medium" }, backend: { model: modelChoices[1].key, effort: "high" }, frontend: { model: modelChoices[1].key, effort: "high" } };
  let phase = "idle";
  const roles = [{ id: "po", name: "Product owner" }, { id: "architect", name: "Software architect" }, { id: "backend", name: "Backend implementer" }, { id: "frontend", name: "Frontend implementer" }];
  const posts = [];
  const current = () => ({ phase, revision: 1, modelChoices, settings, roles: roles.map((role) => ({ ...role, ...settings[role.id], status: "queued" })) });
  const ui = mountAgentTeam(dom.window, { onViewChange() {}, api: async (_path, body) => {
    if (body?.action === "settings") { posts.push(body); Object.assign(settings[body.role], body.settings); return current(); }
    return current();
  } });
  await ui.refresh();
  d.getElementById("team-view-toggle").click();
  const poCard = d.querySelector('.team-card[data-role="po"]').parentElement;
  const poGear = poCard.querySelector(".team-agent-gear");
  poGear.click();
  assert.equal(poGear.getAttribute("aria-expanded"), "true");
  assert.match(poCard.querySelector(".team-agent-settings-status").textContent, /Sol · medium effort/);
  const modelInput = poCard.querySelector('[role="combobox"]');
  modelInput.value = "Luna";
  modelInput.dispatchEvent(new dom.window.Event("input"));
  poCard.querySelector('.team-agent-model-options [role="option"]').click();
  await turn();
  assert.deepEqual(posts, [{ action: "settings", role: "po", settings: { model: modelChoices[1].key, effort: "high" } }]);
  assert.deepEqual(settings.architect, { model: modelChoices[0].key, effort: "medium" }, "only the selected role is changed");
  phase = "active";
  await ui.refresh(true);
  assert.equal(poGear.disabled, true);
  assert.match(poCard.querySelector(".team-agent-settings-status").textContent, /locked/);
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
  assert.equal(d.getElementById("team-attention-dot").hidden, false);
  const toggle = d.getElementById("team-view-toggle");
  toggle.click();
  assert.equal(d.querySelectorAll(".team-card svg").length, 5);
  const [lead, po, backend] = d.querySelectorAll(".team-card");
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
  lead.click();
  assert.equal(ui.viewingTeam(), false);
  assert.equal(d.getElementById("team-conversation").hidden, true);
  assert.equal(d.getElementById("team-panel").hidden, false);
  backend.click();
  toggle.click();
  assert.equal(ui.viewingTeam(), false);
  assert.equal(d.getElementById("team-conversation").hidden, true);
  assert.equal(d.getElementById("team-panel").hidden, true);
  assert.equal(d.getElementById("chat-tools-content").hidden, false);
});
