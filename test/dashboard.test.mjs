import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { JSDOM } from "jsdom";
import { createChatPresence } from "../src/chat-presence.ts";
import { startDashboard } from "../src/dashboard.ts";
import { browserFocusArgs } from "../src/focus-browser.ts";
import { startChatServer } from "../src/server.ts";
import { registerSessionOwner } from "../src/session-owner.ts";

const saved = { id: "saved", cwd: "/work/project", path: "/private/transcripts/saved.jsonl", name: "Saved work", modified: new Date(), firstMessage: "Earlier conversation" };
const connect = (value) => {
  const url = new URL(value);
  const token = url.hash.slice(1);
  const headers = { Authorization: `Bearer ${token}`, Origin: url.origin, "Content-Type": "application/json" };
  return { url, token, request: (path, body) => fetch(url.origin + path, body ? { method: "POST", headers, body: JSON.stringify(body) } : { headers }) };
};
async function waitFor(callback) {
  for (let attempt = 0; attempt < 120; attempt++) {
    const value = await callback();
    if (value) return value;
    await delay(25);
  }
  assert.fail("Timed out waiting for dashboard state");
}

async function fixture(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), "pi-dashboard-"));
  const presenceDir = join(dir, "live");
  const ownerDir = join(dir, "owners");
  const server = await startDashboard({ list: async () => [saved], presenceDir, ownerDir, ...options });
  t.after(async () => { server.close(); await rm(dir, { recursive: true, force: true }); });
  const client = connect(server.url);
  const sessions = async () => (await (await client.request("/api/dashboard")).json()).sessions;
  const action = (id, intent) => client.request("/api/open", { id, intent });
  return { ...client, presenceDir, ownerDir, sessions, action };
}

test("dashboard shows live Pi status without chat-tab polling and focuses the exact connected tab", async (t) => {
  let idle = true;
  let branch = [];
  let attempts = 0;
  let focused;
  const dashboard = await fixture(t, {
    canFocus: () => true,
    focus: async (tab) => { focused = tab; return ++attempts === 1; },
    resume: async () => assert.fail("a connected chat must not be launched"),
  });
  const chat = await startChatServer({ chat: {
    getBranch: () => branch, isIdle: () => idle,
    presence: createChatPresence(() => dashboard.presenceDir, () => ({ id: saved.id, cwd: saved.cwd, name: "Live name" })),
  } });
  t.after(chat.close);
  const tab = connect(chat.url);
  assert.equal((await dashboard.sessions())[0].status, "saved", "an unused chat link is not connected");
  assert.equal((await fetch(tab.url)).status, 200);
  assert.equal((await tab.request("/api/response")).status, 200);
  const [ready] = await dashboard.sessions();
  assert.equal(ready.status, "ready");
  assert.equal(ready.action, "focus");
  assert.equal(ready.name, "Live name");
  assert.doesNotMatch(JSON.stringify(ready), /private|127\.0\.0\.1|\?tab=/);
  assert.equal((await dashboard.action(saved.id, "focus")).status, 200);
  assert.equal(focused, tab.url.origin + "/" + tab.url.search);
  assert.ok(!focused.includes(tab.token));
  assert.match(await (await dashboard.action(saved.id, "focus")).text(), /no duplicate/);
  assert.equal((await dashboard.action(saved.id, "open")).status, 409, "stale reopen cannot act on a now-connected chat");
  idle = false;
  await waitFor(async () => (await dashboard.sessions())[0].status === "working");
  branch = [{ type: "message", message: { role: "assistant", stopReason: "error" } }];
  idle = true;
  await waitFor(async () => (await dashboard.sessions())[0].status === "error");
  assert.equal((await tab.request("/api/close", {})).status, 200);
  await waitFor(async () => (await dashboard.sessions())[0].status === "saved");
  assert.equal((await dashboard.action(saved.id, "focus")).status, 409, "stale focus must not resume a now-disconnected chat");
});

test("dashboard reconnects a disconnected Pi owner before considering a saved-session launch", { skip: process.platform === "win32" }, async (t) => {
  let attachments = 0;
  let launches = 0;
  const dashboard = await fixture(t, { resume: async (session) => { assert.deepEqual(session, saved); launches++; } });
  const closeOwner = await registerSessionOwner(dashboard.ownerDir, { id: "unsaved", cwd: "/work/other" }, async () => {
    attachments++;
    return "attached";
  });
  t.after(closeOwner);
  assert.deepEqual((await dashboard.sessions()).map(({ id, status }) => [id, status]), [["saved", "saved"], ["unsaved", "disconnected"]]);
  assert.equal((await dashboard.action("unsaved", "open")).status, 202);
  assert.equal(attachments, 1);
  assert.equal(launches, 0);
  assert.equal((await dashboard.action("unknown", "open")).status, 404);
  assert.equal((await dashboard.action("saved", "open")).status, 202);
  assert.equal((await dashboard.action("saved", "open")).status, 409);
  assert.equal(launches, 1);
});

test("dashboard protects session metadata and actions with a separate loopback capability", async (t) => {
  const dashboard = await fixture(t);
  const { url, token } = dashboard;
  const page = await fetch(url);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  assert.match(await page.text(), /Chat Dashboard/);
  assert.equal((await fetch(`${url.origin}/logo.png`)).headers.get("content-type"), "image/png");
  assert.equal((await fetch(`${url.origin}/api/dashboard`)).status, 401);
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const open = (origin, body) => fetch(`${url.origin}/api/open`, { method: "POST", headers: { ...headers, ...(origin ? { Origin: origin } : {}) }, body: JSON.stringify(body) });
  const request = { id: "saved", intent: "open" };
  assert.equal((await open(undefined, request)).status, 403);
  assert.equal((await open("https://example.test", request)).status, 403);
  assert.equal((await open(url.origin, { ...request, path: "/arbitrary" })).status, 400);
  const manual = await dashboard.action(saved.id, "open");
  assert.equal(manual.status, 200);
  assert.deepEqual(await manual.json(), { command: "cd -- '/work/project' && pi --session '/private/transcripts/saved.jsonl'" });
  assert.equal((await dashboard.request("/api/response")).status, 404, "dashboard token does not expose a transcript route");
});

test("dashboard creates a fresh chat only in a listed project and stays available", async (t) => {
  const cwd = join(tmpdir(), "a project's source");
  const project = join(tmpdir(), "dashboard launch project");
  const listed = [{ ...saved, id: "other-project", cwd }];
  const started = Promise.withResolvers();
  const finish = Promise.withResolvers();
  const calls = [];
  const dashboard = await fixture(t, {
    list: async () => listed,
    project,
    resume: async () => assert.fail("new chat must not resume a saved session"),
    createChat: async (project) => { calls.push(project); started.resolve(); await finish.promise; },
  });
  t.after(() => finish.resolve());
  const create = (body) => dashboard.request("/api/session/new", body);
  assert.equal((await fetch(`${dashboard.url.origin}/api/session/new`, { method: "POST" })).status, 401);
  assert.equal((await create({ cwd: "relative" })).status, 400);
  assert.equal((await create({ cwd, text: "launch this prompt" })).status, 400);
  assert.equal((await create({ cwd: join(tmpdir(), "unlisted") })).status, 404);
  assert.deepEqual(calls, []);
  const response = create({ cwd });
  await started.promise;
  assert.equal((await create({ cwd })).status, 409);
  finish.resolve();
  assert.equal((await response).status, 202);
  assert.deepEqual(calls, [cwd]);
  assert.deepEqual((await dashboard.sessions()).map(({ id }) => id), ["other-project"]);
  listed.length = 0;
  assert.equal((await create({ cwd })).status, 404, "recheck the project catalog before launching");
  const emptyDashboard = await dashboard.request("/api/dashboard");
  assert.deepEqual(await emptyDashboard.json(), { projects: [project], sessions: [] });
  assert.equal((await create({ cwd: project })).status, 202, "the launch directory is eligible even without prior chats");
  assert.deepEqual(calls, [cwd, project]);
});

test("dashboard offers a manual start command when Terminal automation is unavailable", async (t) => {
  const dashboard = await fixture(t);
  const response = await dashboard.request("/api/session/new", { cwd: saved.cwd });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { command: process.platform === "win32"
    ? "Set-Location -LiteralPath '/work/project' -ErrorAction Stop; if ($?) { pi }"
    : "cd -- '/work/project' && pi" });
});

test("browser focus is scoped to an exact local tab locator and never asks the browser to navigate", () => {
  const tab = "http://127.0.0.1:12345/?tab=" + "a".repeat(32);
  const chrome = browserFocusArgs(tab, "Chrome/156.0 Safari/537.36");
  const safari = browserFocusArgs(tab, "Version/19 Safari/605.1.15");
  assert.equal(chrome.at(-1), tab);
  assert.match(chrome[1], /if URL of t is targetURL then\s+set active tab index of w to i/);
  assert.match(safari[1], /if URL of t is targetURL then\s+set current tab of w to t/);
  assert.equal(browserFocusArgs(tab, "Firefox/140.0"), undefined);
  assert.equal(browserFocusArgs(`${tab}#secret`, "Chrome/156.0"), undefined);
  assert.equal(browserFocusArgs(tab.replace("127.0.0.1", "example.test"), "Chrome/156.0"), undefined);
});

test("dashboard filters projects and cards by name or directory within the selected view", async (t) => {
  const html = await readFile(new URL("../web/dashboard.html", import.meta.url), "utf8");
  const script = await readFile(new URL("../web/dashboard.js", import.meta.url), "utf8");
  const requests = [];
  const session = (id, name, cwd, status, action) => ({ id, name, cwd, status, action, modified: Date.now(), preview: "<img src=x>" });
  const entries = [session("a", "Hero copy", "/work/site", "working", "focus"), session("b", "Pricing review", "/work/site", "ready", "focus"),
    session("c", "Export failure", "/work/slides", "error", "focus"), session("d", "Draft deck", "/work/slides", "disconnected", "reopen")];
  const dom = new JSDOM(html, { url: "http://127.0.0.1:3456/#dashboard-test", runScripts: "outside-only" });
  t.after(() => dom.window.close());
  dom.window.scrollTo = () => {};
  dom.window.fetch = async (path, init) => {
    assert.equal(init.headers.Authorization, "Bearer dashboard-test");
    if (path.startsWith("/api/dashboard")) return { ok: true, json: async () => ({ sessions: entries }) };
    requests.push([path, JSON.parse(init.body)]);
    return { ok: true, json: async () => ({ message: "Action taken" }) };
  };
  dom.window.eval(script);
  const q = (selector) => dom.window.document.querySelector(selector);
  const titles = () => [...dom.window.document.querySelectorAll(".card h3")].map((node) => node.textContent);
  const workingCount = () => q("#stats .dot.working").closest(".stat").querySelector("b").textContent;
  await waitFor(() => q(".card"));
  assert.equal(dom.window.location.hash, "");
  assert.ok(q(".card .dot.working"));
  assert.ok(!q(".card img"), "saved message text stays inert");
  const filter = (value) => {
    const field = q("#session-filter");
    field.value = value;
    field.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  };
  filter("  pRICing ");
  assert.deepEqual(titles(), ["Pricing review"]);
  assert.equal(dom.window.document.querySelectorAll("#projects .session-link").length, 1);
  filter("/WORK/SLIDES");
  assert.deepEqual(titles(), ["Export failure", "Draft deck"]);
  assert.equal(q('#projects [data-project="/work/site"]'), null);
  q("#refresh").click();
  await waitFor(() => q("#message").textContent === "Dashboard refreshed.");
  assert.deepEqual(titles(), ["Export failure", "Draft deck"], "refresh preserves the filter");
  q('[data-view="attention"]').click();
  assert.deepEqual(titles(), ["Export failure"]);
  assert.equal(workingCount(), "0", "the status overview still respects the directory filter");
  filter("");
  assert.deepEqual(titles(), ["Pricing review", "Export failure"]);
  assert.equal(workingCount(), "1", "Needs attention hides working cards but still counts them");
  assert.equal(q("#summary").textContent, "2 of 4 sessions need attention");
  entries[0].status = "ready";
  q("#refresh").click();
  await waitFor(() => workingCount() === "0");
  assert.ok(titles().includes("Hero copy"));
  entries[0].status = "working";
  q("#refresh").click();
  await waitFor(() => workingCount() === "1");
  assert.deepEqual(titles(), ["Pricing review", "Export failure"]);
  q('.card button[data-id="b"]').click();
  await waitFor(() => q("#message").textContent === "Action taken");
  q('[data-project="/work/slides"]').click();
  filter("pricing");
  assert.deepEqual(titles(), []);
  assert.match(q("#sessions").textContent, /No sessions match/);
  assert.equal(q("#heading").textContent, "slides", "a filter does not reset the selected project");
  filter("");
  assert.deepEqual(titles(), ["Export failure", "Draft deck"]);
  q('.card button[data-id="d"]').click();
  await waitFor(() => requests.length === 2);
  assert.deepEqual(requests, [["/api/open", { id: "b", intent: "focus" }], ["/api/open", { id: "d", intent: "open" }]]);
});

test("Create new chat offers all known projects and submits only the chosen directory", async (t) => {
  const html = await readFile(new URL("../web/dashboard.html", import.meta.url), "utf8");
  const script = await readFile(new URL("../web/dashboard.js", import.meta.url), "utf8");
  const dom = new JSDOM(html, { url: "http://127.0.0.1:3456/#dashboard-test", runScripts: "outside-only" });
  t.after(() => dom.window.close());
  dom.window.scrollTo = () => {};
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  const projects = ["/work/one", "/work/two", "/work/empty"];
  const sessions = ["/work/one", "/work/two", "/work/two", ""].map((cwd, id) => ({
    id: String(id), cwd, name: `Chat ${id}`, status: "saved", action: "resume", modified: null,
  }));
  const created = Promise.withResolvers();
  const requests = [];
  dom.window.fetch = async (path, init) => {
    if (path === "/api/dashboard") return { ok: true, json: async () => ({ projects, sessions }) };
    assert.equal(path, "/api/session/new");
    requests.push(JSON.parse(init.body));
    return created.promise;
  };
  dom.window.eval(script);
  const q = (selector) => dom.window.document.querySelector(selector);
  const button = q("#create-chat");
  await waitFor(() => !button.disabled);
  assert.equal(button.closest(".dashboard-tools")?.className, "dashboard-tools");
  const filter = q("#session-filter");
  filter.value = "one";
  filter.dispatchEvent(new dom.window.Event("input"));
  const dialog = q("#new-chat-dialog");
  const field = q("#new-chat-project");
  button.click();
  assert.equal(dialog.open, true);
  assert.equal(field.value, "", "a project must be chosen from All sessions");
  assert.deepEqual([...field.options].map(({ value }) => value), ["", "/work/empty", "/work/one", "/work/two"]);
  q("#cancel-new-chat").click();
  assert.equal(dialog.open, false);
  assert.deepEqual(requests, []);
  q('[data-project="/work/one"]').click();
  button.click();
  assert.equal(field.value, "/work/one", "the project view preselects its project");
  field.value = "/work/two";
  const submit = () => q("#new-chat-form").dispatchEvent(new dom.window.Event("submit", { cancelable: true }));
  submit();
  submit();
  assert.deepEqual(requests, [{ cwd: "/work/two" }]);
  assert.equal(q("#submit-new-chat").disabled, true);
  created.resolve({ ok: true, json: async () => ({ message: "Opening new chat" }) });
  await waitFor(() => !dialog.open);
  assert.equal(q("#message").textContent, "Opening new chat");
  assert.equal(q("#heading").textContent, "one", "creating a chat does not leave the current dashboard view");
});
