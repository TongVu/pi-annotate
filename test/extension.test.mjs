import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerChatExtension } from "../src/index.ts";
import { AUTO_CHAT_SESSION, NEW_CHAT_TARGET } from "../src/resume-chat.ts";

function fixture(t, { dashboard = false, launchPage = async () => {}, ...dashboardOptions } = {}) {
  const handlers = new Map();
  const commands = new Map();
  const flags = new Map();
  const notices = [];
  registerChatExtension({
    on: (event, callback) => handlers.set(event, callback),
    registerCommand: (name, options) => commands.set(name, options),
    registerFlag: (name, options) => flags.set(name, options),
    getFlag: (name) => name === "dashboard" && dashboard,
    setSessionName: () => {},
    getSettings: () => ({}),
    sendUserMessage: () => {},
  }, launchPage, dashboardOptions);
  t.after(() => handlers.get("session_shutdown")());
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
    ui: { notify: (message) => notices.push(message) },
  };
  return { handlers, notices, ctx, commands, flags, run: (args = "link") => commands.get("chat").handler(args, ctx) };
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
      close: () => f.handlers.get("session_shutdown")(),
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

test("--dashboard does not launch a browser from non-interactive Pi", async (t) => {
  const f = fixture(t, { dashboard: true, launchPage: async () => assert.fail("unexpected browser launch") });
  f.ctx.mode = "print";
  await f.handlers.get("session_start")({ reason: "startup" }, f.ctx);
  assert.deepEqual(f.notices, []);
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
