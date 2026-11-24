import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { JSDOM } from "jsdom";
import { createChatPresence } from "../src/chat-presence.ts";
import { startDashboard } from "../src/dashboard.ts";
import { browserFocusArgs, dashboardFocusArgs } from "../src/focus-browser.ts";
import { startChatServer } from "../src/server.ts";
import { registerSessionOwner } from "../src/session-owner.ts";

const tooltipScript = await readFile(new URL("../web/tooltips.js", import.meta.url), "utf8");
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
  const bookmarkDir = join(dir, "bookmarks");
  const settings = { list: async () => [saved], presenceDir, ownerDir, bookmarkDir, ...options };
  const server = await startDashboard(settings);
  t.after(async () => { server.close(); await rm(dir, { recursive: true, force: true }); });
  const client = connect(server.url);
  const sessions = async () => (await (await client.request("/api/dashboard")).json()).sessions;
  const action = (id, intent) => client.request("/api/open", { id, intent });
  return { ...client, presenceDir, ownerDir, sessions, action, server, settings };
}

test("dashboard serves shared tooltips at the existing static asset URLs", async (t) => {
  const dashboard = await fixture(t);
  const page = await fetch(dashboard.url.origin);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.doesNotMatch(html, /\/tooltips\.(css|js)/);
  for (const [file, type, marker] of [["dashboard.js", "text/javascript", /function createTooltips/], ["dashboard.css", "text/css", /\.message-preview\s*\{/]]) {
    const asset = await fetch(`${dashboard.url.origin}/${file}`);
    assert.equal(asset.status, 200);
    assert.ok(asset.headers.get("content-type").startsWith(type));
    assert.match(await asset.text(), marker);
  }
});

test("dashboard still loads sessions when an existing Pi listener serves unbundled assets", async (t) => {
  const html = await readFile(new URL("../web/dashboard.html", import.meta.url), "utf8");
  const script = await readFile(new URL("../web/dashboard.js", import.meta.url), "utf8");
  const dom = new JSDOM(html, { url: "http://127.0.0.1:3456/#older-listener", runScripts: "outside-only" });
  t.after(() => dom.window.close());
  dom.window.fetch = async (path, { headers }) => {
    assert.equal(path, "/api/dashboard");
    assert.equal(headers.Authorization, "Bearer older-listener");
    return { ok: true, json: async () => ({ sessions: [{ ...saved, modified: +saved.modified, status: "saved", action: "resume" }] }) };
  };
  dom.window.eval(script); // The old server reads this file from disk without the tooltip prefix.
  const card = await waitFor(() => dom.window.document.querySelector(".card"));
  assert.equal(card.querySelector("h3").textContent, saved.name);
  assert.equal(card.querySelector("button").title, saved.name);
  assert.equal(card.querySelector(".bookmark"), null);
  assert.equal(dom.window.document.querySelector('[data-view="bookmarks"]').hidden, true);
  assert.equal(dom.window.document.getElementById("create-chat").disabled, false);
});

test("dashboard can focus only its own hosting terminal through an authenticated same-origin request", async (t) => {
  let focused = 0;
  const dashboard = await fixture(t, { focusTerminal: async () => { focused++; } });
  const path = "/api/focus-terminal";
  const origin = dashboard.url.origin;
  const state = await (await dashboard.request("/api/dashboard")).json();
  assert.equal(state.canFocusTerminal, true);
  assert.equal((await fetch(origin + path, { method: "POST", body: "{}" })).status, 401);
  assert.equal((await fetch(origin + path, { method: "POST", headers: {
    Authorization: `Bearer ${dashboard.token}`, Origin: "null", "Content-Type": "application/json",
  }, body: "{}" })).status, 403);
  assert.equal((await dashboard.request(path, { id: saved.id })).status, 400);
  assert.equal(focused, 0);
  const response = await dashboard.request(path, {});
  assert.equal(response.status, 200);
  assert.match((await response.json()).message, /terminal hosting this dashboard/);
  assert.equal(focused, 1);
});

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
  const owner = await registerSessionOwner(dashboard.ownerDir, { id: "unsaved", cwd: "/work/other" }, async () => {
    attachments++;
    return "attached";
  });
  t.after(owner.close);
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

test("dashboard clone cards show their parent without nesting or depending on the filter", async (t) => {
  const parent = { ...saved, name: "Original <em>work</em>" };
  const clone = { ...saved, id: "clone", path: "/private/transcripts/clone.jsonl", name: "Cloned chat", parentSessionPath: parent.path };
  const orphan = { ...saved, id: "orphan", path: "/private/transcripts/orphan.jsonl", name: "Orphaned clone", parentSessionPath: "/private/transcripts/missing.jsonl" };
  const dashboard = await fixture(t, { list: async () => [parent, clone, orphan] });
  const sessions = await dashboard.sessions();
  assert.equal(sessions.find(({ id }) => id === clone.id).parentId, parent.id);
  assert.ok(!JSON.stringify(sessions).includes("/private/transcripts/"));

  const asset = async (path) => (await fetch(dashboard.url.origin + path)).text();
  const dom = new JSDOM(await asset("/"), { url: dashboard.url.href, runScripts: "outside-only" });
  t.after(() => dom.window.close());
  dom.window.fetch = (path) => dashboard.request(path);
  dom.window.eval(await asset("/dashboard.js"));
  const { document, Event } = dom.window;
  assert.match(dom.window.location.search, /^\?dashboard=[a-f0-9]{32}$/);
  assert.equal(dom.window.location.hash, "", "the locator stays visible but the token does not");
  const lineage = await waitFor(() => document.querySelector(".clone-lineage"));
  assert.equal(lineage.previousElementSibling.textContent, clone.name);
  assert.equal(lineage.textContent, `⑂ Cloned from ${parent.name}`);
  assert.equal(lineage.querySelector("em"), null);
  assert.equal(document.querySelectorAll(".grid > .card").length, 3);
  assert.equal(document.querySelectorAll(".clone-lineage").length, 1, "unknown parents have no label");

  const filter = document.getElementById("session-filter");
  filter.value = clone.name;
  filter.dispatchEvent(new Event("input"));
  assert.deepEqual([...document.querySelectorAll(".card h3")].map(({ textContent }) => textContent), [clone.name]);
  assert.equal(document.querySelector(".clone-lineage").textContent, lineage.textContent);
});

test("dashboard bookmarks survive restarts and renames and can be removed", async (t) => {
  const dashboard = await fixture(t);
  const path = "/api/session/bookmark";
  const mark = { id: saved.id, bookmarked: true };
  assert.equal((await dashboard.sessions())[0].bookmarked, false);
  const headers = { Origin: dashboard.url.origin, "Content-Type": "application/json" };
  const post = (extra) => fetch(dashboard.url.origin + path, { method: "POST", headers: { ...headers, ...extra }, body: JSON.stringify(mark) });
  assert.equal((await post({})).status, 401);
  assert.equal((await post({ Authorization: `Bearer ${dashboard.token}`, Origin: "https://example.test" })).status, 403);
  assert.equal((await dashboard.request(path, { ...mark, bookmarked: "true" })).status, 400);
  assert.equal((await dashboard.request(path, { ...mark, id: "unknown" })).status, 404);
  assert.equal((await dashboard.request(path, mark)).status, 200);
  assert.equal((await dashboard.request(path, mark)).status, 200, "setting a bookmark twice does not toggle it off");
  dashboard.server.close();

  const reopened = await startDashboard({ ...dashboard.settings, list: async () => [{ ...saved, name: "Renamed work" }] });
  t.after(() => reopened.close());
  const client = connect(reopened.url);
  const sessions = async () => (await (await client.request("/api/dashboard")).json()).sessions;
  assert.deepEqual((await sessions()).map(({ name, bookmarked }) => [name, bookmarked]), [["Renamed work", true]]);
  assert.equal((await client.request(path, { ...mark, bookmarked: false })).status, 200);
  assert.equal((await sessions())[0].bookmarked, false);
});

test("dashboard bookmarks toggle without opening chats and filter the grouped view", async (t) => {
  const other = { ...saved, id: "slides", name: "Draft deck", cwd: "/work/slides" };
  const unmarked = { ...saved, id: "unmarked", name: "Unmarked work", cwd: other.cwd };
  const dashboard = await fixture(t, { list: async () => [saved, other, unmarked] });
  const asset = async (path) => (await fetch(dashboard.url.origin + path)).text();
  const dom = new JSDOM(await asset("/"), { url: dashboard.url.href, runScripts: "outside-only" });
  t.after(() => dom.window.close());
  const writes = [];
  dom.window.fetch = (path, options) => {
    assert.equal(options.headers.Authorization, `Bearer ${dashboard.token}`);
    const body = options.body ? JSON.parse(options.body) : undefined;
    if (body) writes.push([path, body]);
    return dashboard.request(path, body);
  };
  dom.window.eval(await asset("/dashboard.js"));
  const { document, Event, MouseEvent } = dom.window;
  const q = (selector) => document.querySelector(selector);
  const labels = (selector) => [...document.querySelectorAll(selector)].map((node) => node.textContent);
  const nav = q('[data-view="bookmarks"]');
  const button = (id) => q(`.bookmark[data-id="${id}"]`);
  const pressed = (id) => button(id)?.getAttribute("aria-pressed");
  const settled = (id, value) => pressed(id) === value && button(id).getAttribute("aria-disabled") === "false";
  const search = (query) => {
    q("#session-filter").value = query;
    q("#session-filter").dispatchEvent(new Event("input", { bubbles: true }));
  };
  await waitFor(() => button(saved.id));
  assert.equal(nav.hidden, false);
  nav.click();
  assert.match(q("#sessions").textContent, /No bookmarks yet/);
  q('[data-view="all"]').click();
  const all = labels(".card h3");
  assert.equal(pressed(saved.id), "false");
  button(saved.id).focus();
  button(saved.id).querySelector("path").dispatchEvent(new MouseEvent("click", { bubbles: true }));
  await waitFor(() => settled(saved.id, "true"));
  assert.equal(document.activeElement, button(saved.id));
  button(other.id).click();
  await waitFor(() => settled(other.id, "true"));
  assert.deepEqual(labels(".card h3"), all);

  nav.click();
  assert.equal(q("#heading").textContent, "Bookmarks");
  assert.deepEqual(labels(".section h2"), ["project", "slides"]);
  assert.deepEqual(labels(".card h3"), [saved.name, other.name]);
  assert.deepEqual(labels("#projects .session-link .truncate"), [saved.name, other.name]);
  search("deck");
  assert.deepEqual(labels(".card h3"), [other.name]);
  search("/work/project");
  assert.deepEqual(labels(".card h3"), [saved.name]);
  search("");
  button(saved.id).focus();
  button(saved.id).click();
  await waitFor(() => !button(saved.id));
  assert.equal(document.activeElement, nav);
  assert.deepEqual(labels(".card h3"), [other.name]);
  assert.deepEqual(writes, [["/api/session/bookmark", { id: saved.id, bookmarked: true }],
    ["/api/session/bookmark", { id: other.id, bookmarked: true }], ["/api/session/bookmark", { id: saved.id, bookmarked: false }]]);
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
  assert.deepEqual(await emptyDashboard.json(), { projects: [project], sessions: [], supportsBookmarks: true });
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

test("dashboard browser focus accepts only local dashboard locators", () => {
  const first = "http://127.0.0.1:12345/?dashboard=" + "a".repeat(32);
  const second = "http://127.0.0.1:12346/?dashboard=" + "b".repeat(32);
  const candidates = [first, `${first}#secret`, first.replace("dashboard", "tab"), first.replace("127.0.0.1", "example.test"), second];
  const chrome = dashboardFocusArgs(candidates, "Chrome/156.0 Safari/537.36");
  assert.deepEqual(chrome.slice(2), [first, second]);
  assert.match(chrome[1], /tabURL is locator or tabURL starts with \(locator & "#"\)/);
  assert.match(chrome[1], /set active tab index of w to i/);
  assert.match(dashboardFocusArgs(candidates, "Version/19 Safari/605.1.15")[1], /set current tab of w to t/);
  assert.equal(dashboardFocusArgs(candidates, "Firefox/140.0"), undefined);
});

test("dashboard filters projects and cards by name or directory within the selected view", async (t) => {
  const html = await readFile(new URL("../web/dashboard.html", import.meta.url), "utf8");
  const script = await readFile(new URL("../web/dashboard.js", import.meta.url), "utf8");
  const requests = [];
  const focus = Promise.withResolvers();
  const session = (id, name, cwd, status, action) => ({ id, name, cwd, status, action, modified: Date.now(), preview: "<img src=x>" });
  const entries = [session("a", "Hero copy", "/work/site", "working", "focus"), session("b", "Pricing review", "/work/site", "ready", "focus"),
    session("c", "Export failure", "/work/slides", "error", "focus"), session("d", "Draft deck", "/work/slides", "disconnected", "reopen")];
  const dom = new JSDOM(html, { url: "http://127.0.0.1:3456/#dashboard-test", runScripts: "outside-only" });
  t.after(() => dom.window.close());
  dom.window.fetch = async (path, init) => {
    assert.equal(init.headers.Authorization, "Bearer dashboard-test");
    if (path.startsWith("/api/dashboard")) return { ok: true, json: async () => ({ sessions: entries, canFocusTerminal: true }) };
    requests.push([path, JSON.parse(init.body)]);
    if (path === "/api/focus-terminal") {
      assert.equal(init.referrerPolicy, "same-origin");
      return focus.promise;
    }
    return { ok: true, json: async () => JSON.parse(init.body).id === "d"
      ? { command: "pi --session /tmp/slides.jsonl" }
      : { message: "Opening a tab from the running Pi session." } };
  };
  dom.window.eval(`${tooltipScript}\n${script}`);
  const q = (selector) => dom.window.document.querySelector(selector);
  const titles = () => [...dom.window.document.querySelectorAll(".card h3")].map((node) => node.textContent);
  const workingCount = () => q("#stats .dot.working").closest(".stat").querySelector("b").textContent;
  await waitFor(() => q(".card"));
  assert.equal(dom.window.location.hash, "");
  const scroll = q("#dashboard-scroll");
  assert.ok(scroll.contains(q(".card .dot.working")));
  for (const selector of ["#heading", "#summary", ".dashboard-tools", "#legend"]) {
    assert.equal(scroll.contains(q(selector)), false, `${selector} stays outside session scrolling`);
  }
  assert.ok(q(".side-scroll").contains(q("#projects")));
  assert.equal(q(".side-scroll").contains(q(".brand")), false);
  assert.ok(!q(".card img"), "saved message text stays inert");
  const tooltip = () => q('[role="tooltip"]');
  q("#refresh").focus();
  assert.equal(tooltip().className, "message-preview");
  assert.equal(tooltip().textContent, "Refresh chats");
  assert.equal(q("#refresh").getAttribute("aria-describedby"), tooltip().id);
  q('[data-project="/work/site"]').dispatchEvent(new dom.window.MouseEvent("mouseenter"));
  assert.equal(tooltip().textContent, "/work/site");
  q('.card [data-id="a"]').dispatchEvent(new dom.window.MouseEvent("mouseenter"));
  assert.equal(tooltip().textContent, "Hero copy");
  for (const selector of ["#stats .dot.disconnected", "#legend .dot.disconnected", ".card .dot.disconnected"]) {
    q(selector).closest(".pill").dispatchEvent(new dom.window.MouseEvent("mouseenter"));
    assert.equal(tooltip().textContent, "Running in Terminal · No chat tab connected");
  }
  const disconnectedCount = () => q("#stats .dot.disconnected").closest(".stat").querySelector("b").textContent;
  assert.equal(disconnectedCount(), "1");
  for (const selector of ['#projects [data-id="d"]', '.card [data-id="d"]']) {
    q(selector).dispatchEvent(new dom.window.MouseEvent("mouseenter"));
    assert.equal(tooltip().textContent, "Draft deck · Running in Terminal · No chat tab connected");
  }
  const time = q(".card time");
  time.dispatchEvent(new dom.window.MouseEvent("mouseenter"));
  assert.equal(tooltip().textContent, new Date(time.dateTime).toLocaleString());
  time.dispatchEvent(new dom.window.MouseEvent("mouseleave"));
  assert.equal(tooltip(), null);
  assert.equal(dom.window.document.querySelectorAll("[title]").length, 0);
  q("#refresh").blur();
  entries[3].terminalWorking = true;
  q("#refresh").click();
  await waitFor(() => q("#projects .dot.disconnected.terminal-working"));
  q(".card .dot.disconnected.terminal-working").closest(".pill").dispatchEvent(new dom.window.MouseEvent("mouseenter"));
  assert.equal(tooltip().textContent, "Working in Terminal · No chat tab connected");
  q('#projects [data-id="d"]').focus();
  assert.equal(tooltip().textContent, "Draft deck · Working in Terminal · No chat tab connected");
  assert.equal(disconnectedCount(), "1");
  assert.equal(workingCount(), "1", "a disconnected working session isn't counted as connected working");
  delete entries[3].terminalWorking;
  q("#refresh").click();
  await waitFor(() => !q(".dot.disconnected.terminal-working"));
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
  const refresh = q("#refresh");
  assert.equal(refresh.getAttribute("aria-label"), "Refresh chats");
  assert.ok(refresh.querySelector('svg[aria-hidden="true"] path'));
  refresh.click();
  await waitFor(() => q("#message").textContent === "Dashboard refreshed.");
  assert.deepEqual(titles(), ["Export failure", "Draft deck"], "refresh preserves the filter");
  scroll.scrollTop = 100;
  q('[data-view="attention"]').click();
  assert.equal(scroll.scrollTop, 0, "switching views resets the session scroller");
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
  const openPricing = () => q('.card button[data-id="b"]');
  openPricing().click();
  await waitFor(() => openPricing().getAttribute("aria-disabled") === "false");
  assert.equal(q("#notice").hidden, true, "successful opens do not show a notice");
  q('[data-project="/work/slides"]').click();
  filter("pricing");
  assert.deepEqual(titles(), []);
  assert.match(q("#sessions").textContent, /No sessions match/);
  assert.equal(q("#heading").textContent, "slides", "a filter does not reset the selected project");
  filter("");
  assert.deepEqual(titles(), ["Export failure", "Draft deck"]);
  q('.card button[data-id="d"]').click();
  await waitFor(() => !q("#notice").hidden);
  assert.equal(q("#manual").hidden, false, "manual instructions still need a visible notice");
  assert.equal(q("#command").value, "pi --session /tmp/slides.jsonl");
  assert.deepEqual(requests, [["/api/open", { id: "b", intent: "focus" }], ["/api/open", { id: "d", intent: "open" }]]);
  const terminal = q("#focus-terminal");
  assert.equal(terminal.hidden, false);
  assert.equal(terminal.dataset.tooltip, "Switch to Terminal");
  terminal.click();
  assert.equal(terminal.disabled, true);
  terminal.click();
  assert.deepEqual(requests.slice(2), [["/api/focus-terminal", {}]], "a project selection cannot redirect terminal focus");
  focus.resolve({ ok: false, json: async () => ({ error: "Check macOS Automation permissions." }) });
  await waitFor(() => !terminal.disabled);
  assert.equal(q("#message").textContent, "Check macOS Automation permissions.");
});

test("Create new chat completes known projects by name or path and submits only the confirmed choice", async (t) => {
  const html = await readFile(new URL("../web/dashboard.html", import.meta.url), "utf8");
  const script = await readFile(new URL("../web/dashboard.js", import.meta.url), "utf8");
  const dom = new JSDOM(html, { url: "http://127.0.0.1:3456/#dashboard-test", runScripts: "outside-only" });
  t.after(() => dom.window.close());
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
  dom.window.eval(`${tooltipScript}\n${script}`);
  const q = (selector) => dom.window.document.querySelector(selector);
  const button = q("#create-chat");
  await waitFor(() => !button.disabled);
  assert.equal(button.closest(".dashboard-tools")?.className, "dashboard-tools");
  assert.equal(button.getAttribute("aria-label"), "Create new chat");
  assert.equal(button.querySelector('[aria-hidden="true"]').textContent, "📝");
  const filter = q("#session-filter");
  filter.value = "one";
  filter.dispatchEvent(new dom.window.Event("input"));
  const dialog = q("#new-chat-dialog");
  const field = q("#new-chat-project");
  button.click();
  assert.equal(dialog.open, true);
  assert.equal(field.value, "", "a project must be chosen from All sessions");
  assert.equal(dom.window.document.activeElement, field);
  assert.equal(field.getAttribute("aria-expanded"), "true");
  const options = () => [...q("#new-chat-projects").children];
  assert.deepEqual(options().map(({ dataset }) => dataset.cwd), ["/work/empty", "/work/one", "/work/two"]);
  assert.equal(options()[0].querySelector("strong").textContent, "empty");
  const type = (value) => {
    field.value = value;
    field.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  };
  const key = (key) => field.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  const submit = () => q("#new-chat-form").dispatchEvent(new dom.window.Event("submit", { cancelable: true }));
  type("  EMP ");
  assert.deepEqual(options().map(({ dataset }) => dataset.cwd), ["/work/empty"]);
  options()[0].querySelector("strong").click();
  assert.equal(field.value, "/work/empty", "mouse selection fills the known directory");
  assert.equal(q("#submit-new-chat").disabled, false);
  assert.equal(field.getAttribute("aria-expanded"), "false");
  q("#cancel-new-chat").click();
  assert.equal(dialog.open, false);
  assert.deepEqual(requests, []);
  q('[data-project="/work/one"]').click();
  button.click();
  assert.equal(field.value, "/work/one", "the project view preselects its project");
  type("/work/unknown");
  assert.equal(q("#new-chat-no-projects").hidden, false);
  assert.equal(q("#submit-new-chat").disabled, true);
  submit();
  assert.deepEqual(requests, [], "edited or unlisted paths are not submitted");
  type("/WORK/TW");
  assert.deepEqual(options().map(({ dataset }) => dataset.cwd), ["/work/two"]);
  assert.equal(key("ArrowDown"), false);
  assert.equal(field.getAttribute("aria-activedescendant"), options()[0].id);
  assert.equal(options()[0].getAttribute("aria-selected"), "true");
  assert.equal(key("Escape"), false);
  assert.equal(dialog.open, true, "Escape closes suggestions before the dialog");
  assert.equal(field.getAttribute("aria-expanded"), "false");
  assert.equal(field.hasAttribute("aria-activedescendant"), false);
  key("ArrowUp");
  assert.equal(key("Enter"), false);
  assert.equal(field.value, "/work/two");
  assert.deepEqual(requests, [], "accepting a completion does not start a chat");
  submit();
  submit();
  assert.deepEqual(requests, [{ cwd: "/work/two" }]);
  assert.equal(q("#submit-new-chat").disabled, true);
  created.resolve({ ok: true, json: async () => ({ message: "Opening new chat" }) });
  await waitFor(() => !dialog.open);
  assert.equal(q("#message").textContent, "Opening new chat");
  assert.equal(q("#heading").textContent, "one", "creating a chat does not leave the current dashboard view");
});
