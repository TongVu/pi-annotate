import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setImmediate as turn, setTimeout as delay } from "node:timers/promises";
import { JSDOM } from "jsdom";
import { assistTeamStaleEdit, createAgentTeam, inspectTeamWorkspace, prepareTeamWorkspace, resolveTeamModel, teamModelChoices, teamRoleDefaults, teamThinkingLevel, teamWritePath } from "../src/agent-team.ts";
import { teamHandoffType, teamReportType } from "../src/chat-transcript.ts";
import { startChatServer } from "../src/server.ts";
import { startChatPage } from "../web/app.js";
import { mountAgentTeam } from "../web/chat/team.js";
import { mountTranscript } from "../web/chat/transcript.js";

test("the model resolver validates exact model and effort pairs without substituting a model", () => {
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
  assert.match(team.updateSettings("po", { model: "openai/nope", effort: "medium" }).roles.find(({ id }) => id === "po").settingsFallback, /Using role defaults.*unavailable/);
  assert.match(team.updateSettings("po", { model: "openai/gpt-6-luna", effort: "medium" }).roles.find(({ id }) => id === "po").settingsFallback, /Using role defaults.*unsupported/);
  assert.deepEqual(team.snapshot().settings.po, teamRoleDefaults.po);
  team.updateSettings("po", { model: "openai/gpt-6-luna", effort: "high" });
  assert.deepEqual(team.snapshot().roles.find(({ id }) => id === "po").model, "openai/gpt-6-luna");
  assert.equal(team.snapshot().roles.find(({ id }) => id === "po").settingsFallback, undefined);
  team.start("Run the task");
  await turn();
  assert.equal(calls[0].model.id, "gpt-6-luna");
  assert.equal(calls[0].thinkingLevel, "high");
  assert.throws(() => team.updateSettings("backend", { effort: "medium" }), /only be changed before/);
  team.close();
});

test("start revalidates role defaults and never substitutes an arbitrary model", async (t) => {
  const unavailable = new Set();
  const { team, calls } = mockTeam({ resolveRoleSettings: (_role, { model, effort }) => {
    if (unavailable.has(model)) throw new Error(`${model} unavailable`);
    return { model: { id: model }, thinkingLevel: effort };
  } });
  t.after(team.close);
  team.updateSettings("po", { model: "custom/custom-model", effort: "medium" });
  unavailable.add("custom/custom-model");
  unavailable.add(teamRoleDefaults.po.model);
  assert.throws(() => team.start("Test unavailable defaults"), /Product owner settings and defaults are unavailable/);
  assert.equal(team.snapshot().phase, "idle");
  unavailable.delete(teamRoleDefaults.po.model);
  team.start("Use the validated default");
  await until(() => calls.length === 1, "worker did not start");
  assert.equal(calls[0].model.id, teamRoleDefaults.po.model);
  assert.match(team.snapshot().roles[0].settingsFallback, /Using role defaults/);
});

const paths = { cwd: "/tmp/shared-team", head: "base" };
const apiPatch = "diff --git a/api.js b/api.js\nindex 1..2 100644\n--- a/api.js\n+++ b/api.js\n@@ -1,2 +1,3 @@\n--- old content\n+++ new content\n context survives\n+<img src=x>\n";
const uiPatch = "diff --git a/ui.js b/ui.js\nnew file mode 100644\n--- /dev/null\n+++ b/ui.js\n@@ -0,0 +1 @@\n+UI file content\n";
const emptyPatch = "diff --git a/dev/null b/empty.txt\nnew file mode 100644\nindex 0000000..e69de29\n";
const exampleDiff = apiPatch + uiPatch + emptyPatch;
const exampleChanges = { files: " M api.js\n?? ui.js\n?? empty.txt", diff: exampleDiff, truncated: false, changedFiles: [
  { key: "api", path: "api.js", status: "M", start: 0, end: apiPatch.length },
  { key: "ui", path: "ui.js", status: "?", start: apiPatch.length, end: apiPatch.length + uiPatch.length },
  { key: "empty", path: "empty.txt", status: "?", start: apiPatch.length + uiPatch.length, end: exampleDiff.length },
] };
function mockTeam({ prepare = async ({ workspace }) => workspace ?? paths, saveAttachments, inspectWorkspace = async () => exampleChanges, modelChoices, resolveRoleSettings, captureHandoff, assistStaleEdit } = {}) {
  const calls = [];
  const disposed = [];
  let openedWorkers = 0;
  const team = createAgentTeam({ prepare, saveAttachments, inspectWorkspace, modelChoices, resolveRoleSettings, captureHandoff, assistStaleEdit, openWorker: async (opts) => {
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

const stalePath = "web/chat/team.css";
const staleDetail = `Could not find edits[0] in ${stalePath}. The oldText must match exactly including all whitespace and newlines.`;
function staleEdit(call, id) {
  call.event({ type: "tool_execution_start", toolCallId: id, toolName: "team_edit", args: { path: stalePath, edits: [{ oldText: "old", newText: "new" }] } });
  call.event({ type: "tool_execution_end", toolCallId: id, toolName: "team_edit", isError: true, result: { content: [{ type: "text", text: staleDetail }] } });
}
async function reachBackend(team, calls) {
  team.start("Improve the shared composer");
  await turn();
  calls[0].finish("done", "Scope set");
  await turn();
  calls[1].finish("done", "Design set");
  await turn();
}

test("stale edits get one re-read retry and one Main chat assist on the same worker, then pause", async (t) => {
  const assisted = [];
  const { team, calls } = mockTeam({ assistStaleEdit: async (blocker) => {
    assisted.push(blocker);
    return "Main chat checked the current target; re-read it and retry the smallest exact edit.";
  } });
  t.after(team.close);
  await reachBackend(team, calls);
  const worker = calls[2].worker;
  staleEdit(calls[2], "first");
  calls[2].finish("blocked", staleDetail);
  await turn();
  assert.match(calls[3].text, /Re-read the current file at "web\/chat\/team\.css".*smallest unique oldText/);
  assert.equal(calls[3].worker, worker);
  assert.deepEqual(assisted, []);
  assert.equal(team.snapshot().roles.find(({ id }) => id === "backend").status, "working");
  staleEdit(calls[3], "second");
  staleEdit(calls[3], "third");
  await turn();
  assert.deepEqual(assisted, [{ role: "Backend implementer", path: stalePath, detail: staleDetail, edit: { oldText: "old", newText: "new" }, workspace: paths }]);
  assert.match(calls[4].text, /Main chat checked the current target/);
  assert.equal(calls[4].worker, worker);
  assert.ok(team.snapshot("backend").messages.some(({ who }) => who === "Main chat"));
  staleEdit(calls[4], "last");
  calls[4].finish("retry", "Still stale");
  await turn();
  const role = team.snapshot().roles.find(({ id }) => id === "backend");
  assert.equal(role.status, "paused");
  assert.match(role.report, /Could not recover the exact-match edit/);
  assert.equal(calls.length, 5);
});

test("a real product decision still pauses even after a stale edit was reported", async (t) => {
  let assisted = false;
  const { team, calls } = mockTeam({ assistStaleEdit: async () => { assisted = true; return "Unexpected assist"; } });
  t.after(team.close);
  await reachBackend(team, calls);
  staleEdit(calls[2], "before-decision");
  calls[2].finish("blocked", "Should this change apply to all chats or Teams only?");
  await turn();
  const role = team.snapshot().roles.find(({ id }) => id === "backend");
  assert.equal(role.status, "paused");
  assert.match(role.report, /all chats or Teams only/);
  assert.equal(assisted, false);
  assert.equal(calls.length, 3);
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
  const pathspecName = ":(glob)*.txt";
  await writeFile(await teamWritePath(root, pathspecName), "pathspec-like filename");
  const result = await inspectTeamWorkspace(workspace, true);
  assert.match(result.files, / M app\.txt/);
  assert.match(result.files, /\?\? ui\.txt/);
  assert.match(result.diff, /\+backend edits/);
  assert.match(result.diff, /\+frontend uses backend edits/);
  assert.equal(result.truncated, false);
  assert.deepEqual(result.patchCheck, { status: "passed" });
  const pathspecFile = result.changedFiles.find(({ path }) => path === pathspecName);
  assert.ok(pathspecFile && pathspecFile.start !== null && pathspecFile.end !== null);
  assert.match(result.diff.slice(pathspecFile.start, pathspecFile.end), /\+pathspec-like filename/);
  await writeFile(join(root, "ui.txt"), "trailing whitespace \n");
  const bad = await inspectTeamWorkspace(workspace, true);
  assert.equal(bad.patchCheck.status, "issues");
  assert.match(bad.patchCheck.details, /ui\.txt:1: trailing whitespace/);
  const assist = (edit) => assistTeamStaleEdit({ workspace, path: "ui.txt", edit });
  assert.match(await assist(), /Main chat confirmed.*Re-read the current file/);
  assert.match(await assist({ oldText: "  trailing whitespace\n", newText: "clean text" }), /matches line 1 after trimming whitespace/);
  assert.match(await assist({ oldText: "A different line", newText: "trailing whitespace" }), /replacement text occurs once and the old text is absent/);
  assert.equal(await readFile(join(root, "ui.txt"), "utf8"), "trailing whitespace \n", "automatic help is read-only");
  assert.equal(await readFile(join(repo, "app.txt"), "utf8"), "unstaged user changes");
  await symlink(other, join(root, "escape"), "dir");
  await symlink(join(other, "new.txt"), join(root, "dangling"));
  for (const path of ["../frontend/app.txt", ".git", "escape/new.txt", "dangling"]) {
    await assert.rejects(teamWritePath(root, path), /worktree|symlink/);
    await assert.rejects(assistTeamStaleEdit({ workspace, path }), /worktree|symlink/);
  }
});

test("team retains the requirement, caps feedback at three reviews, and stops on discard", async (t) => {
  const { team, calls, disposed } = mockTeam();
  t.after(team.close);
  for (let index = 0; index < 3; index++) {
    team.start(index ? `Feedback ${index}` : "Original requirement", undefined, index > 0);
    for (let stage = 0; stage < 5; stage++) {
      await turn();
      calls[index * 5 + stage].finish("done", "Reviewed work");
    }
    await turn();
    assert.equal(team.snapshot().phase, "done");
    assert.equal(team.snapshot().round, index + 1);
    assert.equal(team.snapshot().brief, "Original requirement");
    assert.equal(team.snapshot().feedback, index ? `Feedback ${index}` : "");
  }
  assert.throws(() => team.start("Fourth round", undefined, true), /3-round limit/);
  await team.finish("discard", paths.cwd, () => true);
  assert.equal(team.snapshot().phase, "stopped");
  assert.equal(team.snapshot().disposition, "discarded");
  assert.deepEqual(team.snapshot().result, exampleChanges);
  assert.equal(disposed.length, 4);
});

test("apply checks the reviewed Git patch and leaves the result unstaged", async (t) => {
  const repo = await mkdtemp(join(tmpdir(), "team-apply-test-"));
  t.after(() => rm(repo, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" }).toString();
  git("init");
  await writeFile(join(repo, "app.txt"), "base\n");
  git("add", "app.txt");
  git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "feat: add fixture");
  const workspace = await prepareTeamWorkspace(repo);
  t.after(() => rm(dirname(workspace.cwd), { recursive: true, force: true }));
  const { team, calls } = mockTeam({ prepare: async () => workspace, inspectWorkspace: inspectTeamWorkspace });
  t.after(team.close);
  team.start("Edit the fixture");
  for (let stage = 0; stage < 5; stage++) {
    await until(() => calls.length > stage, "worker did not start");
    if (stage === 2) await writeFile(join(workspace.cwd, "app.txt"), "team edit\n");
    if (stage === 3) await writeFile(join(workspace.cwd, "new.txt"), "new file\n");
    calls[stage].finish("done", "Reviewed work");
  }
  await until(() => team.snapshot().phase === "done", "review did not finish");
  const confirmation = team.snapshot();
  assert.equal(typeof confirmation.applyToken, "string");
  assert.equal(team.validateApplyToken(confirmation.applyToken), true);
  assert.equal(team.validateApplyToken(`${confirmation.applyToken}stale`), false);
  const originalToken = confirmation.applyToken;
  assert.deepEqual(confirmation.result.changedFiles.map(({ path, start, end }) => [path, start, end]), [
    ["app.txt", confirmation.result.diff.indexOf("diff --git"), confirmation.result.diff.lastIndexOf("diff --git")],
    ["new.txt", confirmation.result.diff.lastIndexOf("diff --git"), confirmation.result.diff.length],
  ]);
  await writeFile(join(workspace.cwd, "app.txt"), "not reviewed\n");
  await assert.rejects(team.finish("apply", repo, () => true), /changed after review/);
  assert.equal(team.validateApplyToken(originalToken), false, "failed confirmation receives a fresh token");
  await writeFile(join(workspace.cwd, "app.txt"), "team edit\n");
  await writeFile(join(repo, "app.txt"), "user edit\n");
  const dirtyCheckoutToken = team.snapshot().applyToken;
  await assert.rejects(team.finish("apply", repo, () => true), /clean checkout/);
  assert.equal(team.validateApplyToken(dirtyCheckoutToken), false, "dirty-checkout rejection invalidates its token");
  assert.equal(typeof team.snapshot().applyToken, "string");
  assert.notEqual(team.snapshot().applyToken, dirtyCheckoutToken);
  assert.equal(await readFile(join(repo, "app.txt"), "utf8"), "user edit\n");
  await writeFile(join(repo, "app.txt"), "base\n");
  await assert.rejects(team.finish("apply", repo, () => false), /changed/);
  await team.finish("apply", repo, () => true);
  assert.equal(team.snapshot().disposition, "applied");
  assert.equal(git("rev-parse", "HEAD").trim(), workspace.head);
  assert.match(git("status", "--porcelain"), / M app\.txt\n\?\? new\.txt/);
  assert.equal(await readFile(join(repo, "new.txt"), "utf8"), "new file\n");
});

test("team API binds explicit apply to a same-origin current-round token and rejects stale confirmations", async (t) => {
  let accepted = 0;
  let branchCurrent = false;
  const team = {
    snapshot: () => ({ round: 2, phase: "done" }),
    validateApplyToken: (token) => token === "current-token",
    finish: async (action, cwd, isCurrent) => { assert.equal(action, "apply"); assert.equal(cwd, "/checkout"); assert.equal(isCurrent(), true); accepted++; },
    close() {},
  };
  const opened = await startChatServer({ chat: { team, getCwd: () => "/checkout", isTeamApplyCurrent: () => branchCurrent } });
  t.after(opened.close);
  const url = new URL(opened.url);
  const headers = { Authorization: `Bearer ${url.hash.slice(1)}`, Origin: url.origin, "Content-Type": "application/json" };
  const send = (body, overrides) => fetch(`${url.origin}/api/team`, { method: "POST", headers: { ...headers, ...overrides }, body: JSON.stringify(body) });
  const confirmation = { action: "apply", round: 2, applyToken: "current-token" };
  assert.equal((await send(confirmation, { Authorization: "" })).status, 401);
  assert.equal((await send(confirmation, { Origin: "http://another.invalid" })).status, 403);
  assert.equal((await send({ action: "apply", round: 1, applyToken: "current-token" })).status, 400);
  assert.equal((await send({ action: "apply", round: 2, applyToken: "stale-token" })).status, 400);
  assert.equal(accepted, 0);
  assert.equal((await send(confirmation)).status, 400, "reopened/old-branch listener cannot apply");
  assert.equal(accepted, 0);
  branchCurrent = true;
  assert.equal((await send(confirmation)).status, 200);
  assert.equal(accepted, 1);
});

test("apply listener currency predicate rejects a post-confirmation stale transition once before writing", async (t) => {
  const checkout = await mkdtemp(join(tmpdir(), "team-stale-listener-"));
  t.after(() => rm(checkout, { recursive: true, force: true }));
  const target = join(checkout, "reviewed.txt");
  await writeFile(target, "unchanged checkout\\n");
  let listenerCurrent = true;
  let writes = 0;
  const team = {
    snapshot: () => ({ round: 1, phase: "done" }),
    validateApplyToken: (token) => token === "valid-token",
    finish: async (_action, _cwd, isCurrent) => {
      listenerCurrent = false; // Simulate a branch/listener transition after confirmation but before the write.
      if (!isCurrent()) throw new Error("The Main chat or team changed. No changes were applied.");
      writes++;
      await writeFile(target, "unexpected write\\n");
    },
    close() {},
  };
  const opened = await startChatServer({ chat: { team, getCwd: () => checkout, isTeamApplyCurrent: () => listenerCurrent }, isCurrent: () => listenerCurrent });
  t.after(opened.close);
  const url = new URL(opened.url);
  const response = await fetch(`${url.origin}/api/team`, {
    method: "POST",
    headers: { Authorization: `Bearer ${url.hash.slice(1)}`, Origin: url.origin, "Content-Type": "application/json" },
    body: JSON.stringify({ action: "apply", round: 1, applyToken: "valid-token" }),
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /changed/);
  assert.equal(writes, 0);
  assert.equal(await readFile(target, "utf8"), "unchanged checkout\\n");
});

test("team API requires the live chat token and same-origin POSTs; close disposes workers without handing off", async (t) => {
  let delivered = false;
  const { team, calls, disposed } = mockTeam({ captureHandoff: () => () => (delivered = true) });
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
  await turn();
  assert.equal(delivered, false);
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
    "Main conversation", "Product owner", "Backend implementer", "Frontend implementer", "Software architect",
  ]);
  for (const card of cards) {
    if (card.dataset.role !== "lead") assert.equal(card.querySelector(".team-card-state").textContent, "Not started");
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
  let postRequests = 0;
  window.fetch = (path, opts = {}) => {
    if (opts.method === "POST") postRequests++;
    return fetch(url.origin + path, { ...opts,
      headers: { ...opts.headers, ...(opts.method === "POST" ? { Origin: url.origin } : {}) },
    });
  };
  // jsdom does not implement native dialog methods; retain the browser's open/close state for this UI test.
  window.HTMLDialogElement.prototype.showModal = function() { this.open = true; };
  window.HTMLDialogElement.prototype.close = function() { this.open = false; };
  let poll;
  const originalSetTimeout = window.setTimeout.bind(window);
  const originalClearTimeout = window.clearTimeout.bind(window);
  window.setTimeout = (fn, ms, ...args) => {
    if (fn.name !== "poll") return originalSetTimeout(fn, ms, ...args);
    poll = fn;
    return -1;
  };
  window.clearTimeout = (id) => {
    if (id === -1) poll = undefined;
    else originalClearTimeout(id);
  };
  const runPoll = () => {
    const next = poll;
    assert.ok(next, "expected a scheduled chat poll");
    poll = undefined;
    return next();
  };
  await startChatPage(window, { loadNotes: async () => undefined });
  const $ = (id) => window.document.getElementById(id);
  await until(() => !$("team-view-toggle").hidden, "Teams toggle not ready");
  const toggle = $("team-view-toggle");
  const composer = $("chat-input");
  composer.value = "Unsent main draft";
  assert.ok($("chat-form").contains(toggle));
  assert.equal(toggle.previousElementSibling, $("status"));
  const heading = $("chat-form").previousElementSibling;
  assert.ok(heading.matches(".chat-heading"));
  assert.equal($("session-title-status").textContent, "Ready");
  assert.equal(toggle.getAttribute("aria-label"), "Open Teams");
  for (const id of ["team-toggle", "team-back", "team-setup-back"]) assert.equal($(id), null);
  assert.ok(toggle.querySelector("svg.team-mode-icon[aria-hidden=true]"));
  for (const [id, label] of [["team-attach", "Attach files"], ["team-submit", "Send requirement"]]) {
    assert.equal($(id).getAttribute("aria-label"), label);
    assert.equal($(id).textContent.trim(), "");
    assert.ok($(id).querySelector("svg[aria-hidden=true]"));
  }
  toggle.click();
  assert.equal(toggle.getAttribute("aria-label"), "Hide Teams");
  assert.equal(toggle.getAttribute("aria-expanded"), "true");
  assert.equal($("team-setup").hidden, false);
  assert.equal($("chat-form").previousElementSibling, heading, "Teams keeps the session toolbar beside the same composer");
  assert.equal(heading.parentElement.id, "conversation");
  assert.equal($("chat-tools-content").hidden, false);
  assert.equal($("team-panel").parentElement, window.document.body, "the team sidebar is outside the notes and the conversation");
  assert.equal(composer.readOnly, true);
  assertPreStartRoster(window.document);
  const setupActions = window.document.querySelector(".team-setup-actions");
  assert.ok(setupActions, "the setup footer exists");
  assert.equal($("team-attachments").parentElement, setupActions);
  assert.equal($("team-attachments").nextElementSibling, $("team-attach").parentElement);
  assert.equal($("team-attach").parentElement, $("team-submit").parentElement, "Attach files and Send requirement share the action group");
  assert.equal($("team-attach").nextElementSibling, $("team-submit"), "Attach files sits immediately before Send requirement");
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
  const key = (options) => $("team-brief").dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", cancelable: true, bubbles: true, ...options }));
  assert.equal(key({ shiftKey: true }), true);
  assert.equal(key({ isComposing: true }), true);
  assert.equal(key({ repeat: true }), false);
  assert.equal(calls.length, 0);
  assert.equal(key({}), false);
  await until(() => calls.length === 1 && $("team-setup").hidden, "Start did not reach the runner and show team status");
  assert.deepEqual(prepared, Array.from({ length: 2 }, () => ({ hasImages: true, workspace: undefined, settings: teamRoleDefaults })));
  assert.equal($("team-panel").hidden, false);
  assert.deepEqual([...$("team-roles").querySelectorAll(".team-card:not([hidden]):not(:disabled) strong")].map((name) => name.textContent), [
    "Main conversation", "Product owner", "Backend implementer", "Frontend implementer", "Software architect",
  ]);
  assert.equal(composer.value, "Unsent main draft");
  assert.equal(composer.readOnly, false);
  assert.equal(window.document.activeElement, composer);
  $("team-context-tab").click();
  assert.equal($("team-roster-view").hidden, true);
  assert.equal($("team-context").hidden, false);
  assert.equal($("team-task-brief").textContent, "Build the status screen");
  assert.match($("team-context").textContent, /coordinates the team/);
  $("team-roster-tab").click();
  assert.equal($("team-roster-view").hidden, false);
  assert.equal($("team-context").hidden, true);
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
  await runPoll();
  await until(() => !$("team-open-result").hidden, "Combined result did not become available");
  assert.equal($("team-result").hidden, true, "completion must not interrupt Main chat");
  assert.equal(composer.readOnly, false);
  for (const [id, icon, label] of [["team-open-result", "⁉️", "View team result"], ["team-apply-result", "✅", "Apply team result"]]) {
    assert.equal($(id).textContent, `${icon} ${label}`);
    assert.equal($(id).getAttribute("aria-label"), label);
    assert.equal($(id).firstElementChild.getAttribute("aria-hidden"), "true");
  }
  $("team-open-result").click();
  assert.equal($("team-result").hidden, false);
  assert.equal(heading.parentElement.id, "conversation");
  assert.match($("team-result-workspace").textContent, /shared-team/);
  const copied = [];
  const clipboard = { writeText: async (text) => { copied.push(text); } };
  Object.defineProperty(window.navigator, "clipboard", { value: clipboard });
  assert.equal($("team-copy-workspace").getAttribute("aria-label"), "Copy workspace path");
  $("team-copy-workspace").click();
  await until(() => $("team-workspace-copy-status").textContent === "Workspace path copied.");
  assert.deepEqual(copied, [$("team-result-workspace").textContent]);
  clipboard.writeText = async () => { throw new Error("Not permitted"); };
  $("team-copy-workspace").click();
  await until(() => $("team-workspace-copy-status").textContent.includes("copy manually"));
  assert.equal($("team-result-title").textContent, "Build the status screen");
  assert.equal($("team-result-brief").textContent, "Build the status screen");
  assert.match($("team-round").textContent, /Reviewed.*Round 1 of 3/);
  assert.match($("team-result-files").textContent, /api\.js[\s\S]+ui\.js/);
  assert.equal($("team-result-file-count").textContent, "3 files");
  const resultFiles = [...$("team-result-files").querySelectorAll('[role="option"]')];
  assert.equal(resultFiles.length, 3);
  assert.equal(resultFiles[0].getAttribute("aria-selected"), "true", "select the first changed file by default");
  assert.match($("team-result-diff").textContent, /<img src=x>/);
  assert.match($("team-result-diff").textContent, /@@ -1,2 \+1,3 @@/);
  assert.equal($("team-result-diff").querySelector("img"), null);
  const displayedDiffRows = [...$("team-result-diff").querySelectorAll(".team-diff-line")];
  assert.equal(displayedDiffRows.length, 4);
  assert.deepEqual([...displayedDiffRows[0].children].map((node) => node.textContent), ["1", "", "−", "-- old content"]);
  assert.equal(displayedDiffRows[0].classList.contains("team-diff-remove"), true);
  assert.deepEqual([...displayedDiffRows[1].children].map((node) => node.textContent), ["", "1", "+", "++ new content"]);
  assert.equal(displayedDiffRows[1].classList.contains("team-diff-add"), true);
  assert.deepEqual([...displayedDiffRows[2].children].map((node) => node.textContent), ["2", "2", "", "context survives"]);
  assert.deepEqual([...displayedDiffRows[3].children].map((node) => node.textContent), ["", "3", "+", "<img src=x>"]);
  resultFiles[1].click();
  assert.equal($("team-result-files").querySelector('[aria-selected="true"]').textContent, "A ui.js");
  assert.equal($("team-result-files").querySelector('[aria-selected="true"]').getAttribute("aria-label"), "Added: ui.js");
  assert.match($("team-result-diff").textContent, /UI file content/);
  assert.doesNotMatch($("team-result-diff").textContent, /<img src=x>/, "file switching never shows another file's patch");
  $("team-result-files").querySelectorAll('[role="option"]')[2].click();
  assert.equal($("team-result-files").querySelector('[aria-selected="true"]').textContent, "A empty.txt");
  assert.match($("team-result-diff").textContent, /No text diff is available.*metadata-only change/);
  assert.equal($("team-result-diff").querySelectorAll(".team-diff-line, .team-diff-hunk").length, 0, "file metadata is not shown as numbered diff content");
  $("team-result-files").querySelector('[role="option"]').click();
  const currentFirstFile = $("team-result-files").querySelector('[role="option"]');
  currentFirstFile.focus();
  currentFirstFile.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
  assert.equal($("team-result-files").querySelector('[aria-selected="true"]').textContent, "A ui.js", "arrow keys switch files");
  $("team-result-files").querySelector('[role="option"]').click();
  assert.equal($("team-apply-result").hidden, false, "Apply is available for the reviewed result");
  assert.equal($("team-apply-result").previousElementSibling, $("team-open-result"), "Apply sits beside View");
  const postsBeforeCancel = postRequests;
  $("team-apply-result").click();
  assert.equal($("team-apply-dialog").open, true);
  assert.match($("team-apply-description").textContent, /original checkout.*unstaged.*does not commit or push/i);
  $("team-apply-cancel").click();
  assert.equal($("team-apply-dialog").open, false);
  assert.equal(postRequests, postsBeforeCancel, "Cancel sends no apply request");
  $("team-apply-result").click();
  const escapeCancel = new window.Event("cancel", { cancelable: true });
  assert.equal($("team-apply-dialog").dispatchEvent(escapeCancel), true, "Escape cancellation is not prevented");
  if (!escapeCancel.defaultPrevented) $("team-apply-dialog").close();
  assert.equal(postRequests, postsBeforeCancel, "Escape sends no apply request");
  toggle.click();
  assert.equal($("team-result").hidden, true, "main chat view replaces the team result without discarding it");
  toggle.click();
  assert.equal($("team-result").hidden, true, "reopening the sidebar does not leave Main chat");
  $("team-open-result").click();
  assert.match($("team-result-diff").textContent, /<img src=x>/);
  $("team-feedback").click();
  assert.equal($("team-result").hidden, true);
  assert.equal($("team-setup").hidden, false);
  assert.equal($("team-submit").getAttribute("aria-label"), "Send feedback");
  $("team-brief").value = "Make the status easier to read";
  $("team-brief").dispatchEvent(new window.Event("input"));
  $("team-submit").click();
  await until(() => calls.length === 6 && $("team-setup").hidden, "Feedback did not reach the runner");
  assert.deepEqual(prepared[2], { hasImages: false, workspace: paths, settings: teamRoleDefaults });
  assert.equal(calls[5].worker, calls[0].worker);
  assert.match(calls[5].text, /Build the status screen[\s\S]+User feedback for round 2:\nMake the status easier to read/);
  assert.equal(calls[5].options.images, undefined, "do not resend past round attachments");
  assert.match(JSON.stringify(team.snapshot("po").messages), /Scope approved/, "the role transcript is retained");
});

test("team result distinguishes binary, unavailable, truncated, and empty previews", async (t) => {
  const dom = new JSDOM(await readFile(new URL("../web/index.html", import.meta.url), "utf8"));
  t.after(() => dom.window.close());
  const d = dom.window.document;
  const binaryPatch = `diff --git a/image "quoted".png b/image "quoted".png
GIT binary patch
literal 1
`;
  const snapshot = { phase: "done", revision: 1, round: 1, maxRounds: 3, brief: "Preview files", roles: [],
    workspace: { cwd: "/tmp/team" }, result: { files: "binary and text", diff: binaryPatch, truncated: true, changedFiles: [
      { key: "binary", path: 'image "quoted".png', status: "M", start: 0, end: binaryPatch.length },
      { key: "text", path: "src/not-in-preview.txt", status: "M", start: null, end: null },
    ] } };
  const ui = mountAgentTeam(dom.window, { onViewChange() {}, api: async (_path) => snapshot });
  await ui.refresh();
  d.getElementById("team-view-toggle").click();
  d.getElementById("team-open-result").click();
  assert.equal(d.getElementById("team-result-truncated").hidden, false);
  assert.match(d.getElementById("team-result-files").textContent, /image "quoted"\.png/, "paths render literally");
  assert.match(d.getElementById("team-result-diff").textContent, /No displayable text patch/);
  d.getElementById("team-result-files").querySelectorAll('[role="option"]')[1].click();
  assert.match(d.getElementById("team-result-diff").textContent, /No displayable text patch/, "null range does not borrow another file's diff");
  snapshot.result = { files: "", diff: "", truncated: false, changedFiles: [] };
  snapshot.revision++;
  await ui.refresh(true);
  assert.match(d.getElementById("team-result-diff").textContent, /No changes to display/);
  assert.equal(d.getElementById("team-result-truncated").hidden, true);
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

test("Main chat shows a handoff receipt, not the raw handoff, and still renders legacy team reports", async (t) => {
  const branch = [{ id: "previous", type: "message", message: { role: "assistant", content: "I’m ready." } }];
  const opened = await startChatServer({ chat: { getBranch: () => branch, isIdle: () => true } });
  t.after(opened.close);
  const url = new URL(opened.url);
  const headers = { Authorization: `Bearer ${url.hash.slice(1)}` };
  const get = async (suffix = "") => (await fetch(`${url.origin}/api/response${suffix}`, { headers })).json();
  assert.equal((await get()).cursor, "previous");
  branch.push({ id: "report", type: "custom_message", customType: teamReportType, display: true, content: "**Tests still needed.** <img src=x>" });
  branch.push({ id: "hidden", type: "custom_message", customType: "unrelated", display: true, content: "Do not show other custom messages." });
  branch.push({ id: "handoff", type: "custom_message", customType: teamHandoffType, display: false, details: { round: 2 }, content: "Private handoff notes" });
  const { messages, cursor } = await get("?after=previous");
  assert.deepEqual(messages.map(({ role }) => role), ["team-report", "team-handoff"]);
  assert.ok(messages.every(({ canBranch }) => canBranch === undefined));
  assert.doesNotMatch(JSON.stringify(messages), /Private handoff notes/);
  assert.deepEqual((await get(`?after=${cursor}`)).messages, []);

  const dom = new JSDOM(await readFile(new URL("../web/index.html", import.meta.url), "utf8"));
  t.after(() => dom.window.close());
  const transcript = mountTranscript(dom.window, { isViewingLive: () => true, isCommentOpen: () => false, setTooltip: () => {} });
  transcript.appendLive(messages);
  const report = dom.window.document.querySelector("#response .team-report-turn");
  assert.equal(report.querySelector("h2").textContent, "Software architect · Team report");
  assert.equal(report.querySelector("strong").textContent, "Tests still needed.");
  assert.equal(report.querySelector("img, [data-response-id], .reply-branch"), null);
  assert.ok(report.querySelector('[aria-label="Copy response"]'));
  const receipt = dom.window.document.querySelector("#response .team-handoff-turn");
  assert.equal(receipt.querySelector("h2").textContent, "Team handoff");
  assert.match(receipt.textContent, /Round 2 received/);
  assert.equal(receipt.querySelector("[data-response-id], .reply-branch"), null);
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
  const pointerErrors = [];
  dom.window.addEventListener("error", (event) => pointerErrors.push(event.error));
  d.getElementById("team-brief").dispatchEvent(new dom.window.Event("pointerdown", { bubbles: true }));
  assert.deepEqual(pointerErrors, []);
  assert.equal(poGear.getAttribute("aria-expanded"), "false");
  poGear.click();
  assert.match(poCard.querySelector(".team-agent-settings-status").textContent, /Sol · medium effort/);
  const modelInput = poCard.querySelector('[role="combobox"]');
  modelInput.value = "Luna";
  modelInput.dispatchEvent(new dom.window.Event("input"));
  poCard.querySelector('.team-agent-model-options [role="option"]').click();
  await turn();
  assert.deepEqual(posts, [{ action: "settings", role: "po", settings: { model: modelChoices[1].key, effort: "high" } }]);
  assert.deepEqual(settings.architect, { model: modelChoices[0].key, effort: "medium" }, "only the selected role is changed");
  const backendGear = d.querySelector('.team-card[data-role="backend"]').parentElement.querySelector(".team-agent-gear");
  backendGear.dispatchEvent(new dom.window.Event("pointerdown", { bubbles: true }));
  assert.equal(poGear.getAttribute("aria-expanded"), "true", "pointerdown must not reposition another gear before click");
  backendGear.click();
  assert.equal(poGear.getAttribute("aria-expanded"), "false");
  assert.equal(backendGear.getAttribute("aria-expanded"), "true");
  assert.equal(d.querySelectorAll(".team-agent-settings:not([hidden])").length, 1);
  d.activeElement.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  assert.equal(d.activeElement, backendGear);
  phase = "active";
  await ui.refresh(true);
  assert.equal(poGear.disabled, false);
  poGear.click();
  assert.equal(modelInput.readOnly, true);
  assert.equal(poCard.querySelector('[role="listbox"]').hidden, true);
  assert.match(poCard.querySelector(".team-agent-settings-status").textContent, /Luna.*locked/);
});

test("Teams recovers from a temporary request failure even if the revision did not change", async (t) => {
  const dom = new JSDOM(await readFile(new URL("../web/index.html", import.meta.url), "utf8"));
  t.after(() => dom.window.close());
  const d = dom.window.document;
  const model = { key: "openai/gpt-6.2-sol", label: "Sol", efforts: ["medium"] };
  const settings = { po: { model: model.key, effort: "medium" } };
  const snapshot = { phase: "idle", revision: 1, settings, modelChoices: [model], roles: [{ id: "po", name: "Product owner", status: "queued" }] };
  let fetches = 0;
  const ui = mountAgentTeam(dom.window, { onViewChange() {}, api: async (path) => {
    fetches++;
    if (fetches === 1) return snapshot;
    assert.match(path, /revision=1/);
    if (fetches === 2) throw new TypeError("Connection interrupted");
    if (fetches === 3) return { revision: 1 };
    throw Object.assign(new Error("Expired"), { status: 410 });
  } });
  await ui.refresh();
  d.getElementById("team-view-toggle").click();
  const gear = d.querySelector(".team-agent-gear");
  assert.equal(gear.disabled, false);
  await ui.refresh();
  assert.equal(gear.disabled, true);
  await ui.refresh();
  assert.equal(gear.disabled, false);
  await ui.refresh();
  await ui.refresh();
  assert.equal(fetches, 4, "an expired listener is not polled again");
  assert.equal(gear.disabled, true);
});

test("Main-chat-managed role transcripts and results route the user back to Main chat", async (t) => {
  const dom = new JSDOM(await readFile(new URL("../web/index.html", import.meta.url), "utf8"));
  t.after(() => dom.window.close());
  const d = dom.window.document;
  const $ = (id) => d.getElementById(id);
  let snapshot = { mainChatManaged: true, phase: "active", revision: 1, round: 1,
    roles: [{ id: "po", name: "Product owner", status: "paused", report: "Need a decision" }] };
  const ui = mountAgentTeam(dom.window, { onViewChange() {}, api: async (_path, body) => {
    assert.equal(body, undefined, "observing or leaving Teams must not submit instructions");
    return snapshot;
  } });
  await ui.refresh();
  $("team-view-toggle").click();
  d.querySelector('.team-card[data-role="po"]').click();
  assert.equal($("team-attention").textContent, "Blocked · see Main chat");
  assert.equal($("team-direction").hidden, true);
  assert.equal($("team-blocker-note").textContent, "Need a decision");
  d.querySelector('.team-card[data-role="lead"]').click();
  assert.equal($("team-panel").hidden, false);
  assert.equal($("team-conversation").hidden, true);
  snapshot = { ...snapshot, phase: "done", revision: 2, roles: [{ id: "po", name: "Product owner", status: "done" }],
    workspace: { cwd: "/tmp/team" }, result: { files: "", diff: "" } };
  await ui.refresh(true);
  assert.equal($("team-result").hidden, true);
  $("team-open-result").click();
  assert.equal($("team-result").hidden, false);
  assert.equal($("team-feedback").getAttribute("aria-label"), "Discuss the result in Main chat");
  $("team-feedback").click();
  assert.equal($("team-panel").hidden, false);
  assert.equal($("team-result").hidden, true);
  assert.equal($("team-setup").hidden, true);
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
  assert.equal(d.getElementById("team-blocker-note").textContent, "Need a decision");
  assert.equal(d.getElementById("team-blocker-note").hidden, false);
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
