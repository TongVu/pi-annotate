import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { registerChatExtension } from "../src/index.ts";
import { AUTO_CHAT_SESSION, NEW_CHAT_TARGET } from "../src/resume-chat.ts";

function fixture(t, { dashboard = false, launchPage = async () => {}, sendUserMessage = () => {}, ...dashboardOptions } = {}) {
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
    sendUserMessage,
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

test("a Linux dashboard launches a fresh Pi in its Kitty window", { skip: process.platform !== "linux" }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-chat-create-kitty-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "new project's workspace");
  await mkdir(cwd);
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
